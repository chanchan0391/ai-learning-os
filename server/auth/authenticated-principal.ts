import type { IncomingMessage } from "node:http";
import type { SyncPrincipal } from "../sync/sync-store";

/**
 * Authentication boundary used by protected API routes.
 *
 * The OIDC/session adapter owns cookie verification and device lookup. Route
 * handlers receive only the trusted principal returned by this resolver and
 * never accept user or device IDs from request data.
 */
export type AuthenticatedPrincipalResolver = (
  request: IncomingMessage,
) => SyncPrincipal | null | Promise<SyncPrincipal | null>;
