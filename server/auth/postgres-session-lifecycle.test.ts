import { readFile } from "node:fs/promises";
import { DataType, newDb } from "pg-mem";
import { afterEach, describe, expect, it } from "vitest";
import { hashSessionToken } from "./postgres-session-resolver";
import { AUTH_METADATA_RETENTION_MS, PostgresSessionLifecycle } from "./postgres-session-lifecycle";

const pools: Array<{ end(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

async function setup() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  memory.public.registerFunction({
    name: "length",
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value: string) => value.length,
  });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  pools.push(pool);
  for (const migration of ["001-initial-sync-schema.sql", "002-auth-sessions.sql", "003-oidc-identities.sql"]) {
    await pool.query(await readFile(new URL(`../sync/migrations/${migration}`, import.meta.url), "utf8"));
  }
  const tokens = ["first-opaque-token", "rotated-opaque-token", "second-device-token"];
  const ids = ["user-1", "device-1", "device-2"];
  const now = new Date();
  const lifecycle = new PostgresSessionLifecycle(
    pool,
    () => now,
    () => tokens.shift()!,
    () => ids.shift()!,
    60 * 60 * 1000,
  );
  return { pool, lifecycle };
}

describe("PostgreSQL session lifecycle", () => {
  it("provisions one OIDC user and registers each authenticated device", async () => {
    const { pool, lifecycle } = await setup();
    const first = await lifecycle.establishFromOidc({
      issuer: "https://identity.example", subject: "subject-123", deviceLabel: "MacBook",
    });
    const second = await lifecycle.establishFromOidc({
      issuer: "https://identity.example", subject: "subject-123", deviceLabel: "Phone",
    });

    expect(first).toMatchObject({ token: "first-opaque-token", userId: "user-1", deviceId: "device-1" });
    expect(second).toMatchObject({ token: "rotated-opaque-token", userId: "user-1", deviceId: "device-2" });
    const users = await pool.query("SELECT count(*)::int AS count FROM users");
    const devices = await pool.query("SELECT count(*)::int AS count FROM sync_devices");
    expect(users.rows[0].count).toBe(1);
    expect(devices.rows[0].count).toBe(2);
    const stored = await pool.query("SELECT token_hash FROM auth_sessions ORDER BY created_at") as { rows: Array<{ token_hash: string }> };
    expect(stored.rows.map((row: { token_hash: string }) => row.token_hash)).toContain(hashSessionToken(first.token));
    expect(stored.rows.map((row: { token_hash: string }) => row.token_hash)).not.toContain(first.token);
  });

  it("atomically revokes the old token when rotating and supports logout", async () => {
    const { pool, lifecycle } = await setup();
    const first = await lifecycle.establishFromOidc({
      issuer: "https://identity.example", subject: "subject-123", deviceLabel: "Laptop",
    });
    const rotated = await lifecycle.rotate(first.token);

    expect(rotated).toMatchObject({ token: "rotated-opaque-token", userId: first.userId, deviceId: first.deviceId });
    await expect(lifecycle.rotate(first.token)).resolves.toBeNull();
    await expect(lifecycle.revoke(rotated!.token)).resolves.toBe(true);
    await expect(lifecycle.revoke(rotated!.token)).resolves.toBe(false);
    const active = await pool.query("SELECT count(*)::int AS count FROM auth_sessions WHERE revoked_at IS NULL");
    expect(active.rows[0].count).toBe(0);
  });

  it("revokes every device and session after validating the current session", async () => {
    const { pool, lifecycle } = await setup();
    const first = await lifecycle.establishFromOidc({
      issuer: "https://identity.example", subject: "subject-123", deviceLabel: "Laptop",
    });
    const second = await lifecycle.establishFromOidc({
      issuer: "https://identity.example", subject: "subject-123", deviceLabel: "Phone",
    });

    await expect(lifecycle.revokeAll(first.token)).resolves.toBe(true);
    await expect(lifecycle.rotate(first.token)).resolves.toBeNull();
    await expect(lifecycle.rotate(second.token)).resolves.toBeNull();
    await expect(lifecycle.revokeAll(first.token)).resolves.toBe(false);
    const activeSessions = await pool.query("SELECT count(*)::int AS count FROM auth_sessions WHERE revoked_at IS NULL");
    const activeDevices = await pool.query("SELECT count(*)::int AS count FROM sync_devices WHERE revoked_at IS NULL");
    expect(activeSessions.rows[0].count).toBe(0);
    expect(activeDevices.rows[0].count).toBe(0);
  });

  it("lists active devices and revokes one selected device without ending the current session", async () => {
    const { lifecycle } = await setup();
    const first = await lifecycle.establishFromOidc({
      issuer: "https://identity.example", subject: "subject-123", deviceLabel: "Laptop",
    });
    const second = await lifecycle.establishFromOidc({
      issuer: "https://identity.example", subject: "subject-123", deviceLabel: "Phone",
    });

    await expect(lifecycle.listActiveDevices(first.token)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.deviceId, label: "Laptop", current: true }),
      expect.objectContaining({ id: second.deviceId, label: "Phone", current: false }),
    ]));
    await expect(lifecycle.revokeDevice(first.token, second.deviceId)).resolves.toBe(true);
    await expect(lifecycle.rotate(second.token)).resolves.toBeNull();
    await expect(lifecycle.rotate(first.token)).resolves.toMatchObject({ deviceId: first.deviceId });
    await expect(lifecycle.revokeDevice(first.token, "missing-device")).resolves.toBe(false);
  });

  it("deletes the authenticated account and all user-owned data atomically", async () => {
    const { pool, lifecycle } = await setup();
    const session = await lifecycle.establishFromOidc({
      issuer: "https://identity.example", subject: "subject-123", deviceLabel: "Laptop",
    });
    await pool.query(
      "INSERT INTO learning_plans (user_id, id, revision, updated_at, value) VALUES ($1, 'plan-1', 1, $2, $3::jsonb)",
      [session.userId, "2026-08-01T12:00:00.000Z", JSON.stringify({ id: "plan-1" })],
    );

    await expect(lifecycle.deleteAccount(session.token)).resolves.toBe(true);
    await expect(lifecycle.deleteAccount(session.token)).resolves.toBe(false);
    for (const table of ["users", "oidc_identities", "sync_devices", "auth_sessions", "learning_plans"]) {
      const result = await pool.query(`SELECT count(*)::int AS count FROM ${table}`);
      expect(result.rows[0].count, table).toBe(0);
    }
  });

  it("rejects malformed identity data before writing", async () => {
    const { lifecycle } = await setup();
    await expect(lifecycle.establishFromOidc({
      issuer: "not-a-url", subject: "subject", deviceLabel: "Laptop",
    })).rejects.toThrow(/Invalid URL|issuer/);
  });

  it("prunes authentication metadata older than the retention window without removing active devices", async () => {
    const { pool } = await setup();
    const currentTime = new Date("2026-08-08T12:00:00.000Z");
    const oldTime = new Date(currentTime.getTime() - AUTH_METADATA_RETENTION_MS - 1_000).toISOString();
    await pool.query("INSERT INTO users (id) VALUES ('old-user')");
    await pool.query(
      "INSERT INTO oidc_identities (issuer, subject, user_id) VALUES ('https://identity.example', 'old-subject', 'old-user')",
    );
    await pool.query(
      `INSERT INTO sync_devices (user_id, id, label, created_at, last_seen_at)
       VALUES ('old-user', 'abandoned-device', 'Old phone', $1, $1),
              ('old-user', 'active-device', 'Current phone', $1, $1)`,
      [oldTime],
    );
    await pool.query(
      `INSERT INTO auth_sessions (token_hash, user_id, device_id, created_at, expires_at)
       VALUES ($1, 'old-user', 'abandoned-device', $2, $3),
              ($4, 'old-user', 'active-device', $2, $5)`,
      [
        hashSessionToken("expired-token"),
        new Date(new Date(oldTime).getTime() - 60_000).toISOString(),
        oldTime,
        hashSessionToken("active-token"),
        new Date(currentTime.getTime() + 60_000).toISOString(),
      ],
    );
    const lifecycle = new PostgresSessionLifecycle(
      pool,
      () => currentTime,
      () => "new-token",
      () => "new-device",
    );

    await lifecycle.establishFromOidc({
      issuer: "https://identity.example", subject: "old-subject", deviceLabel: "New laptop",
    });

    const devices = await pool.query("SELECT id FROM sync_devices WHERE user_id = 'old-user' ORDER BY id");
    const sessions = await pool.query("SELECT device_id FROM auth_sessions WHERE user_id = 'old-user' ORDER BY device_id");
    expect(devices.rows).toEqual([{ id: "active-device" }, { id: "new-device" }]);
    expect(sessions.rows).toEqual([{ device_id: "active-device" }, { device_id: "new-device" }]);
  });
});
