import { readFile } from "node:fs/promises";
import { DataType, newDb } from "pg-mem";
import { afterEach, describe, expect, it } from "vitest";
import { hashSessionToken } from "./postgres-session-resolver";
import { PostgresSessionLifecycle } from "./postgres-session-lifecycle";

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
  const lifecycle = new PostgresSessionLifecycle(
    pool,
    () => new Date("2026-08-01T12:00:00.000Z"),
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

  it("rejects malformed identity data before writing", async () => {
    const { lifecycle } = await setup();
    await expect(lifecycle.establishFromOidc({
      issuer: "not-a-url", subject: "subject", deviceLabel: "Laptop",
    })).rejects.toThrow(/Invalid URL|issuer/);
  });
});
