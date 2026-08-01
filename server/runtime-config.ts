import pg, { type Pool } from "pg";
import type { AppOptions } from "./app";
import { PostgresSessionPrincipalResolver } from "./auth/postgres-session-resolver";
import { PostgresSessionLifecycle } from "./auth/postgres-session-lifecycle";
import { StandardOidcClient, type OidcConfig } from "./auth/oidc-client";
import { PostgresSyncStore } from "./sync/postgres-sync-store";

export interface SyncRuntime {
  appOptions: AppOptions;
  close(): Promise<void>;
}

export interface SyncRuntimeConfig {
  connectionString: string;
  allowedOrigins: string[];
  sessionCookieName?: string;
  oidc?: OidcConfig;
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

export function readSyncRuntimeConfig(env: NodeJS.ProcessEnv): SyncRuntimeConfig | null {
  const connectionString = env.DATABASE_URL?.trim();
  const configuredOrigins = env.SYNC_ALLOWED_ORIGINS?.trim();
  if (!connectionString) {
    if (configuredOrigins) throw new Error("DATABASE_URL is required when SYNC_ALLOWED_ORIGINS is configured");
    return null;
  }
  const sessionCookieName = env.SESSION_COOKIE_NAME?.trim();
  if (sessionCookieName && !/^[A-Za-z0-9_-]+$/.test(sessionCookieName)) {
    throw new Error("SESSION_COOKIE_NAME may contain only letters, digits, underscores, and hyphens");
  }
  const allowedOrigins = parseOrigins(configuredOrigins ?? "");
  const oidcValues = [env.OIDC_ISSUER, env.OIDC_CLIENT_ID, env.OIDC_REDIRECT_URI, env.OIDC_TRANSACTION_SECRET];
  const hasOidc = oidcValues.some((value) => Boolean(value?.trim()));
  let oidc: OidcConfig | undefined;
  if (hasOidc) {
    if (oidcValues.some((value) => !value?.trim())) {
      throw new Error("OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_REDIRECT_URI, and OIDC_TRANSACTION_SECRET must be configured together");
    }
    const issuer = env.OIDC_ISSUER!.trim().replace(/\/$/, "");
    const issuerUrl = new URL(issuer);
    if (issuerUrl.protocol !== "https:" || issuerUrl.origin + issuerUrl.pathname.replace(/\/$/, "") !== issuer) {
      throw new Error("OIDC_ISSUER must be an exact HTTPS URL without query or fragment");
    }
    const redirectUri = env.OIDC_REDIRECT_URI!.trim();
    const redirectUrl = new URL(redirectUri);
    const localRedirect = redirectUrl.hostname === "127.0.0.1" || redirectUrl.hostname === "localhost";
    if ((redirectUrl.protocol !== "https:" && !localRedirect) || redirectUrl.hash || redirectUrl.search || !redirectUrl.pathname.endsWith("/api/auth/callback")) {
      throw new Error("OIDC_REDIRECT_URI must be HTTPS (or local development), end with /api/auth/callback, and have no query or fragment");
    }
    const transactionSecret = env.OIDC_TRANSACTION_SECRET!.trim();
    if (transactionSecret.length < 32) throw new Error("OIDC_TRANSACTION_SECRET must be at least 32 characters");
    oidc = { issuer, clientId: env.OIDC_CLIENT_ID!.trim(), redirectUri, transactionSecret };
  }
  return {
    connectionString,
    allowedOrigins,
    ...(sessionCookieName ? { sessionCookieName } : {}),
    ...(oidc ? { oidc } : {}),
  };
}

export function createSyncRuntime(
  env: NodeJS.ProcessEnv,
  createPool: (connectionString: string) => Pool = (connectionString) => new pg.Pool({ connectionString }),
): SyncRuntime {
  const config = readSyncRuntimeConfig(env);
  if (!config) return { appOptions: {}, close: async () => undefined };

  const pool = createPool(config.connectionString);
  const sessions = new PostgresSessionPrincipalResolver(pool, config.sessionCookieName);
  const sessionLifecycle = new PostgresSessionLifecycle(pool);
  return {
    appOptions: {
      syncStore: new PostgresSyncStore(pool),
      resolvePrincipal: sessions.resolve,
      allowedSyncOrigins: config.allowedOrigins,
      sessionLifecycle,
      sessionCookieName: config.sessionCookieName,
      oidcAuthenticator: config.oidc ? new StandardOidcClient(config.oidc) : undefined,
    },
    close: () => pool.end(),
  };
}
