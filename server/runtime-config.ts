import pg, { type Pool } from "pg";
import type { AppOptions } from "./app";
import { PostgresSessionPrincipalResolver } from "./auth/postgres-session-resolver";
import { PostgresSessionLifecycle } from "./auth/postgres-session-lifecycle";
import { PostgresSyncStore } from "./sync/postgres-sync-store";

export interface SyncRuntime {
  appOptions: AppOptions;
  close(): Promise<void>;
}

export interface SyncRuntimeConfig {
  connectionString: string;
  allowedOrigins: string[];
  sessionCookieName?: string;
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
  return {
    connectionString,
    allowedOrigins: parseOrigins(configuredOrigins ?? ""),
    ...(sessionCookieName ? { sessionCookieName } : {}),
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
    },
    close: () => pool.end(),
  };
}
