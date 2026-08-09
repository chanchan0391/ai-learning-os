import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { hashSessionToken } from "./postgres-session-resolver";

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const AUTH_METADATA_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const AUTH_METADATA_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface VerifiedOidcIdentity {
  issuer: string;
  subject: string;
  deviceLabel: string;
}

export interface IssuedSession {
  token: string;
  userId: string;
  deviceId: string;
  expiresAt: string;
}

export interface ActiveDevice {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface SessionLifecycle {
  establishFromOidc(identity: VerifiedOidcIdentity): Promise<IssuedSession>;
  rotate(token: string): Promise<IssuedSession | null>;
  revoke(token: string): Promise<boolean>;
  revokeAll(token: string): Promise<boolean>;
  listActiveDevices(token: string): Promise<ActiveDevice[] | null>;
  revokeDevice(token: string, deviceId: string): Promise<boolean>;
}

export interface AccountDataLifecycle {
  deleteAccount(token: string): Promise<boolean>;
}

interface SessionRow extends QueryResultRow {
  user_id: string;
  device_id: string;
}

interface DeviceRow extends QueryResultRow {
  id: string;
  label: string;
  created_at: Date | string;
  last_seen_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertIdentity(identity: VerifiedOidcIdentity): void {
  const issuer = new URL(identity.issuer);
  if (issuer.origin + issuer.pathname.replace(/\/$/, "") !== identity.issuer.replace(/\/$/, "")) {
    throw new TypeError("OIDC issuer must be an absolute URL without query or fragment");
  }
  if (!identity.subject.trim() || identity.subject.length > 255) throw new TypeError("OIDC subject is invalid");
  if (!identity.deviceLabel.trim() || identity.deviceLabel.length > 100) throw new TypeError("Device label is invalid");
}

export class PostgresSessionLifecycle implements SessionLifecycle, AccountDataLifecycle {
  private nextMetadataCleanupAt = 0;

  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
    private readonly tokenFactory: () => string = () => randomBytes(32).toString("base64url"),
    private readonly idFactory: () => string = () => randomUUID(),
    private readonly ttlMs = DEFAULT_SESSION_TTL_MS,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("Session TTL must be positive");
  }

  async establishFromOidc(identity: VerifiedOidcIdentity): Promise<IssuedSession> {
    assertIdentity(identity);
    await this.maybeCleanupExpiredMetadata(this.now());
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ user_id: string }>(
        "SELECT user_id FROM oidc_identities WHERE issuer = $1 AND subject = $2",
        [identity.issuer.replace(/\/$/, ""), identity.subject],
      );
      const userId = existing.rows[0]?.user_id ?? this.idFactory();
      if (existing.rowCount === 0) {
        await client.query("INSERT INTO users (id) VALUES ($1)", [userId]);
        await client.query(
          "INSERT INTO oidc_identities (issuer, subject, user_id) VALUES ($1, $2, $3)",
          [identity.issuer.replace(/\/$/, ""), identity.subject, userId],
        );
      }
      await this.cleanupAbandonedDevices(client, userId, this.now());
      const deviceId = this.idFactory();
      await client.query(
        "INSERT INTO sync_devices (user_id, id, label) VALUES ($1, $2, $3)",
        [userId, deviceId, identity.deviceLabel.trim()],
      );
      const session = await this.insertSession(client, userId, deviceId);
      await client.query("COMMIT");
      return session;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async rotate(token: string): Promise<IssuedSession | null> {
    await this.maybeCleanupExpiredMetadata(this.now());
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<SessionRow>(
        `SELECT s.user_id, s.device_id
           FROM auth_sessions s
           JOIN users u ON u.id = s.user_id
           JOIN sync_devices d ON d.user_id = s.user_id AND d.id = s.device_id
          WHERE s.token_hash = $1 AND s.expires_at > $2 AND s.revoked_at IS NULL
            AND u.deleted_at IS NULL AND d.revoked_at IS NULL
          FOR UPDATE`,
        [hashSessionToken(token), this.now().toISOString()],
      );
      if (current.rowCount !== 1) {
        await client.query("ROLLBACK");
        return null;
      }
      await this.cleanupAbandonedDevices(client, current.rows[0].user_id, this.now());
      await client.query("UPDATE auth_sessions SET revoked_at = $2 WHERE token_hash = $1", [hashSessionToken(token), this.now().toISOString()]);
      const session = await this.insertSession(client, current.rows[0].user_id, current.rows[0].device_id);
      await client.query("UPDATE sync_devices SET last_seen_at = $3 WHERE user_id = $1 AND id = $2", [session.userId, session.deviceId, this.now().toISOString()]);
      await client.query("COMMIT");
      return session;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revoke(token: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE auth_sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL",
      [hashSessionToken(token), this.now().toISOString()],
    );
    return result.rowCount === 1;
  }

  async revokeAll(token: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ user_id: string }>(
        `SELECT s.user_id
           FROM auth_sessions s
           JOIN users u ON u.id = s.user_id
           JOIN sync_devices d ON d.user_id = s.user_id AND d.id = s.device_id
          WHERE s.token_hash = $1 AND s.expires_at > $2 AND s.revoked_at IS NULL
            AND u.deleted_at IS NULL AND d.revoked_at IS NULL
          FOR UPDATE`,
        [hashSessionToken(token), this.now().toISOString()],
      );
      if (current.rowCount !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
      const userId = current.rows[0].user_id;
      const revokedAt = this.now().toISOString();
      await client.query(
        "UPDATE auth_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL",
        [userId, revokedAt],
      );
      await client.query(
        "UPDATE sync_devices SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL",
        [userId, revokedAt],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listActiveDevices(token: string): Promise<ActiveDevice[] | null> {
    const current = await this.pool.query<SessionRow>(
      `SELECT s.user_id, s.device_id
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
         JOIN sync_devices d ON d.user_id = s.user_id AND d.id = s.device_id
        WHERE s.token_hash = $1 AND s.expires_at > $2 AND s.revoked_at IS NULL
          AND u.deleted_at IS NULL AND d.revoked_at IS NULL`,
      [hashSessionToken(token), this.now().toISOString()],
    );
    if (current.rowCount !== 1) return null;
    const devices = await this.pool.query<DeviceRow>(
      `SELECT DISTINCT d.id, d.label, d.created_at, d.last_seen_at
         FROM sync_devices d
         JOIN auth_sessions active
           ON active.user_id = d.user_id AND active.device_id = d.id
          AND active.expires_at > $2 AND active.revoked_at IS NULL
        WHERE d.user_id = $1 AND d.revoked_at IS NULL
        ORDER BY d.last_seen_at DESC, d.created_at DESC`,
      [current.rows[0].user_id, this.now().toISOString()],
    );
    return devices.rows.map((device) => ({
      id: device.id,
      label: device.label,
      createdAt: iso(device.created_at),
      lastSeenAt: iso(device.last_seen_at),
      current: device.id === current.rows[0].device_id,
    }));
  }

  async revokeDevice(token: string, deviceId: string): Promise<boolean> {
    if (!deviceId.trim() || deviceId.length > 200) return false;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ user_id: string }>(
        `SELECT s.user_id
           FROM auth_sessions s
           JOIN users u ON u.id = s.user_id
           JOIN sync_devices d ON d.user_id = s.user_id AND d.id = s.device_id
          WHERE s.token_hash = $1 AND s.expires_at > $2 AND s.revoked_at IS NULL
            AND u.deleted_at IS NULL AND d.revoked_at IS NULL
          FOR UPDATE`,
        [hashSessionToken(token), this.now().toISOString()],
      );
      if (current.rowCount !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
      const revokedAt = this.now().toISOString();
      const device = await client.query(
        "UPDATE sync_devices SET revoked_at = $3 WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL",
        [current.rows[0].user_id, deviceId, revokedAt],
      );
      if (device.rowCount !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        "UPDATE auth_sessions SET revoked_at = $3 WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL",
        [current.rows[0].user_id, deviceId, revokedAt],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteAccount(token: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ user_id: string }>(
        `SELECT s.user_id
           FROM auth_sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > $2 AND s.revoked_at IS NULL
            AND u.deleted_at IS NULL
          FOR UPDATE`,
        [hashSessionToken(token), this.now().toISOString()],
      );
      if (current.rowCount !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query("DELETE FROM users WHERE id = $1", [current.rows[0].user_id]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertSession(client: PoolClient, userId: string, deviceId: string): Promise<IssuedSession> {
    const token = this.tokenFactory();
    const expiresAt = new Date(this.now().getTime() + this.ttlMs).toISOString();
    await client.query(
      "INSERT INTO auth_sessions (token_hash, user_id, device_id, expires_at) VALUES ($1, $2, $3, $4)",
      [hashSessionToken(token), userId, deviceId, expiresAt],
    );
    return { token, userId, deviceId, expiresAt };
  }

  private async cleanupAbandonedDevices(client: PoolClient, userId: string, now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - AUTH_METADATA_RETENTION_MS);
    await client.query(
      `DELETE FROM sync_devices
        WHERE user_id = $1 AND last_seen_at < $2
          AND id NOT IN (SELECT device_id FROM auth_sessions WHERE user_id = $1)`,
      [userId, cutoff],
    );
  }

  /** Opportunistically bounds expired session metadata without blocking authentication on maintenance failure. */
  private async maybeCleanupExpiredMetadata(now: Date): Promise<void> {
    if (now.getTime() < this.nextMetadataCleanupAt) return;
    this.nextMetadataCleanupAt = now.getTime() + AUTH_METADATA_CLEANUP_INTERVAL_MS;
    const cutoff = new Date(now.getTime() - AUTH_METADATA_RETENTION_MS);
    try {
      await this.pool.query("DELETE FROM auth_sessions WHERE expires_at < $1", [cutoff]);
    } catch (error) {
      this.nextMetadataCleanupAt = 0;
      console.error("Authentication metadata cleanup failed", error instanceof Error ? error.name : "UnknownError");
    }
  }
}
