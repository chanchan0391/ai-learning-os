import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Pool, QueryResultRow } from "pg";
import type { AuthenticatedPrincipalResolver } from "./authenticated-principal";

export const DEFAULT_SESSION_COOKIE_NAME = "__Host-ai_learning_os_session";
export const LEGACY_SESSION_COOKIE_NAME = "ai_learning_os_session";
export const DEFAULT_SESSION_COOKIE_NAMES = [DEFAULT_SESSION_COOKIE_NAME, LEGACY_SESSION_COOKIE_NAME] as const;
const MAX_SESSION_TOKEN_LENGTH = 512;

interface SessionRow extends QueryResultRow {
  user_id: string;
  device_id: string;
}

export function readSessionToken(
  header: string | undefined,
  names: string | readonly string[] = DEFAULT_SESSION_COOKIE_NAMES,
): string | null {
  if (!header) return null;
  for (const name of typeof names === "string" ? [names] : names) {
    const values = new Set<string>();
    for (const part of header.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
      const value = part.slice(separator + 1).trim();
      if (!value || value.length > MAX_SESSION_TOKEN_LENGTH) return null;
      values.add(value);
    }
    if (values.size > 1) return null;
    if (values.size === 1) return values.values().next().value ?? null;
  }
  return null;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Resolves an opaque browser session without ever storing its bearer token.
 * OIDC routes will create and rotate these records; protected routes only see
 * the user/device principal produced after expiry and revocation checks.
 */
export class PostgresSessionPrincipalResolver {
  constructor(
    private readonly pool: Pool,
    private readonly cookieNames: string | readonly string[] = DEFAULT_SESSION_COOKIE_NAMES,
    private readonly now: () => Date = () => new Date(),
  ) {}

  readonly resolve: AuthenticatedPrincipalResolver = async (request: IncomingMessage) => {
    const token = readSessionToken(request.headers.cookie, this.cookieNames);
    if (!token) return null;
    const result = await this.pool.query<SessionRow>(
      `SELECT s.user_id, s.device_id
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
         JOIN sync_devices d ON d.user_id = s.user_id AND d.id = s.device_id
        WHERE s.token_hash = $1
          AND s.expires_at > $2
          AND s.revoked_at IS NULL
          AND u.deleted_at IS NULL
          AND d.revoked_at IS NULL`,
      [hashSessionToken(token), this.now().toISOString()],
    );
    if (result.rowCount !== 1) return null;
    return { userId: result.rows[0].user_id, deviceId: result.rows[0].device_id };
  };
}
