import { readFile } from "node:fs/promises";
import { DataType, newDb } from "pg-mem";
import { afterEach, describe, expect, it } from "vitest";
import { MeteredModelProvider, PostgresModelUsageLedger } from "./model-usage";
import type { ModelProvider } from "./model-provider";

const pools: Array<{ end(): Promise<void> }> = [];
afterEach(async () => Promise.all(pools.splice(0).map((pool) => pool.end())));

async function createLedger(now: () => number) {
  const memory = newDb();
  memory.public.registerFunction({ name: "length", args: [DataType.text], returns: DataType.integer, implementation: (value: string) => value.length });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  pools.push(pool);
  for (const migration of ["001-initial-sync-schema.sql", "005-model-usage-ledger.sql", "006-model-usage-global-time-index.sql"]) {
    await pool.query(await readFile(new URL(`../sync/migrations/${migration}`, import.meta.url), "utf8"));
  }
  await pool.query("INSERT INTO users (id) VALUES ('user-1')");
  return { pool, ledger: new PostgresModelUsageLedger(pool, {
    monthlyTokenLimit: 1_000,
    monthlyCostLimitMicros: 1_000,
    globalMonthlyCostLimitMicros: 10_000,
    inputCostMicrosPerMillionTokens: 2_000_000,
    outputCostMicrosPerMillionTokens: 8_000_000,
  }, now) };
}

describe("account model usage", () => {
  it("records privacy-safe token and cost entries and enforces UTC monthly limits", async () => {
    let now = Date.parse("2026-08-03T12:00:00.000Z");
    const { pool, ledger } = await createLedger(() => now);
    await ledger.record({ userId: "user-1", action: "ai.plan.create", provider: "openai", model: "model-a", requestId: "req-1", inputTokens: 100, outputTokens: 50 });

    await expect(ledger.checkBudget("user-1")).resolves.toMatchObject({
      allowed: true, exceeded: null, remainingTokens: 850, remainingCostMicros: 400, remainingGlobalCostMicros: 9_400,
    });
    const stored = await pool.query("SELECT action, provider, model, input_tokens, output_tokens, cost_micros FROM model_usage_events");
    expect(stored.rows).toEqual([{ action: "ai.plan.create", provider: "openai", model: "model-a", input_tokens: 100, output_tokens: 50, cost_micros: 600 }]);

    await ledger.record({ userId: "user-1", action: "ai.teaching.create", provider: "openai", model: "model-a", inputTokens: 10, outputTokens: 50 });
    await expect(ledger.checkBudget("user-1")).resolves.toMatchObject({ allowed: false, remainingCostMicros: 0 });

    now = Date.parse("2026-09-01T00:00:00.000Z");
    await expect(ledger.checkBudget("user-1")).resolves.toMatchObject({ allowed: true, remainingTokens: 1_000, remainingCostMicros: 1_000 });

    await pool.query("DELETE FROM users WHERE id = 'user-1'");
    const afterDeletion = await pool.query("SELECT 1 FROM model_usage_events");
    expect(afterDeletion.rowCount).toBe(0);
  });

  it("stops every account when aggregate monthly model spend reaches the global ceiling", async () => {
    const { pool, ledger } = await createLedger(() => Date.parse("2026-08-03T12:00:00.000Z"));
    await pool.query("INSERT INTO users (id) VALUES ('user-2')");
    await ledger.record({ userId: "user-2", action: "ai.plan.create", provider: "openai", model: "model-a", inputTokens: 1_000, outputTokens: 1_000 });

    await expect(ledger.checkBudget("user-1")).resolves.toMatchObject({
      allowed: false,
      exceeded: "global",
      remainingTokens: 1_000,
      remainingCostMicros: 1_000,
      remainingGlobalCostMicros: 0,
    });
  });

  it("meters only provider calls inside an authenticated request context", async () => {
    const entries: unknown[] = [];
    const provider: ModelProvider = {
      id: "live", isAiEnabled: true,
      generateStructured: async <T>() => ({ value: { ok: true } as T, model: "model-a", requestId: "req-1", usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } }),
    };
    const metered = new MeteredModelProvider(provider, {
      checkBudget: async () => ({ allowed: true, exceeded: null, resetAt: 0, remainingTokens: 1, remainingCostMicros: 1 }),
      record: async (entry) => { entries.push(entry); },
    });
    await metered.generateStructured({ instructions: "x", input: "x", schema: { name: "x", value: {} } });
    await metered.run({ userId: "user-1", action: "ai.plan.create" }, () => metered.generateStructured({ instructions: "x", input: "x", schema: { name: "x", value: {} } }));
    expect(entries).toEqual([{ userId: "user-1", action: "ai.plan.create", provider: "live", model: "model-a", requestId: "req-1", inputTokens: 5, outputTokens: 3 }]);
  });
});
