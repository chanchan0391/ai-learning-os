import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { EvaluationRequest, LearningGoal, TeachingSessionRequest } from "../src/types";
import { isDailyRecord, isLearningPlan } from "../src/learning-state";
import { AgentOutputError } from "./agents/agent-errors";
import { createEvaluatorAgent } from "./agents/evaluator-agent";
import { createPlannerAgent } from "./agents/planner-agent";
import { createTeacherAgent } from "./agents/teacher-agent";
import { ModelProviderError, type ModelProvider } from "./ai/model-provider";
import type { AuthenticatedPrincipalResolver } from "./auth/authenticated-principal";
import type { OidcAuthenticator } from "./auth/oidc-client";
import type { AccountDataLifecycle, SessionLifecycle } from "./auth/postgres-session-lifecycle";
import { DEFAULT_SESSION_COOKIE_NAME, readSessionToken } from "./auth/postgres-session-resolver";
import {
  InMemoryFixedWindowRateLimiter,
  RollingRequestCapacityMonitor,
  auditOutcome,
  clientRateLimitKey,
  principalFields,
  type RateLimitPolicy,
  type RequestRateLimiter,
  type RequestCapacityMonitor,
  type SecurityAuditEvent,
  type SecurityAuditSink,
} from "./security/request-security";
import {
  SyncConflictError,
  SyncRequestError,
  type DailyRecordSyncValue,
  type SyncStore,
  type SyncWriteRequest,
} from "./sync/sync-store";

const MAX_BODY_BYTES = 1_000_000;

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

export interface AppOptions {
  syncStore?: SyncStore;
  resolvePrincipal?: AuthenticatedPrincipalResolver;
  allowedSyncOrigins?: readonly string[];
  sessionLifecycle?: SessionLifecycle;
  accountDataLifecycle?: AccountDataLifecycle;
  sessionCookieName?: string;
  oidcAuthenticator?: OidcAuthenticator;
  rateLimiter?: RequestRateLimiter;
  auditSink?: SecurityAuditSink;
  capacityMonitor?: RequestCapacityMonitor;
}

interface ProtectedRoute {
  action: string;
  rateLimitScope: string;
  policy: RateLimitPolicy;
}

function protectedRoute(method: string | undefined, pathname: string): ProtectedRoute | null {
  if (pathname === "/api/auth/login") return { action: "auth.login", rateLimitScope: "auth-login", policy: { limit: 20, windowMs: 60_000 } };
  if (pathname === "/api/auth/callback") return { action: "auth.callback", rateLimitScope: "auth-callback", policy: { limit: 20, windowMs: 60_000 } };
  if (pathname === "/api/auth/session/refresh") return { action: "auth.session.refresh", rateLimitScope: "auth-session", policy: { limit: 60, windowMs: 60_000 } };
  if (pathname === "/api/auth/logout") return { action: "auth.logout", rateLimitScope: "auth-session", policy: { limit: 60, windowMs: 60_000 } };
  if (pathname === "/api/auth/logout-all") return { action: "auth.logout-all", rateLimitScope: "auth-account", policy: { limit: 5, windowMs: 60_000 } };
  if (pathname === "/api/auth/devices") return { action: "auth.devices.read", rateLimitScope: "auth-session", policy: { limit: 120, windowMs: 60_000 } };
  if (pathname.startsWith("/api/auth/devices/")) return { action: "auth.device.revoke", rateLimitScope: "auth-account", policy: { limit: 20, windowMs: 60_000 } };
  if (pathname === "/api/auth/account") return { action: "auth.account.delete", rateLimitScope: "auth-account", policy: { limit: 5, windowMs: 60_000 } };
  if (pathname === "/api/auth/session") return { action: "auth.session.read", rateLimitScope: "auth-session", policy: { limit: 120, windowMs: 60_000 } };
  if (pathname.startsWith("/api/sync/")) {
    const write = method !== "GET";
    return {
      action: write ? "sync.write" : "sync.read",
      rateLimitScope: write ? "sync-write" : "sync-read",
      policy: { limit: write ? 60 : 120, windowMs: 60_000 },
    };
  }
  return null;
}

function sessionCookie(name: string, token?: string, maxAgeSeconds?: number): string {
  const value = token ? `${name}=${token}` : `${name}=`;
  const age = maxAgeSeconds === undefined ? "" : `; Max-Age=${maxAgeSeconds}`;
  return `${value}; Path=/; HttpOnly; Secure; SameSite=Lax${age}`;
}

function transientCookie(name: string, value?: string): string {
  const maxAge = value ? "; Max-Age=600" : "; Max-Age=0";
  return `${name}=${value ?? ""}; Path=/api/auth/callback; HttpOnly; Secure; SameSite=Lax${maxAge}`;
}

function requireHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name.toLowerCase()];
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} header is required`);
  if (value.length > 200) throw new TypeError(`${name} header is too long`);
  return value;
}

function parseBaseRevision(request: IncomingMessage): number | null {
  const ifMatch = request.headers["if-match"];
  const ifNoneMatch = request.headers["if-none-match"];
  if (ifMatch && ifNoneMatch) throw new TypeError("Use either If-Match or If-None-Match, not both");
  if (ifNoneMatch === "*") return null;
  if (ifNoneMatch) throw new TypeError("If-None-Match must be * when creating an entity");
  if (typeof ifMatch === "string") {
    const match = /^\"([1-9]\d*)\"$/.exec(ifMatch);
    if (match) return Number(match[1]);
    throw new TypeError('If-Match must be a quoted positive revision, for example "1"');
  }
  const error = new Error("A write precondition is required");
  error.name = "PreconditionRequiredError";
  throw error;
}

function requireAllowedOrigin(request: IncomingMessage, allowedOrigins: readonly string[] | undefined): void {
  if (!allowedOrigins?.length) {
    const error = new Error("Sync write origins are not configured");
    error.name = "SyncConfigurationError";
    throw error;
  }
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !allowedOrigins.includes(origin)) {
    const error = new Error("Request origin is not allowed");
    error.name = "ForbiddenOriginError";
    throw error;
  }
}

function entityIdFromPath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return null;
  try {
    const id = decodeURIComponent(encoded);
    return id.trim() ? id : null;
  } catch {
    throw new TypeError("Entity ID is not valid URL encoding");
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RangeError("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createApp(provider: ModelProvider, options: AppOptions = {}) {
  const planner = createPlannerAgent(provider);
  const teacher = createTeacherAgent(provider);
  const evaluator = createEvaluatorAgent(provider);
  const rateLimiter = options.rateLimiter ?? new InMemoryFixedWindowRateLimiter();
  const capacityMonitor = options.capacityMonitor ?? new RollingRequestCapacityMonitor();
  return createServer(async (request, response) => {
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = protectedRoute(request.method, url.pathname);
    let auditPrincipal: { userId: string; deviceId: string } | null = null;
    let auditReason: string | undefined;
    const completeCapacity = route ? capacityMonitor.start(route.rateLimitScope) : null;
    if (completeCapacity) {
      response.once("finish", () => completeCapacity(response.statusCode, auditReason === "rate-limit-exceeded"));
    }
    if (route && options.auditSink) {
      response.once("finish", () => {
        const event: SecurityAuditEvent = {
          occurredAt: new Date().toISOString(),
          action: route.action,
          method: request.method ?? "UNKNOWN",
          path: url.pathname,
          status: response.statusCode,
          outcome: auditOutcome(response.statusCode),
          ...(auditReason ? { reason: auditReason } : {}),
          ...principalFields(auditPrincipal),
        };
        try {
          const recorded = options.auditSink!.record(event);
          if (recorded && "catch" in recorded) void recorded.catch((error) => console.error("Security audit sink failed", error));
        } catch (error) {
          console.error("Security audit sink failed", error);
        }
      });
    }
    try {
      if (route) {
        const decision = await rateLimiter.consume(route.rateLimitScope, clientRateLimitKey(request), route.policy);
        response.setHeader("RateLimit-Limit", String(decision.limit));
        response.setHeader("RateLimit-Remaining", String(decision.remaining));
        response.setHeader("RateLimit-Reset", String(Math.ceil(decision.resetAt / 1000)));
        if (!decision.allowed) {
          auditReason = "rate-limit-exceeded";
          const retryAfter = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
          return sendJson(response, 429, { error: "Too many requests" }, { "Retry-After": String(retryAfter) });
        }
      }
      if (request.method === "GET" && request.url === "/api/health") {
        return sendJson(response, 200, {
          status: "ok",
          provider: provider.id,
          aiEnabled: provider.isAiEnabled,
          syncEnabled: Boolean(options.syncStore && options.resolvePrincipal),
          capacity: capacityMonitor.snapshot(),
        });
      }
      if (request.method === "POST" && request.url === "/api/plans") {
        const goal = await readJson(request) as LearningGoal;
        return sendJson(response, 201, await planner.createPlan(goal, new Date(), controller.signal));
      }
      if (request.method === "POST" && request.url === "/api/teaching-sessions") {
        const teachingRequest = await readJson(request) as TeachingSessionRequest;
        return sendJson(response, 201, await teacher.createSession(teachingRequest, controller.signal));
      }
      if (request.method === "POST" && request.url === "/api/evaluations") {
        const evaluationRequest = await readJson(request) as EvaluationRequest;
        return sendJson(response, 201, await evaluator.evaluate(evaluationRequest, controller.signal));
      }
      if (url.pathname.startsWith("/api/auth/")) {
        if (!options.resolvePrincipal || !options.sessionLifecycle) {
          return sendJson(response, 503, { error: "Authentication is not configured" });
        }
        const cookieName = options.sessionCookieName ?? DEFAULT_SESSION_COOKIE_NAME;
        if (request.method === "GET" && url.pathname === "/api/auth/login") {
          if (!options.oidcAuthenticator) return sendJson(response, 503, { error: "OIDC login is not configured" });
          const authorization = await options.oidcAuthenticator.begin(url.searchParams.get("returnTo") ?? undefined);
          response.writeHead(302, {
            Location: authorization.authorizationUrl,
            "Cache-Control": "no-store",
            "Set-Cookie": transientCookie(options.oidcAuthenticator.transactionCookieName, authorization.transactionCookie),
          });
          return response.end();
        }
        if (request.method === "GET" && url.pathname === "/api/auth/callback") {
          if (!options.oidcAuthenticator) return sendJson(response, 503, { error: "OIDC login is not configured" });
          const callback = await options.oidcAuthenticator.complete(
            url,
            request.headers.cookie,
            typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : "Browser",
          );
          const issued = await options.sessionLifecycle.establishFromOidc(callback.identity);
          auditPrincipal = { userId: issued.userId, deviceId: issued.deviceId };
          const maxAge = Math.max(0, Math.floor((Date.parse(issued.expiresAt) - Date.now()) / 1000));
          response.writeHead(302, {
            Location: callback.returnTo,
            "Cache-Control": "no-store",
            "Set-Cookie": [
              sessionCookie(cookieName, issued.token, maxAge),
              transientCookie(options.oidcAuthenticator.transactionCookieName),
            ],
          });
          return response.end();
        }
        if (request.method === "GET" && url.pathname === "/api/auth/session") {
          const principal = await options.resolvePrincipal(request);
          auditPrincipal = principal;
          if (!principal) auditReason = "authentication-required";
          return principal ? sendJson(response, 200, { authenticated: true, principal })
            : sendJson(response, 401, { authenticated: false });
        }
        if (request.method === "POST" && url.pathname === "/api/auth/session/refresh") {
          requireAllowedOrigin(request, options.allowedSyncOrigins);
          const token = readSessionToken(request.headers.cookie, cookieName);
          const rotated = token ? await options.sessionLifecycle.rotate(token) : null;
          if (!rotated) {
            auditReason = "authentication-required";
            return sendJson(response, 401, { error: "Authentication required" }, {
            "Set-Cookie": sessionCookie(cookieName, undefined, 0),
            });
          }
          auditPrincipal = { userId: rotated.userId, deviceId: rotated.deviceId };
          const maxAge = Math.max(0, Math.floor((Date.parse(rotated.expiresAt) - Date.now()) / 1000));
          return sendJson(response, 200, { authenticated: true, principal: { userId: rotated.userId, deviceId: rotated.deviceId } }, {
            "Set-Cookie": sessionCookie(cookieName, rotated.token, maxAge),
          });
        }
        if (request.method === "POST" && url.pathname === "/api/auth/logout") {
          requireAllowedOrigin(request, options.allowedSyncOrigins);
          auditPrincipal = await options.resolvePrincipal(request);
          const token = readSessionToken(request.headers.cookie, cookieName);
          if (token) await options.sessionLifecycle.revoke(token);
          return sendJson(response, 200, { authenticated: false }, {
            "Set-Cookie": sessionCookie(cookieName, undefined, 0),
          });
        }
        if (request.method === "POST" && url.pathname === "/api/auth/logout-all") {
          requireAllowedOrigin(request, options.allowedSyncOrigins);
          const principal = await options.resolvePrincipal(request);
          const token = readSessionToken(request.headers.cookie, cookieName);
          if (!principal || !token) {
            auditReason = "authentication-required";
            return sendJson(response, 401, { error: "Authentication required" }, {
              "Set-Cookie": sessionCookie(cookieName, undefined, 0),
            });
          }
          auditPrincipal = principal;
          const revoked = await options.sessionLifecycle.revokeAll(token);
          if (!revoked) {
            auditReason = "authentication-required";
            return sendJson(response, 401, { error: "Authentication required" }, {
              "Set-Cookie": sessionCookie(cookieName, undefined, 0),
            });
          }
          return sendJson(response, 200, { authenticated: false, revokedAll: true }, {
            "Set-Cookie": sessionCookie(cookieName, undefined, 0),
          });
        }
        if (request.method === "GET" && url.pathname === "/api/auth/devices") {
          const principal = await options.resolvePrincipal(request);
          const token = readSessionToken(request.headers.cookie, cookieName);
          if (!principal || !token) {
            auditReason = "authentication-required";
            return sendJson(response, 401, { error: "Authentication required" });
          }
          auditPrincipal = principal;
          const devices = await options.sessionLifecycle.listActiveDevices(token);
          if (!devices) {
            auditReason = "authentication-required";
            return sendJson(response, 401, { error: "Authentication required" });
          }
          return sendJson(response, 200, { devices });
        }
        const targetDeviceId = entityIdFromPath(url.pathname, "/api/auth/devices/");
        if (request.method === "DELETE" && targetDeviceId) {
          requireAllowedOrigin(request, options.allowedSyncOrigins);
          const principal = await options.resolvePrincipal(request);
          const token = readSessionToken(request.headers.cookie, cookieName);
          if (!principal || !token) {
            auditReason = "authentication-required";
            return sendJson(response, 401, { error: "Authentication required" });
          }
          auditPrincipal = principal;
          const revoked = await options.sessionLifecycle.revokeDevice(token, targetDeviceId);
          if (!revoked) {
            auditReason = "device-not-found";
            return sendJson(response, 404, { error: "Active device not found" });
          }
          const revokedCurrent = targetDeviceId === principal.deviceId;
          return sendJson(response, 200, { revoked: true, revokedCurrent }, revokedCurrent ? {
            "Set-Cookie": sessionCookie(cookieName, undefined, 0),
          } : {});
        }
        if (request.method === "DELETE" && url.pathname === "/api/auth/account") {
          requireAllowedOrigin(request, options.allowedSyncOrigins);
          if (!options.accountDataLifecycle) return sendJson(response, 503, { error: "Account deletion is not configured" });
          const principal = await options.resolvePrincipal(request);
          const token = readSessionToken(request.headers.cookie, cookieName);
          if (!principal || !token) {
            auditReason = "authentication-required";
            return sendJson(response, 401, { error: "Authentication required" }, {
              "Set-Cookie": sessionCookie(cookieName, undefined, 0),
            });
          }
          auditPrincipal = principal;
          const deleted = await options.accountDataLifecycle.deleteAccount(token);
          if (!deleted) {
            auditReason = "authentication-required";
            return sendJson(response, 401, { error: "Authentication required" }, {
              "Set-Cookie": sessionCookie(cookieName, undefined, 0),
            });
          }
          return sendJson(response, 200, { deleted: true }, {
            "Set-Cookie": sessionCookie(cookieName, undefined, 0),
          });
        }
      }
      if (url.pathname.startsWith("/api/sync/")) {
        if (!options.syncStore || !options.resolvePrincipal) {
          return sendJson(response, 503, { error: "Sync is not configured" });
        }
        const principal = await options.resolvePrincipal(request);
        if (!principal) {
          auditReason = "authentication-required";
          return sendJson(response, 401, { error: "Authentication required" });
        }
        auditPrincipal = principal;

        if (request.method === "GET" && url.pathname === "/api/sync/changes") {
          const cursor = url.searchParams.get("cursor") ?? undefined;
          const result = await options.syncStore.getChanges(principal, cursor);
          return sendJson(response, 200, result);
        }

        const planId = entityIdFromPath(url.pathname, "/api/sync/plans/");
        if (request.method === "PUT" && planId) {
          requireAllowedOrigin(request, options.allowedSyncOrigins);
          const value = await readJson(request);
          if (!isLearningPlan(value) || value.id !== planId) throw new TypeError("Body must be a valid learning plan matching the route ID");
          const write: SyncWriteRequest<typeof value> = {
            operationId: requireHeader(request, "Idempotency-Key"),
            entityId: planId,
            baseRevision: parseBaseRevision(request),
            value,
          };
          const result = await options.syncStore.putPlan(principal, write);
          return sendJson(response, 200, result, { ETag: `\"${result.revision}\"` });
        }

        const recordId = entityIdFromPath(url.pathname, "/api/sync/daily-records/");
        if (request.method === "PUT" && recordId) {
          requireAllowedOrigin(request, options.allowedSyncOrigins);
          const value = await readJson(request) as Partial<DailyRecordSyncValue>;
          if (typeof value.planId !== "string" || !value.planId.trim() || !isDailyRecord(value.record)) {
            throw new TypeError("Body must contain a valid planId and daily record");
          }
          const write: SyncWriteRequest<DailyRecordSyncValue> = {
            operationId: requireHeader(request, "Idempotency-Key"),
            entityId: recordId,
            baseRevision: parseBaseRevision(request),
            value: { planId: value.planId, record: value.record },
          };
          const result = await options.syncStore.putDailyRecord(principal, write);
          return sendJson(response, 200, result, { ETag: `\"${result.revision}\"` });
        }
      }
      return sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof Error) auditReason = error.name;
      if (error instanceof SyncConflictError) {
        auditReason = error.code;
        return sendJson(response, 409, { error: error.code, current: error.current });
      }
      if (error instanceof SyncRequestError) {
        const status = error.code === "idempotency-mismatch" ? 409
          : error.code === "missing-plan" ? 422
            : error.code === "unknown-principal" ? 401 : 400;
        return sendJson(response, status, { error: error.code, message: error.message });
      }
      if (error instanceof Error && error.name === "SyncConfigurationError") return sendJson(response, 503, { error: error.message });
      if (error instanceof Error && error.name === "ForbiddenOriginError") return sendJson(response, 403, { error: error.message });
      if (error instanceof Error && error.name === "PreconditionRequiredError") return sendJson(response, 428, { error: error.message });
      if (error instanceof SyntaxError || error instanceof TypeError) return sendJson(response, 400, { error: error.message });
      if (error instanceof RangeError) return sendJson(response, 413, { error: error.message });
      if (error instanceof AgentOutputError) return sendJson(response, 502, { error: error.message });
      if (error instanceof ModelProviderError) return sendJson(response, error.status, { error: error.message, requestId: error.requestId });
      console.error("Unexpected API error", error);
      return sendJson(response, 500, { error: "Internal server error" });
    }
  });
}
