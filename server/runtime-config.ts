import pg, { type Pool, type PoolConfig } from "pg";
import { isIP } from "node:net";
import type { AppOptions } from "./app";
import { PostgresSessionPrincipalResolver } from "./auth/postgres-session-resolver";
import { DEFAULT_MAX_ACTIVE_DEVICES, PostgresSessionLifecycle } from "./auth/postgres-session-lifecycle";
import { MAX_OIDC_UPSTREAM_TIMEOUT_MS, StandardOidcClient, type OidcConfig } from "./auth/oidc-client";
import { PostgresModelUsageLedger, type AccountModelBudget, type ModelUsagePolicy } from "./ai/model-usage";
import { PostgresSubscriptionEntitlementResolver } from "./billing/subscription-entitlement";
import { JsonLineRequestLogSink } from "./observability/request-observability";
import { PostgresPoolCapacityMonitor } from "./observability/database-capacity";
import { PostgresFixedWindowRateLimiter } from "./security/postgres-rate-limiter";
import { JsonLineSecurityAuditSink, RollingRequestCapacityMonitor } from "./security/request-security";
import { PostgresSyncStore } from "./sync/postgres-sync-store";

export interface SyncRuntime {
  appOptions: AppOptions;
  close(): Promise<void>;
}

export interface SyncRuntimeConfig {
  connectionString: string;
  databaseTls: boolean;
  allowedOrigins: string[];
  sessionCookieName?: string;
  oidc?: OidcConfig;
  modelUsagePolicy?: ModelUsagePolicy;
  requireSubscriptionEntitlement?: boolean;
  maxActiveDevices: number;
}

export const DATABASE_POOL_DEFAULTS = {
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statementTimeoutMillis: 15_000,
  queryTimeoutMillis: 20_000,
  idleInTransactionSessionTimeoutMillis: 15_000,
  maxLifetimeSeconds: 300,
} as const;

export const RUNTIME_RESOURCE_LIMITS = {
  agentConcurrency: 100,
  databasePoolMax: 100,
  databaseConnectionTimeoutMillis: 60_000,
  databaseIdleTimeoutMillis: 600_000,
  databaseStatementTimeoutMillis: 120_000,
  databaseQueryTimeoutMillis: 180_000,
  databaseIdleTransactionTimeoutMillis: 120_000,
  databaseMaxLifetimeSeconds: 86_400,
  activeDevicesPerAccount: 1_000,
} as const;

export interface DatabasePoolRuntimeConfig {
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  statementTimeoutMillis: number;
  queryTimeoutMillis: number;
  idleInTransactionSessionTimeoutMillis: number;
  maxLifetimeSeconds: number;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseBoundedPositiveInteger(value: string, name: string, maximum: number): number {
  const parsed = parsePositiveInteger(value, name);
  if (parsed > maximum) throw new Error(`${name} must be no greater than ${maximum}`);
  return parsed;
}

export function readAgentConcurrencyLimit(env: NodeJS.ProcessEnv): number | undefined {
  const value = env.AI_MAX_CONCURRENT_AGENT_REQUESTS?.trim();
  return value
    ? parseBoundedPositiveInteger(value, "AI_MAX_CONCURRENT_AGENT_REQUESTS", RUNTIME_RESOURCE_LIMITS.agentConcurrency)
    : undefined;
}

/** Prevents live model credentials from silently exposing unauthenticated, unmetered Agent endpoints. */
export function assertModelUsageSafety(
  isAiEnabled: boolean,
  hasModelUsageLedger: boolean,
  env: NodeJS.ProcessEnv,
): void {
  const override = env.AI_ALLOW_UNMETERED_LIVE_MODEL?.trim();
  if (override && override !== "true" && override !== "false") {
    throw new Error("AI_ALLOW_UNMETERED_LIVE_MODEL must be true or false");
  }
  if (isAiEnabled && !hasModelUsageLedger && override !== "true") {
    throw new Error(
      "Live model providers require account model budgets; set AI_ALLOW_UNMETERED_LIVE_MODEL=true only for an isolated development smoke test",
    );
  }
}

export function readDatabasePoolConfig(env: NodeJS.ProcessEnv): DatabasePoolRuntimeConfig {
  const read = (name: string, fallback: number, maximum: number) => {
    const value = env[name]?.trim();
    return value ? parseBoundedPositiveInteger(value, name, maximum) : fallback;
  };
  const config = {
    max: read("DATABASE_POOL_MAX", DATABASE_POOL_DEFAULTS.max, RUNTIME_RESOURCE_LIMITS.databasePoolMax),
    connectionTimeoutMillis: read("DATABASE_CONNECTION_TIMEOUT_MS", DATABASE_POOL_DEFAULTS.connectionTimeoutMillis, RUNTIME_RESOURCE_LIMITS.databaseConnectionTimeoutMillis),
    idleTimeoutMillis: read("DATABASE_IDLE_TIMEOUT_MS", DATABASE_POOL_DEFAULTS.idleTimeoutMillis, RUNTIME_RESOURCE_LIMITS.databaseIdleTimeoutMillis),
    statementTimeoutMillis: read("DATABASE_STATEMENT_TIMEOUT_MS", DATABASE_POOL_DEFAULTS.statementTimeoutMillis, RUNTIME_RESOURCE_LIMITS.databaseStatementTimeoutMillis),
    queryTimeoutMillis: read("DATABASE_QUERY_TIMEOUT_MS", DATABASE_POOL_DEFAULTS.queryTimeoutMillis, RUNTIME_RESOURCE_LIMITS.databaseQueryTimeoutMillis),
    idleInTransactionSessionTimeoutMillis: read(
      "DATABASE_IDLE_TRANSACTION_TIMEOUT_MS",
      DATABASE_POOL_DEFAULTS.idleInTransactionSessionTimeoutMillis,
      RUNTIME_RESOURCE_LIMITS.databaseIdleTransactionTimeoutMillis,
    ),
    maxLifetimeSeconds: read("DATABASE_MAX_LIFETIME_SECONDS", DATABASE_POOL_DEFAULTS.maxLifetimeSeconds, RUNTIME_RESOURCE_LIMITS.databaseMaxLifetimeSeconds),
  };
  if (config.queryTimeoutMillis <= config.statementTimeoutMillis) {
    throw new Error("DATABASE_QUERY_TIMEOUT_MS must be greater than DATABASE_STATEMENT_TIMEOUT_MS");
  }
  return config;
}

function toPoolConfig(connectionString: string, config: DatabasePoolRuntimeConfig, databaseTls = false): PoolConfig {
  return {
    connectionString,
    ...(databaseTls ? { ssl: { rejectUnauthorized: true } } : {}),
    max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
    statement_timeout: config.statementTimeoutMillis,
    query_timeout: config.queryTimeoutMillis,
    idle_in_transaction_session_timeout: config.idleInTransactionSessionTimeoutMillis,
    maxLifetimeSeconds: config.maxLifetimeSeconds,
  };
}

function parseUsdMicros(value: string, name: string): number {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) throw new Error(`${name} must be a positive USD amount with at most 6 decimals`);
  const [whole, fraction = ""] = value.split(".");
  const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
  if (!Number.isSafeInteger(micros) || micros <= 0) throw new Error(`${name} must be a positive safe USD amount`);
  return micros;
}

function parseOrigins(value: string): string[] {
  const origins = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (origins.length === 0) throw new Error("SYNC_ALLOWED_ORIGINS is required when DATABASE_URL enables sync");
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
      throw new Error(`SYNC_ALLOWED_ORIGINS must contain exact HTTPS or local development origins: ${origin}`);
    }
  }
  return origins;
}

function parseDatabaseConnection(connectionString: string, tlsMode: string | undefined): { databaseTls: boolean } {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql scheme");
  }
  if (["sslmode", "sslcert", "sslkey", "sslrootcert"].some((name) => url.searchParams.has(name))) {
    throw new Error("Configure database TLS with DATABASE_TLS_MODE, not DATABASE_URL query parameters");
  }
  const normalizedMode = tlsMode?.trim();
  if (normalizedMode && normalizedMode !== "disable" && normalizedMode !== "verify-full") {
    throw new Error("DATABASE_TLS_MODE must be disable or verify-full");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!loopback && normalizedMode !== "verify-full") {
    throw new Error("Remote DATABASE_URL requires DATABASE_TLS_MODE=verify-full");
  }
  return { databaseTls: normalizedMode === "verify-full" };
}

export function readTrustedProxyAddresses(env: NodeJS.ProcessEnv): string[] | undefined {
  const value = env.TRUSTED_PROXY_ADDRESSES;
  const addresses = [...new Set((value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (addresses.length === 0) return undefined;
  if (addresses.some((address) => !isIP(address))) {
    throw new Error("TRUSTED_PROXY_ADDRESSES must contain only exact IPv4 or IPv6 addresses");
  }
  return addresses;
}

function parsePlanBudgets(value: string): Record<string, AccountModelBudget> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("AI_PLAN_BUDGETS_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error("AI_PLAN_BUDGETS_JSON must be a non-empty object");
  }
  return Object.fromEntries(Object.entries(parsed).map(([planKey, candidate]) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(planKey) || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("AI_PLAN_BUDGETS_JSON contains an invalid plan");
    }
    const values = candidate as Record<string, unknown>;
    if (Object.keys(values).some((key) => key !== "monthlyTokenLimit" && key !== "monthlyCostLimitUsd")
      || typeof values.monthlyTokenLimit !== "number" || typeof values.monthlyCostLimitUsd !== "string") {
      throw new Error(`AI_PLAN_BUDGETS_JSON.${planKey} requires only monthlyTokenLimit and monthlyCostLimitUsd`);
    }
    if (!Number.isSafeInteger(values.monthlyTokenLimit) || values.monthlyTokenLimit <= 0) {
      throw new Error(`AI_PLAN_BUDGETS_JSON.${planKey}.monthlyTokenLimit must be a positive integer`);
    }
    return [planKey, {
      monthlyTokenLimit: values.monthlyTokenLimit,
      monthlyCostLimitMicros: parseUsdMicros(values.monthlyCostLimitUsd, `AI_PLAN_BUDGETS_JSON.${planKey}.monthlyCostLimitUsd`),
    }];
  }));
}

export function readSyncRuntimeConfig(env: NodeJS.ProcessEnv): SyncRuntimeConfig | null {
  const connectionString = env.DATABASE_URL?.trim();
  const configuredOrigins = env.SYNC_ALLOWED_ORIGINS?.trim();
  const databasePoolValues = [
    env.DATABASE_POOL_MAX,
    env.DATABASE_CONNECTION_TIMEOUT_MS,
    env.DATABASE_IDLE_TIMEOUT_MS,
    env.DATABASE_STATEMENT_TIMEOUT_MS,
    env.DATABASE_QUERY_TIMEOUT_MS,
    env.DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
    env.DATABASE_MAX_LIFETIME_SECONDS,
    env.AUTH_MAX_ACTIVE_DEVICES,
    env.DATABASE_TLS_MODE,
  ];
  const budgetValues = [
    env.AI_MONTHLY_TOKEN_LIMIT,
    env.AI_MONTHLY_COST_LIMIT_USD,
    env.AI_INPUT_COST_PER_MILLION_USD,
    env.AI_OUTPUT_COST_PER_MILLION_USD,
  ];
  const globalBudgetValue = env.AI_GLOBAL_MONTHLY_COST_LIMIT_USD;
  const planBudgetsValue = env.AI_PLAN_BUDGETS_JSON?.trim();
  const entitlementValue = env.AI_SUBSCRIPTION_ENTITLEMENTS_REQUIRED?.trim();
  const oidcUpstreamTimeoutValue = env.OIDC_UPSTREAM_TIMEOUT_MS?.trim();
  if (entitlementValue && entitlementValue !== "true" && entitlementValue !== "false") {
    throw new Error("AI_SUBSCRIPTION_ENTITLEMENTS_REQUIRED must be true or false");
  }
  const requireSubscriptionEntitlement = entitlementValue === "true";
  if (!connectionString) {
    if (configuredOrigins || globalBudgetValue?.trim() || planBudgetsValue || requireSubscriptionEntitlement
      || oidcUpstreamTimeoutValue || budgetValues.some((value) => value?.trim())
      || databasePoolValues.some((value) => value?.trim())) {
      throw new Error("DATABASE_URL is required when database-dependent settings are configured");
    }
    return null;
  }
  const { databaseTls } = parseDatabaseConnection(connectionString, env.DATABASE_TLS_MODE);
  const sessionCookieName = env.SESSION_COOKIE_NAME?.trim();
  if (sessionCookieName && !/^[A-Za-z0-9_-]+$/.test(sessionCookieName)) {
    throw new Error("SESSION_COOKIE_NAME may contain only letters, digits, underscores, and hyphens");
  }
  const allowedOrigins = parseOrigins(configuredOrigins ?? "");
  const oidcValues = [env.OIDC_ISSUER, env.OIDC_CLIENT_ID, env.OIDC_REDIRECT_URI, env.OIDC_TRANSACTION_SECRET];
  const hasOidc = Boolean(oidcUpstreamTimeoutValue) || oidcValues.some((value) => Boolean(value?.trim()));
  let oidc: OidcConfig | undefined;
  if (hasOidc) {
    if (oidcValues.some((value) => !value?.trim())) {
      throw new Error("OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_REDIRECT_URI, and OIDC_TRANSACTION_SECRET must be configured together");
    }
    const issuer = env.OIDC_ISSUER!.trim().replace(/\/$/, "");
    const issuerUrl = new URL(issuer);
    const localIssuer = issuerUrl.hostname === "127.0.0.1" || issuerUrl.hostname === "localhost";
    if ((issuerUrl.protocol !== "https:" && !(localIssuer && issuerUrl.protocol === "http:"))
      || issuerUrl.username || issuerUrl.password
      || issuerUrl.origin + issuerUrl.pathname.replace(/\/$/, "") !== issuer) {
      throw new Error("OIDC_ISSUER must be an exact HTTPS URL (or local HTTP development URL) without credentials, query, or fragment");
    }
    const redirectUri = env.OIDC_REDIRECT_URI!.trim();
    const redirectUrl = new URL(redirectUri);
    const localRedirect = redirectUrl.hostname === "127.0.0.1" || redirectUrl.hostname === "localhost";
    if ((redirectUrl.protocol !== "https:" && !localRedirect) || redirectUrl.username || redirectUrl.password
      || redirectUrl.hash || redirectUrl.search || !redirectUrl.pathname.endsWith("/api/auth/callback")) {
      throw new Error("OIDC_REDIRECT_URI must be HTTPS (or local development), end with /api/auth/callback, and have no credentials, query, or fragment");
    }
    const transactionSecret = env.OIDC_TRANSACTION_SECRET!.trim();
    if (transactionSecret.length < 32) throw new Error("OIDC_TRANSACTION_SECRET must be at least 32 characters");
    const upstreamTimeoutMs = oidcUpstreamTimeoutValue
      ? parsePositiveInteger(oidcUpstreamTimeoutValue, "OIDC_UPSTREAM_TIMEOUT_MS")
      : undefined;
    if (upstreamTimeoutMs !== undefined && upstreamTimeoutMs > MAX_OIDC_UPSTREAM_TIMEOUT_MS) {
      throw new Error(`OIDC_UPSTREAM_TIMEOUT_MS must be no greater than ${MAX_OIDC_UPSTREAM_TIMEOUT_MS}`);
    }
    oidc = {
      issuer,
      clientId: env.OIDC_CLIENT_ID!.trim(),
      redirectUri,
      transactionSecret,
      ...(upstreamTimeoutMs === undefined ? {} : { upstreamTimeoutMs }),
    };
  }
  const hasModelBudget = budgetValues.some((value) => Boolean(value?.trim()));
  let modelUsagePolicy: ModelUsagePolicy | undefined;
  if (hasModelBudget) {
    if (budgetValues.some((value) => !value?.trim())) {
      throw new Error("AI_MONTHLY_TOKEN_LIMIT, AI_MONTHLY_COST_LIMIT_USD, AI_INPUT_COST_PER_MILLION_USD, and AI_OUTPUT_COST_PER_MILLION_USD must be configured together");
    }
    modelUsagePolicy = {
      monthlyTokenLimit: parsePositiveInteger(env.AI_MONTHLY_TOKEN_LIMIT!.trim(), "AI_MONTHLY_TOKEN_LIMIT"),
      monthlyCostLimitMicros: parseUsdMicros(env.AI_MONTHLY_COST_LIMIT_USD!.trim(), "AI_MONTHLY_COST_LIMIT_USD"),
      inputCostMicrosPerMillionTokens: parseUsdMicros(env.AI_INPUT_COST_PER_MILLION_USD!.trim(), "AI_INPUT_COST_PER_MILLION_USD"),
      outputCostMicrosPerMillionTokens: parseUsdMicros(env.AI_OUTPUT_COST_PER_MILLION_USD!.trim(), "AI_OUTPUT_COST_PER_MILLION_USD"),
      ...(planBudgetsValue ? { planBudgets: parsePlanBudgets(planBudgetsValue) } : {}),
      ...(globalBudgetValue?.trim()
        ? { globalMonthlyCostLimitMicros: parseUsdMicros(globalBudgetValue.trim(), "AI_GLOBAL_MONTHLY_COST_LIMIT_USD") }
        : {}),
    };
  } else if (globalBudgetValue?.trim() || planBudgetsValue) {
    throw new Error("AI_GLOBAL_MONTHLY_COST_LIMIT_USD and AI_PLAN_BUDGETS_JSON require the complete AI account budget configuration");
  }
  if (requireSubscriptionEntitlement && !modelUsagePolicy) {
    throw new Error("AI_SUBSCRIPTION_ENTITLEMENTS_REQUIRED requires the complete AI account budget configuration");
  }
  if (requireSubscriptionEntitlement && !modelUsagePolicy?.planBudgets) {
    throw new Error("AI_SUBSCRIPTION_ENTITLEMENTS_REQUIRED requires AI_PLAN_BUDGETS_JSON");
  }
  return {
    connectionString,
    databaseTls,
    allowedOrigins,
    maxActiveDevices: env.AUTH_MAX_ACTIVE_DEVICES?.trim()
      ? parseBoundedPositiveInteger(
        env.AUTH_MAX_ACTIVE_DEVICES.trim(),
        "AUTH_MAX_ACTIVE_DEVICES",
        RUNTIME_RESOURCE_LIMITS.activeDevicesPerAccount,
      )
      : DEFAULT_MAX_ACTIVE_DEVICES,
    ...(sessionCookieName ? { sessionCookieName } : {}),
    ...(oidc ? { oidc } : {}),
    ...(modelUsagePolicy ? { modelUsagePolicy } : {}),
    ...(requireSubscriptionEntitlement ? { requireSubscriptionEntitlement: true } : {}),
  };
}

export function createSyncRuntime(
  env: NodeJS.ProcessEnv,
  createPool: (connectionString: string, config: PoolConfig) => Pool = (_connectionString, config) => new pg.Pool(config),
): SyncRuntime {
  const config = readSyncRuntimeConfig(env);
  if (!config) return { appOptions: {}, close: async () => undefined };

  const databasePoolConfig = readDatabasePoolConfig(env);
  const pool = createPool(config.connectionString, toPoolConfig(config.connectionString, databasePoolConfig, config.databaseTls));
  const sessions = new PostgresSessionPrincipalResolver(pool, config.sessionCookieName);
  const sessionLifecycle = new PostgresSessionLifecycle(pool, undefined, undefined, undefined, undefined, config.maxActiveDevices);
  return {
    appOptions: {
      syncStore: new PostgresSyncStore(pool),
      resolvePrincipal: sessions.resolve,
      allowedSyncOrigins: config.allowedOrigins,
      sessionLifecycle,
      accountDataLifecycle: sessionLifecycle,
      sessionCookieName: config.sessionCookieName,
      oidcAuthenticator: config.oidc ? new StandardOidcClient(config.oidc) : undefined,
      rateLimiter: new PostgresFixedWindowRateLimiter(pool),
      auditSink: new JsonLineSecurityAuditSink(),
      requestLogSink: new JsonLineRequestLogSink(),
      databasePoolCapacity: new PostgresPoolCapacityMonitor(pool, databasePoolConfig.max),
      capacityMonitor: new RollingRequestCapacityMonitor(),
      modelUsageLedger: config.modelUsagePolicy ? new PostgresModelUsageLedger(pool, config.modelUsagePolicy) : undefined,
      subscriptionEntitlements: config.requireSubscriptionEntitlement
        ? new PostgresSubscriptionEntitlementResolver(pool)
        : undefined,
      readinessCheck: async () => {
        let timeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            pool.query("SELECT 1"),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => {
                const error = new Error("Database readiness check timed out");
                error.name = "ReadinessTimeoutError";
                reject(error);
              }, 5_000);
              timeout.unref();
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      },
    },
    close: () => pool.end(),
  };
}
