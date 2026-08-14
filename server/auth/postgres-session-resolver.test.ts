import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { DataType, newDb } from "pg-mem";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_COOKIE_NAME,
  hashSessionToken,
  LEGACY_SESSION_COOKIE_NAME,
  PostgresSessionPrincipalResolver,
  readSessionToken,
} from "./postgres-session-resolver";

const pools: Array<{ end(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

async function setup(now = new Date("2026-08-01T12:00:00.000Z")) {
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
  for (const migration of ["001-initial-sync-schema.sql", "002-auth-sessions.sql"]) {
    await pool.query(await readFile(new URL(`../sync/migrations/${migration}`, import.meta.url), "utf8"));
  }
  await pool.query("INSERT INTO users (id) VALUES ('user-alice')");
  await pool.query("INSERT INTO sync_devices (user_id, id, label) VALUES ('user-alice', 'device-laptop', 'Laptop')");
  const resolver = new PostgresSessionPrincipalResolver(pool, "session", () => now);
  return { pool, resolve: resolver.resolve };
}

function request(cookie?: string): IncomingMessage {
  return { headers: { cookie } } as IncomingMessage;
}

describe("PostgreSQL session principal resolver", () => {
  it("prefers the host-only default, migrates the legacy name, and rejects ambiguous duplicates", () => {
    expect(readSessionToken(`${LEGACY_SESSION_COOKIE_NAME}=legacy-token`)).toBe("legacy-token");
    expect(readSessionToken(
      `${LEGACY_SESSION_COOKIE_NAME}=legacy-token; ${DEFAULT_SESSION_COOKIE_NAME}=host-token`,
    )).toBe("host-token");
    expect(readSessionToken(`${DEFAULT_SESSION_COOKIE_NAME}=first; ${DEFAULT_SESSION_COOKIE_NAME}=second`)).toBeNull();
    expect(readSessionToken("custom=first; custom=second", "custom")).toBeNull();
    expect(readSessionToken("custom=same; custom=same", "custom")).toBe("same");
  });

  it("resolves an active opaque session and stores only its hash", async () => {
    const { pool, resolve } = await setup();
    const token = "local-test-session-token-with-enough-entropy";
    await pool.query(
      `INSERT INTO auth_sessions (token_hash, user_id, device_id, created_at, expires_at)
       VALUES ($1, 'user-alice', 'device-laptop', '2026-07-31T12:00:00.000Z', '2026-08-02T12:00:00.000Z')`,
      [hashSessionToken(token)],
    );

    await expect(resolve(request(`theme=dark; session=${token}`))).resolves.toEqual({
      userId: "user-alice", deviceId: "device-laptop",
    });
    const stored = await pool.query("SELECT token_hash FROM auth_sessions");
    expect(stored.rows[0].token_hash).not.toContain(token);
  });

  it("rejects missing, expired, revoked, and device-revoked sessions", async () => {
    const { pool, resolve } = await setup();
    const insert = (token: string, expiresAt: string, revokedAt: string | null = null) => pool.query(
      `INSERT INTO auth_sessions (token_hash, user_id, device_id, created_at, expires_at, revoked_at)
       VALUES ($1, 'user-alice', 'device-laptop', '2026-07-31T12:00:00.000Z', $2, $3)`,
      [hashSessionToken(token), expiresAt, revokedAt],
    );
    await insert("expired", "2026-08-01T11:59:59.000Z");
    await insert("revoked", "2026-08-02T12:00:00.000Z", "2026-08-01T11:00:00.000Z");
    await insert("active", "2026-08-02T12:00:00.000Z");

    await expect(resolve(request())).resolves.toBeNull();
    await expect(resolve(request("session=expired"))).resolves.toBeNull();
    await expect(resolve(request("session=revoked"))).resolves.toBeNull();
    await pool.query("UPDATE sync_devices SET revoked_at = '2026-08-01T11:00:00.000Z'");
    await expect(resolve(request("session=active"))).resolves.toBeNull();
  });
});
