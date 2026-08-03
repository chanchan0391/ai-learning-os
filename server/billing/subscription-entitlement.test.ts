import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PostgresSubscriptionEntitlementResolver } from "./subscription-entitlement";

const now = new Date("2026-08-03T18:00:00.000Z");

async function setup() {
  const database = newDb();
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool() as unknown as Pool;
  for (const migration of ["001-initial-sync-schema.sql", "007-subscription-entitlements.sql"]) {
    await pool.query(readFileSync(join(process.cwd(), "server/sync/migrations", migration), "utf8"));
  }
  await pool.query("INSERT INTO users (id, created_at) VALUES ('user-1', $1)", [now]);
  return { pool, resolver: new PostgresSubscriptionEntitlementResolver(pool, () => now.getTime()) };
}

describe("PostgreSQL subscription entitlements", () => {
  it("denies an account without a server-side entitlement", async () => {
    const { pool, resolver } = await setup();
    await expect(resolver.checkEntitlement("user-1")).resolves.toEqual({
      allowed: false, state: "inactive", planKey: null, accessUntil: null,
    });
    await pool.end();
  });

  it("reflects plan switches on the next request without cached authorization", async () => {
    const { pool, resolver } = await setup();
    await pool.query(
      `INSERT INTO subscription_entitlements (user_id, plan_key, status, access_until, updated_at)
       VALUES ('user-1', 'starter', 'active', $1, $2)`,
      [new Date("2026-09-01T00:00:00.000Z"), now],
    );
    await expect(resolver.checkEntitlement("user-1")).resolves.toMatchObject({ allowed: true, planKey: "starter", state: "active" });

    await pool.query("UPDATE subscription_entitlements SET plan_key = 'pro', updated_at = $1 WHERE user_id = 'user-1'", [now]);
    await expect(resolver.checkEntitlement("user-1")).resolves.toMatchObject({ allowed: true, planKey: "pro", state: "active" });
    await pool.end();
  });

  it("allows a grace period only until its server-side deadline", async () => {
    const { pool, resolver } = await setup();
    await pool.query(
      `INSERT INTO subscription_entitlements (user_id, plan_key, status, access_until, updated_at)
       VALUES ('user-1', 'pro', 'grace', $1, $2)`,
      [new Date("2026-08-04T00:00:00.000Z"), now],
    );
    await expect(resolver.checkEntitlement("user-1")).resolves.toMatchObject({ allowed: true, state: "grace" });

    const expired = new PostgresSubscriptionEntitlementResolver(pool, () => new Date("2026-08-04T00:00:00.000Z").getTime());
    await expect(expired.checkEntitlement("user-1")).resolves.toMatchObject({ allowed: false, state: "inactive", planKey: "pro" });
    await pool.end();
  });
});
