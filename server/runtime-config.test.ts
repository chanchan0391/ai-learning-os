import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createSyncRuntime, readAgentConcurrencyLimit, readSyncRuntimeConfig } from "./runtime-config";

describe("sync runtime configuration", () => {
  it("loads an optional positive per-instance Agent concurrency limit", () => {
    expect(readAgentConcurrencyLimit({})).toBeUndefined();
    expect(readAgentConcurrencyLimit({ AI_MAX_CONCURRENT_AGENT_REQUESTS: "12" })).toBe(12);
    expect(() => readAgentConcurrencyLimit({ AI_MAX_CONCURRENT_AGENT_REQUESTS: "0" })).toThrow(/positive integer/);
    expect(() => readAgentConcurrencyLimit({ AI_MAX_CONCURRENT_AGENT_REQUESTS: "1.5" })).toThrow(/positive integer/);
  });

  it("keeps sync disabled when no database is configured", () => {
    expect(readSyncRuntimeConfig({})).toBeNull();
  });

  it("loads a database with deduplicated exact origins", () => {
    expect(readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning",
      SYNC_ALLOWED_ORIGINS: "http://127.0.0.1:5173, https://learn.example,https://learn.example",
      SESSION_COOKIE_NAME: "learning_session",
    })).toEqual({
      connectionString: "postgres://localhost/learning",
      allowedOrigins: ["http://127.0.0.1:5173", "https://learn.example"],
      sessionCookieName: "learning_session",
    });
  });

  it("fails fast for incomplete or unsafe sync configuration", () => {
    expect(() => readSyncRuntimeConfig({ SYNC_ALLOWED_ORIGINS: "https://learn.example" })).toThrow(/DATABASE_URL/);
    expect(() => readSyncRuntimeConfig({ DATABASE_URL: "postgres://localhost/learning" })).toThrow(/SYNC_ALLOWED_ORIGINS/);
    expect(() => readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning", SYNC_ALLOWED_ORIGINS: "http://learn.example",
    })).toThrow(/exact HTTPS/);
    expect(() => readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning", SYNC_ALLOWED_ORIGINS: "https://learn.example/path",
    })).toThrow(/exact HTTPS/);
    expect(() => readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning", SYNC_ALLOWED_ORIGINS: "https://learn.example",
      OIDC_ISSUER: "https://identity.example",
    })).toThrow(/configured together/);
  });

  it("loads a complete provider-neutral OIDC configuration", () => {
    expect(readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning",
      SYNC_ALLOWED_ORIGINS: "https://learn.example",
      OIDC_ISSUER: "https://identity.example",
      OIDC_CLIENT_ID: "learning-client",
      OIDC_REDIRECT_URI: "https://learn.example/api/auth/callback",
      OIDC_TRANSACTION_SECRET: "a-secure-random-value-with-32-characters",
    })?.oidc).toEqual({
      issuer: "https://identity.example",
      clientId: "learning-client",
      redirectUri: "https://learn.example/api/auth/callback",
      transactionSecret: "a-secure-random-value-with-32-characters",
    });
  });

  it("loads explicit monthly token and USD account budgets", () => {
    expect(readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning",
      SYNC_ALLOWED_ORIGINS: "https://learn.example",
      AI_MONTHLY_TOKEN_LIMIT: "250000",
      AI_MONTHLY_COST_LIMIT_USD: "12.50",
      AI_INPUT_COST_PER_MILLION_USD: "2",
      AI_OUTPUT_COST_PER_MILLION_USD: "8.000001",
      AI_GLOBAL_MONTHLY_COST_LIMIT_USD: "250",
      AI_PLAN_BUDGETS_JSON: '{"starter":{"monthlyTokenLimit":50000,"monthlyCostLimitUsd":"2.50"}}',
    })?.modelUsagePolicy).toEqual({
      monthlyTokenLimit: 250_000,
      monthlyCostLimitMicros: 12_500_000,
      inputCostMicrosPerMillionTokens: 2_000_000,
      outputCostMicrosPerMillionTokens: 8_000_001,
      globalMonthlyCostLimitMicros: 250_000_000,
      planBudgets: { starter: { monthlyTokenLimit: 50_000, monthlyCostLimitMicros: 2_500_000 } },
    });
  });

  it("rejects partial or invalid account budget configuration", () => {
    expect(() => readSyncRuntimeConfig({ AI_MONTHLY_TOKEN_LIMIT: "100" })).toThrow(/DATABASE_URL/);
    expect(() => readSyncRuntimeConfig({ AI_GLOBAL_MONTHLY_COST_LIMIT_USD: "250" })).toThrow(/DATABASE_URL/);
    expect(() => readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning", SYNC_ALLOWED_ORIGINS: "https://learn.example",
      AI_MONTHLY_TOKEN_LIMIT: "100",
    })).toThrow(/configured together/);
    expect(() => readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning", SYNC_ALLOWED_ORIGINS: "https://learn.example",
      AI_GLOBAL_MONTHLY_COST_LIMIT_USD: "250",
    })).toThrow(/complete AI account budget/);
    expect(() => readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning", SYNC_ALLOWED_ORIGINS: "https://learn.example",
      AI_MONTHLY_TOKEN_LIMIT: "100", AI_MONTHLY_COST_LIMIT_USD: "1.0000001",
      AI_INPUT_COST_PER_MILLION_USD: "2", AI_OUTPUT_COST_PER_MILLION_USD: "8",
    })).toThrow(/at most 6 decimals/);
    expect(() => readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning", SYNC_ALLOWED_ORIGINS: "https://learn.example",
      AI_SUBSCRIPTION_ENTITLEMENTS_REQUIRED: "yes",
    })).toThrow(/must be true or false/);
    expect(() => readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning", SYNC_ALLOWED_ORIGINS: "https://learn.example",
      AI_SUBSCRIPTION_ENTITLEMENTS_REQUIRED: "true",
    })).toThrow(/requires the complete AI account budget/);
  });

  it("enables server-side subscription enforcement only with account budgets", () => {
    expect(readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning",
      SYNC_ALLOWED_ORIGINS: "https://learn.example",
      AI_MONTHLY_TOKEN_LIMIT: "250000",
      AI_MONTHLY_COST_LIMIT_USD: "12.50",
      AI_INPUT_COST_PER_MILLION_USD: "2",
      AI_OUTPUT_COST_PER_MILLION_USD: "8",
      AI_SUBSCRIPTION_ENTITLEMENTS_REQUIRED: "true",
      AI_PLAN_BUDGETS_JSON: '{"starter":{"monthlyTokenLimit":50000,"monthlyCostLimitUsd":"2.50"}}',
    })?.requireSubscriptionEntitlement).toBe(true);
  });

  it("rejects missing or malformed plan budgets when subscription enforcement is enabled", () => {
    const base = {
      DATABASE_URL: "postgres://localhost/learning", SYNC_ALLOWED_ORIGINS: "https://learn.example",
      AI_MONTHLY_TOKEN_LIMIT: "250000", AI_MONTHLY_COST_LIMIT_USD: "12.50",
      AI_INPUT_COST_PER_MILLION_USD: "2", AI_OUTPUT_COST_PER_MILLION_USD: "8",
      AI_SUBSCRIPTION_ENTITLEMENTS_REQUIRED: "true",
    };
    expect(() => readSyncRuntimeConfig(base)).toThrow(/AI_PLAN_BUDGETS_JSON/);
    expect(() => readSyncRuntimeConfig({ ...base, AI_PLAN_BUDGETS_JSON: '{"starter":{"monthlyTokenLimit":0,"monthlyCostLimitUsd":"2"}}' })).toThrow(/positive integer/);
    expect(() => readSyncRuntimeConfig({ ...base, AI_PLAN_BUDGETS_JSON: '{"starter":{"monthlyTokenLimit":100,"monthlyCostLimitUsd":2}}' })).toThrow(/requires only/);
  });

  it("allows an HTTP issuer only for local development", () => {
    expect(readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning",
      SYNC_ALLOWED_ORIGINS: "http://127.0.0.1:5173",
      OIDC_ISSUER: "http://127.0.0.1:5556/dex",
      OIDC_CLIENT_ID: "learning-client",
      OIDC_REDIRECT_URI: "http://127.0.0.1:5173/api/auth/callback",
      OIDC_TRANSACTION_SECRET: "a-secure-random-value-with-32-characters",
    })?.oidc?.issuer).toBe("http://127.0.0.1:5556/dex");
    expect(() => readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning",
      SYNC_ALLOWED_ORIGINS: "https://learn.example",
      OIDC_ISSUER: "http://identity.example",
      OIDC_CLIENT_ID: "learning-client",
      OIDC_REDIRECT_URI: "https://learn.example/api/auth/callback",
      OIDC_TRANSACTION_SECRET: "a-secure-random-value-with-32-characters",
    })).toThrow(/exact HTTPS/);
  });

  it("wires PostgreSQL into the application readiness check", async () => {
    const queries: unknown[] = [];
    const pool = {
      query: async (query: unknown) => { queries.push(query); return { rows: [{ "?column?": 1 }] }; },
      end: async () => undefined,
    } as unknown as Pool;
    const runtime = createSyncRuntime({
      DATABASE_URL: "postgres://localhost/learning",
      SYNC_ALLOWED_ORIGINS: "https://learn.example",
    }, () => pool);

    await runtime.appOptions.readinessCheck?.();

    expect(queries).toEqual(["SELECT 1"]);
    await runtime.close();
  });
});
