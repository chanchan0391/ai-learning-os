import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { EvaluationRequest, LearningGoal, TeachingSessionRequest } from "../src/types";
import { isDailyRecord, isLearningPlan } from "../src/learning-state";
import { AgentOutputError } from "./agents/agent-errors";
import { createEvaluatorAgent } from "./agents/evaluator-agent";
import { createPlannerAgent } from "./agents/planner-agent";
import { createTeacherAgent } from "./agents/teacher-agent";
import { ModelProviderError, type ModelProvider } from "./ai/model-provider";
import type { AuthenticatedPrincipalResolver } from "./auth/authenticated-principal";
import type { SessionLifecycle } from "./auth/postgres-session-lifecycle";
import { DEFAULT_SESSION_COOKIE_NAME, readSessionToken } from "./auth/postgres-session-resolver";
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
  sessionCookieName?: string;
}

function sessionCookie(name: string, token?: string, maxAgeSeconds?: number): string {
  const value = token ? `${name}=${token}` : `${name}=`;
  const age = maxAgeSeconds === undefined ? "" : `; Max-Age=${maxAgeSeconds}`;
  return `${value}; Path=/; HttpOnly; Secure; SameSite=Lax${age}`;
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
  return createServer(async (request, response) => {
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && request.url === "/api/health") {
        return sendJson(response, 200, {
          status: "ok",
          provider: provider.id,
          aiEnabled: provider.isAiEnabled,
          syncEnabled: Boolean(options.syncStore && options.resolvePrincipal),
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
        if (request.method === "GET" && url.pathname === "/api/auth/session") {
          const principal = await options.resolvePrincipal(request);
          return principal ? sendJson(response, 200, { authenticated: true, principal })
            : sendJson(response, 401, { authenticated: false });
        }
        if (request.method === "POST" && url.pathname === "/api/auth/session/refresh") {
          requireAllowedOrigin(request, options.allowedSyncOrigins);
          const token = readSessionToken(request.headers.cookie, cookieName);
          const rotated = token ? await options.sessionLifecycle.rotate(token) : null;
          if (!rotated) return sendJson(response, 401, { error: "Authentication required" }, {
            "Set-Cookie": sessionCookie(cookieName, undefined, 0),
          });
          const maxAge = Math.max(0, Math.floor((Date.parse(rotated.expiresAt) - Date.now()) / 1000));
          return sendJson(response, 200, { authenticated: true, principal: { userId: rotated.userId, deviceId: rotated.deviceId } }, {
            "Set-Cookie": sessionCookie(cookieName, rotated.token, maxAge),
          });
        }
        if (request.method === "POST" && url.pathname === "/api/auth/logout") {
          requireAllowedOrigin(request, options.allowedSyncOrigins);
          const token = readSessionToken(request.headers.cookie, cookieName);
          if (token) await options.sessionLifecycle.revoke(token);
          return sendJson(response, 200, { authenticated: false }, {
            "Set-Cookie": sessionCookie(cookieName, undefined, 0),
          });
        }
      }
      if (url.pathname.startsWith("/api/sync/")) {
        if (!options.syncStore || !options.resolvePrincipal) {
          return sendJson(response, 503, { error: "Sync is not configured" });
        }
        const principal = await options.resolvePrincipal(request);
        if (!principal) return sendJson(response, 401, { error: "Authentication required" });

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
      if (error instanceof SyncConflictError) return sendJson(response, 409, { error: error.code, current: error.current });
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
