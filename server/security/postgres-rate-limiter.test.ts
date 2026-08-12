import { readFile } from "node:fs/promises";
import { DataType, newDb } from "pg-mem";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { PostgresFixedWindowRateLimiter } from "./postgres-rate-limiter";

const pools: Array<{ end(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe("PostgreSQL fixed-window rate limiter", () => {
  it("shares atomic counters across limiter instances without storing raw client keys", async () => {
    const memory = newDb();
    memory.public.registerFunction({
      name: "length",
      args: [DataType.text],
      returns: DataType.integer,
      implementation: (value: string) => value.length,
    });
    const adapter = memory.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    const migration = await readFile(new URL("../sync/migrations/004-request-rate-limits.sql", import.meta.url), "utf8");
    await pool.query(migration);
    let now = Date.parse("2026-08-01T12:00:01.000Z");
    const firstInstance = new PostgresFixedWindowRateLimiter(pool, () => now);
    const secondInstance = new PostgresFixedWindowRateLimiter(pool, () => now);
    const policy = { limit: 2, windowMs: 60_000 };

    await expect(firstInstance.consume("sync-write", "203.0.113.7", policy)).resolves.toMatchObject({ allowed: true, remaining: 1 });
    await expect(secondInstance.consume("sync-write", "203.0.113.7", policy)).resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(firstInstance.consume("sync-write", "203.0.113.7", policy)).resolves.toMatchObject({ allowed: false, remaining: 0 });
    await expect(firstInstance.consume("sync-write", "203.0.113.8", policy)).resolves.toMatchObject({ allowed: true, remaining: 1 });

    const stored = await pool.query(
      "SELECT key_hash, request_count FROM request_rate_limits ORDER BY request_count DESC",
    ) as { rows: Array<{ key_hash: string; request_count: number }> };
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows[0].request_count).toBe(3);
    expect(stored.rows.map((row) => row.key_hash)).not.toContain("203.0.113.7");

    now += 60_000;
    await expect(secondInstance.consume("sync-write", "203.0.113.7", policy)).resolves.toMatchObject({ allowed: true, remaining: 1 });
  });

  it("redacts database details when opportunistic cleanup fails", async () => {
    const secret = "postgres://private-user:private-password@private-host/database";
    let queryCount = 0;
    const pool = {
      query: async (query: string) => {
        queryCount += 1;
        if (query.startsWith("DELETE")) throw new Error(secret);
        return { rows: [{ request_count: 1 }] };
      },
    } as unknown as Pool;
    const limiter = new PostgresFixedWindowRateLimiter(pool, () => Date.parse("2026-08-01T12:00:01.000Z"));
    const logged: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...values: unknown[]) => { logged.push(values); };

    try {
      for (let index = 0; index < 1_000; index += 1) {
        await limiter.consume("sync-write", `client-${index}`, { limit: 2, windowMs: 60_000 });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = originalConsoleError;
    }

    expect(queryCount).toBe(1_001);
    expect(logged).toEqual([["Rate limit cleanup failed", "Error"]]);
    expect(JSON.stringify(logged)).not.toContain(secret);
  });
});
