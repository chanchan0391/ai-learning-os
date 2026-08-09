import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { EvaluationRequest, LearningGoal, RecoveryPlanRequest, ReviewAssessmentRequest, TeachingSessionRequest } from "../src/types";
import { isDailyRecord, isLearningPlan } from "../src/learning-state";
import { AgentOutputError } from "./agents/agent-errors";
import { createEvaluatorAgent } from "./agents/evaluator-agent";
import { createCoachAgent } from "./agents/coach-agent";
import { createPlannerAgent } from "./agents/planner-agent";
import { createTeacherAgent } from "./agents/teacher-agent";
import { createReviewAgent } from "./agents/review-agent";
import { ModelProviderError, type ModelProvider } from "./ai/model-provider";
import { MeteredModelProvider, type ModelUsageLedger } from "./ai/model-usage";
import type { AuthenticatedPrincipalResolver } from "./auth/authenticated-principal";
import type { OidcAuthenticator } from "./auth/oidc-client";
import { AuthDeviceLimitError, type AccountDataLifecycle, type SessionLifecycle } from "./auth/postgres-session-lifecycle";
import { DEFAULT_SESSION_COOKIE_NAME, readSessionToken } from "./auth/postgres-session-resolver";
import type { SubscriptionEntitlementResolver } from "./billing/subscription-entitlement";
import type { DatabasePoolCapacityMonitor } from "./observability/database-capacity";
import { requestOutcome, type RequestLogEvent, type RequestLogSink } from "./observability/request-observability";
import { coalesceReadinessCheck } from "./observability/readiness-check";
import {
  InMemoryFixedWindowRateLimiter,
  InMemoryConcurrencyLimiter,
  RollingRequestCapacityMonitor,
  auditOutcome,
  clientRateLimitKey,
  principalFields,
  type RateLimitPolicy,
  type RequestRateLimiter,
  type RequestCapacityMonitor,
  type RequestConcurrencyLimiter,
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
const MAX_AGENT_BODY_BYTES = 64 * 1_024;
export const DEFAULT_AGENT_CONCURRENCY_LIMIT = 20;
const BROWSER_SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

const STATIC_OBSERVABILITY_PATHS = new Set([
  "/api/health",
  "/api/plans",
  "/api/teaching-sessions",
  "/api/evaluations",
  "/api/review-assessments",
  "/api/recovery-plans",
  "/api/auth/login",
  "/api/auth/callback",
  "/api/auth/session",
  "/api/auth/session/refresh",
  "/api/auth/logout",
  "/api/auth/logout-all",
  "/api/auth/devices",
  "/api/auth/account",
  "/api/sync/changes",
]);

/** Returns a bounded route label without retaining user-controlled path segments. */
export function observabilityPath(pathname: string): string {
  if (STATIC_OBSERVABILITY_PATHS.has(pathname)) return pathname;
  if (pathname.startsWith("/api/auth/devices/")) return "/api/auth/devices/:deviceId";
  if (pathname.startsWith("/api/sync/plans/")) return "/api/sync/plans/:planId";
  if (pathname.startsWith("/api/sync/daily-records/")) return "/api/sync/daily-records/:recordId";
  return "/unmatched";
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

function onResponseSettled(
  response: ServerResponse,
  callback: (status: number, clientDisconnected: boolean) => void,
): void {
  let settled = false;
  const settle = (clientDisconnected: boolean) => {
    if (settled) return;
    settled = true;
    callback(clientDisconnected ? 499 : response.statusCode, clientDisconnected);
  };
  response.once("finish", () => settle(false));
  response.once("close", () => settle(!response.writableFinished));
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
  agentConcurrencyLimiter?: RequestConcurrencyLimiter;
  modelUsageLedger?: ModelUsageLedger;
  subscriptionEntitlements?: SubscriptionEntitlementResolver;
  requestLogSink?: RequestLogSink;
  readinessCheck?: () => Promise<void>;
  databasePoolCapacity?: DatabasePoolCapacityMonitor;
  trustedProxyAddresses?: readonly string[];
}

interface ProtectedRoute {
  action: string;
  rateLimitScope: string;
  policy: RateLimitPolicy;
}

function protectedRoute(method: string | undefined, pathname: string): ProtectedRoute | null {
  if (method === "POST" && pathname === "/api/plans") return { action: "ai.plan.create", rateLimitScope: "ai-plan", policy: { limit: 10, windowMs: 60_000 } };
  if (method === "POST" && pathname === "/api/teaching-sessions") return { action: "ai.teaching.create", rateLimitScope: "ai-teaching", policy: { limit: 30, windowMs: 60_000 } };
  if (method === "POST" && pathname === "/api/evaluations") return { action: "ai.evaluation.create", rateLimitScope: "ai-evaluation", policy: { limit: 30, windowMs: 60_000 } };
  if (method === "POST" && pathname === "/api/review-assessments") return { action: "ai.review.create", rateLimitScope: "ai-review", policy: { limit: 30, windowMs: 60_000 } };
  if (method === "POST" && pathname === "/api/recovery-plans") return { action: "ai.recovery.create", rateLimitScope: "ai-recovery", policy: { limit: 20, windowMs: 60_000 } };
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

async function readJson(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    const error = new Error("Content-Type must be application/json");
    error.name = "UnsupportedMediaTypeError";
    throw error;
  }
  const declaredSize = request.headers["content-length"];
  if (typeof declaredSize === "string" && Number(declaredSize) > maxBytes) {
    throw new RangeError("Request body is too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new RangeError("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createApp(provider: ModelProvider, options: AppOptions = {}) {
  if (options.subscriptionEntitlements && !options.modelUsageLedger) {
    throw new Error("Subscription entitlement enforcement requires account model budgets");
  }
  const meteredProvider = options.modelUsageLedger ? new MeteredModelProvider(provider, options.modelUsageLedger) : null;
  const agentProvider = meteredProvider ?? provider;
  const planner = createPlannerAgent(agentProvider);
  const teacher = createTeacherAgent(agentProvider);
  const evaluator = createEvaluatorAgent(agentProvider);
  const coach = createCoachAgent(agentProvider);
  const reviewer = createReviewAgent(agentProvider);
  const rateLimiter = options.rateLimiter ?? new InMemoryFixedWindowRateLimiter();
  const capacityMonitor = options.capacityMonitor ?? new RollingRequestCapacityMonitor();
  const agentConcurrencyLimiter = options.agentConcurrencyLimiter ?? new InMemoryConcurrencyLimiter(DEFAULT_AGENT_CONCURRENCY_LIMIT);
  const readinessCheck = options.readinessCheck ? coalesceReadinessCheck(options.readinessCheck) : null;
  return createServer(async (request, response) => {
    const requestId = randomUUID();
    const requestStartedAt = Date.now();
    response.setHeader("X-Request-Id", requestId);
    for (const [name, value] of Object.entries(BROWSER_SECURITY_HEADERS)) response.setHeader(name, value);
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    const url = new URL(request.url ?? "/", "http://localhost");
    const loggedPath = observabilityPath(url.pathname);
    const route = protectedRoute(request.method, url.pathname);
    let auditPrincipal: { userId: string; deviceId: string } | null = null;
    let auditReason: string | undefined;
    let modelUsageContext: { userId: string; action: string } | null = null;
    const completeCapacity = route ? capacityMonitor.start(route.rateLimitScope) : null;
    onResponseSettled(response, (status, clientDisconnected) => {
      if (clientDisconnected) auditReason = "client-disconnected";
      completeCapacity?.(status, auditReason === "rate-limit-exceeded");
      if (options.requestLogSink) {
        const event: RequestLogEvent = {
          occurredAt: new Date().toISOString(),
          requestId,
          method: request.method ?? "UNKNOWN",
          path: loggedPath,
          status,
          outcome: requestOutcome(status),
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          ...(clientDisconnected ? { termination: "client-disconnected" as const } : {}),
        };
        try {
          const recorded = options.requestLogSink!.record(event);
          if (recorded && "catch" in recorded) void recorded.catch((error) => console.error("Request log sink failed", error));
        } catch (error) {
          console.error("Request log sink failed", error);
        }
      }
      if (route && options.auditSink) {
        const event: SecurityAuditEvent = {
          occurredAt: new Date().toISOString(),
          action: route.action,
          method: request.method ?? "UNKNOWN",
          path: loggedPath,
          status,
          outcome: auditOutcome(status),
          ...(auditReason ? { reason: auditReason } : {}),
          ...principalFields(auditPrincipal),
        };
        try {
          const recorded = options.auditSink!.record(event);
          if (recorded && "catch" in recorded) void recorded.catch((error) => console.error("Security audit sink failed", error));
        } catch (error) {
          console.error("Security audit sink failed", error);
        }
      }
    });
    try {
      if (route) {
        const decision = await rateLimiter.consume(
          route.rateLimitScope,
          clientRateLimitKey(request, options.trustedProxyAddresses),
          route.policy,
        );
        response.setHeader("RateLimit-Limit", String(decision.limit));
        response.setHeader("RateLimit-Remaining", String(decision.remaining));
        response.setHeader("RateLimit-Reset", String(Math.ceil(decision.resetAt / 1000)));
        if (!decision.allowed) {
          auditReason = "rate-limit-exceeded";
          const retryAfter = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
          return sendJson(response, 429, { error: "Too many requests" }, { "Retry-After": String(retryAfter) });
        }
      }
      if (route?.rateLimitScope.startsWith("ai-")) {
        const release = agentConcurrencyLimiter.tryAcquire();
        if (!release) {
          auditReason = "agent-concurrency-exceeded";
          return sendJson(response, 503, { error: "Agent capacity is temporarily full" }, { "Retry-After": "1" });
        }
        response.once("finish", release);
        response.once("close", release);
      }
      if (request.method === "GET" && request.url === "/api/health") {
        let database: "disabled" | "ready" | "unavailable" = options.syncStore ? "ready" : "disabled";
        if (readinessCheck) {
          try {
            await readinessCheck();
          } catch (error) {
            database = "unavailable";
            console.error("Readiness check failed", error instanceof Error ? error.name : "UnknownError");
          }
        }
        const ready = database !== "unavailable";
        return sendJson(response, ready ? 200 : 503, {
          status: ready ? "ok" : "degraded",
          provider: provider.id,
          aiEnabled: provider.isAiEnabled,
          syncEnabled: Boolean(options.syncStore && options.resolvePrincipal),
          dependencies: { database },
          databasePool: options.databasePoolCapacity?.snapshot() ?? null,
          capacity: capacityMonitor.snapshot(),
          agentConcurrency: agentConcurrencyLimiter.snapshot(),
          accountModelBudgetsEnabled: Boolean(options.modelUsageLedger),
          subscriptionEntitlementsRequired: Boolean(options.subscriptionEntitlements),
        });
      }
      if (route?.rateLimitScope.startsWith("ai-") && options.modelUsageLedger) {
        if (!options.resolvePrincipal) {
          const error = new Error("Account model budgets require authentication");
          error.name = "ModelBudgetConfigurationError";
          throw error;
        }
        const principal = await options.resolvePrincipal(request);
        if (!principal) {
          auditReason = "authentication-required";
          return sendJson(response, 401, { error: "Authentication required" });
        }
        auditPrincipal = principal;
        requireAllowedOrigin(request, options.allowedSyncOrigins);
        let subscriptionPlanKey: string | null = null;
        if (options.subscriptionEntitlements) {
          const entitlement = await options.subscriptionEntitlements.checkEntitlement(principal.userId);
          subscriptionPlanKey = entitlement.planKey;
          if (entitlement.planKey) response.setHeader("Subscription-Plan", entitlement.planKey);
          response.setHeader("Subscription-State", entitlement.state);
          if (entitlement.accessUntil !== null) {
            response.setHeader("Subscription-Access-Until", String(Math.ceil(entitlement.accessUntil / 1_000)));
          }
          if (!entitlement.allowed) {
            auditReason = "subscription-entitlement-required";
            return sendJson(response, 402, { error: "Active subscription required" });
          }
        }
        const decision = await options.modelUsageLedger.checkBudget(principal.userId, subscriptionPlanKey);
        response.setHeader("ModelBudget-Remaining-Tokens", String(decision.remainingTokens));
        response.setHeader("ModelBudget-Remaining-Cost-Micros", String(decision.remainingCostMicros));
        if (decision.remainingGlobalCostMicros !== undefined) {
          response.setHeader("ModelBudget-Remaining-Global-Cost-Micros", String(decision.remainingGlobalCostMicros));
        }
        response.setHeader("ModelBudget-Reset", String(Math.ceil(decision.resetAt / 1_000)));
        if (!decision.allowed) {
          auditReason = decision.exceeded === "global" ? "global-model-budget-exceeded" : "model-budget-exceeded";
          const retryAfter = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1_000));
          const message = decision.exceeded === "global"
            ? "Global monthly model budget exceeded"
            : "Monthly model budget exceeded";
          return sendJson(response, 429, { error: message }, { "Retry-After": String(retryAfter) });
        }
        modelUsageContext = { userId: principal.userId, action: route.action };
      }
      const runAgent = <T>(callback: () => Promise<T>): Promise<T> => modelUsageContext && meteredProvider
        ? meteredProvider.run(modelUsageContext, callback)
        : callback();
      if (request.method === "POST" && request.url === "/api/plans") {
        const goal = await readJson(request, MAX_AGENT_BODY_BYTES) as LearningGoal;
        return sendJson(response, 201, await runAgent(() => planner.createPlan(goal, new Date(), controller.signal)));
      }
      if (request.method === "POST" && request.url === "/api/teaching-sessions") {
        const teachingRequest = await readJson(request, MAX_AGENT_BODY_BYTES) as TeachingSessionRequest;
        return sendJson(response, 201, await runAgent(() => teacher.createSession(teachingRequest, controller.signal)));
      }
      if (request.method === "POST" && request.url === "/api/evaluations") {
        const evaluationRequest = await readJson(request, MAX_AGENT_BODY_BYTES) as EvaluationRequest;
        return sendJson(response, 201, await runAgent(() => evaluator.evaluate(evaluationRequest, controller.signal)));
      }
      if (request.method === "POST" && request.url === "/api/review-assessments") {
        const assessmentRequest = await readJson(request, MAX_AGENT_BODY_BYTES) as ReviewAssessmentRequest;
        return sendJson(response, 201, await runAgent(() => reviewer.assess(assessmentRequest, controller.signal)));
      }
      if (request.method === "POST" && request.url === "/api/recovery-plans") {
        const recoveryRequest = await readJson(request, MAX_AGENT_BODY_BYTES) as RecoveryPlanRequest;
        return sendJson(response, 201, await runAgent(() => coach.createRecoveryPlan(recoveryRequest, controller.signal)));
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
      if (response.destroyed) return;
      if (error instanceof Error) auditReason = error.name;
      if (error instanceof SyncConflictError) {
        auditReason = error.code;
        return sendJson(response, 409, { error: error.code, current: error.current });
      }
      if (error instanceof SyncRequestError) {
        const status = error.code === "idempotency-mismatch" ? 409
          : error.code === "missing-plan" || error.code === "entity-too-large" ? 422
            : error.code === "unknown-principal" ? 401 : 400;
        return sendJson(response, status, { error: error.code, message: error.message });
      }
      if (error instanceof Error && error.name === "SyncConfigurationError") return sendJson(response, 503, { error: error.message });
      if (error instanceof Error && error.name === "ModelBudgetConfigurationError") return sendJson(response, 503, { error: error.message });
      if (error instanceof Error && error.name === "ForbiddenOriginError") return sendJson(response, 403, { error: error.message });
      if (error instanceof Error && error.name === "UnsupportedMediaTypeError") return sendJson(response, 415, { error: error.message });
      if (error instanceof Error && error.name === "PreconditionRequiredError") return sendJson(response, 428, { error: error.message });
      if (error instanceof AuthDeviceLimitError) return sendJson(response, 429, { error: error.message }, { "Retry-After": "3600" });
      if (error instanceof SyntaxError || error instanceof TypeError) return sendJson(response, 400, { error: error.message });
      if (error instanceof RangeError) return sendJson(response, 413, { error: error.message });
      if (error instanceof AgentOutputError) return sendJson(response, 502, { error: error.message });
      if (error instanceof ModelProviderError) return sendJson(response, error.status, { error: error.message, requestId: error.requestId });
      console.error("Unexpected API error", error);
      return sendJson(response, 500, { error: "Internal server error" });
    }
  });
}
