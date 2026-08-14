import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { DeterministicModelProvider } from "./ai/deterministic-provider";
import { ModelProviderError, type ModelProvider, type StructuredGenerationRequest } from "./ai/model-provider";
import { AuthDeviceLimitError } from "./auth/postgres-session-lifecycle";
import type { SubscriptionEntitlementDecision } from "./billing/subscription-entitlement";
import { PublicHttpError } from "./http/public-http-error";
import type { RequestLogEvent } from "./observability/request-observability";
import { InMemoryConcurrencyLimiter, RollingRequestCapacityMonitor, type SecurityAuditEvent } from "./security/request-security";
import type { SyncStore } from "./sync/sync-store";

const servers: ReturnType<typeof createApp>[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

async function startApi(provider: ModelProvider = new DeterministicModelProvider(), options: Parameters<typeof createApp>[1] = {}) {
  const server = createApp(provider, options);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("AI Learning OS API", () => {
  const goal = { subject: "AI Agent 工程", currentLevel: "Java 工程师", targetOutcome: "交付 Agent 应用", dailyMinutes: 60, durationWeeks: 12 };
  const task = { id: "learn-1", type: "learn" as const, title: "理解工具调用", description: "实现一个工具调用闭环", minutes: 20, completed: false };

  it("reports whether a live AI model is enabled", async () => {
    const baseUrl = await startApi();
    await expect(fetch(`${baseUrl}/api/health`).then((response) => response.json())).resolves.toMatchObject({
      status: "ok", releaseRevision: null, provider: "deterministic-development", aiEnabled: false, syncEnabled: false,
      dependencies: { database: "disabled" },
      databasePool: null,
      capacity: { inFlight: 0, requests: 0, rejected: 0, failed: 0, rateLimited: 0, byScope: {} },
      agentConcurrency: { limit: 20, inFlight: 0, rejected: 0 },
    });
  });

  it("reports the exact validated release revision", async () => {
    const releaseRevision = "b".repeat(40);
    const baseUrl = await startApi(new DeterministicModelProvider(), { releaseRevision });

    await expect(fetch(`${baseUrl}/api/health`).then((response) => response.json())).resolves.toMatchObject({
      status: "ok",
      releaseRevision,
    });
  });

  it("reports identifier-free database pool saturation", async () => {
    const baseUrl = await startApi(new DeterministicModelProvider(), {
      syncStore: {} as SyncStore,
      resolvePrincipal: async () => null,
      readinessCheck: async () => undefined,
      databasePoolCapacity: {
        snapshot: () => ({ limit: 10, total: 10, idle: 0, inUse: 10, waiting: 2, saturated: true }),
      },
    });

    await expect(fetch(`${baseUrl}/api/health`).then((response) => response.json())).resolves.toMatchObject({
      status: "ok",
      databasePool: { limit: 10, total: 10, idle: 0, inUse: 10, waiting: 2, saturated: true },
    });
  });

  it("returns a stable server error when an adapter produces a non-JSON health value", async () => {
    const loggedErrors: unknown[][] = [];
    const consoleError = console.error;
    console.error = (...values: unknown[]) => { loggedErrors.push(values); };
    try {
      const baseUrl = await startApi(new DeterministicModelProvider(), {
        databasePoolCapacity: {
          snapshot: () => ({
            limit: 10n,
            total: 0,
            idle: 0,
            inUse: 0,
            waiting: 0,
            saturated: false,
          }) as never,
        },
      });

      const failed = await fetch(`${baseUrl}/api/health`);
      expect(failed.status).toBe(500);
      await expect(failed.json()).resolves.toEqual({ error: "Internal server error" });
      expect(JSON.parse(String(loggedErrors[0]?.[0]))).toMatchObject({
        category: "api",
        path: "/api/health",
        errorType: "JsonResponseSerializationError",
      });

      const healthy = await fetch(`${baseUrl}/unmatched`);
      expect(healthy.status).toBe(404);
      await expect(healthy.json()).resolves.toEqual({ error: "Not found" });
    } finally {
      console.error = consoleError;
    }
  });

  it("hardens every API response against browser content injection and embedding", async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/health`);

    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("fails startup when subscription enforcement cannot guard model calls", () => {
    expect(() => createApp(new DeterministicModelProvider(), {
      subscriptionEntitlements: {
        checkEntitlement: async () => ({ allowed: true, state: "active", planKey: "pro", accessUntil: null }),
      },
    })).toThrow(/requires account model budgets/);
  });

  it("reports degraded readiness without exposing database errors", async () => {
    const events: RequestLogEvent[] = [];
    const baseUrl = await startApi(new DeterministicModelProvider(), {
      syncStore: {} as SyncStore,
      resolvePrincipal: async () => null,
      readinessCheck: async () => { throw new Error("postgres://secret@private-host/learning"); },
      requestLogSink: { record: (event) => { events.push(event); } },
    });

    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      syncEnabled: true,
      dependencies: { database: "unavailable" },
    });
    expect(JSON.stringify(events)).not.toContain("private-host");
  });

  it("adds a correlation ID and records privacy-safe request metadata", async () => {
    const events: RequestLogEvent[] = [];
    const releaseRevision = "c".repeat(40);
    const baseUrl = await startApi(new DeterministicModelProvider(), {
      releaseRevision,
      requestLogSink: { record: (event) => { events.push(event); } },
    });
    const response = await fetch(`${baseUrl}/api/plans?private=do-not-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "session=secret-token" },
      body: JSON.stringify({ ...goal, currentLevel: "private learner context" }),
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      requestId: response.headers.get("x-request-id"),
      releaseRevision,
      method: "POST",
      path: "/api/plans",
      status: 404,
      outcome: "rejected",
    });
    expect(events[0].occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events[0])).not.toMatch(/do-not-log|secret-token|private learner context|cookie/i);
  });

  it("correlates audit events and redacts unexpected exception details", async () => {
    const auditEvents: SecurityAuditEvent[] = [];
    const loggedErrors: unknown[][] = [];
    const consoleError = console.error;
    console.error = (...values: unknown[]) => { loggedErrors.push(values); };
    try {
      const releaseRevision = "d".repeat(40);
      const baseUrl = await startApi(new DeterministicModelProvider(), {
        releaseRevision,
        rateLimiter: { consume: () => { throw new Error("postgres://secret@private-host/learning"); } },
        auditSink: { record: (event) => { auditEvents.push(event); } },
      });

      const response = await fetch(`${baseUrl}/api/plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(goal),
      });
      await response.json();

      expect(response.status).toBe(500);
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]).toMatchObject({
        requestId: response.headers.get("x-request-id"),
        releaseRevision,
        path: "/api/plans",
        status: 500,
      });
      const errorLog = JSON.stringify(loggedErrors);
      expect(JSON.parse(String(loggedErrors[0]?.[0]))).toMatchObject({
        category: "api",
        requestId: response.headers.get("x-request-id"),
        releaseRevision,
        path: "/api/plans",
        errorType: "Error",
      });
      expect(errorLog).not.toMatch(/secret|private-host|learning/);
    } finally {
      console.error = consoleError;
    }
  });

  it("does not expose untrusted model-provider error details or request identifiers", async () => {
    const provider: ModelProvider = {
      id: "untrusted-error-test",
      isAiEnabled: true,
      generateStructured: async () => {
        throw new ModelProviderError(
          "upstream reflected secret-token and private learner context",
          401,
          "request-id\nset-cookie: secret-token",
        );
      },
    };
    const baseUrl = await startApi(provider);

    const response = await fetch(`${baseUrl}/api/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(goal),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Model provider request failed" });
  });

  it.each([
    ["TypeError", () => new TypeError("secret-token from private-adapter.example")],
    ["RangeError", () => new RangeError("secret-token from private-adapter.example")],
    ["SyntaxError", () => new SyntaxError("secret-token from private-adapter.example")],
  ])("does not expose unexpected %s values from internal adapters", async (errorType, createError) => {
    const loggedErrors: unknown[][] = [];
    const consoleError = console.error;
    console.error = (...values: unknown[]) => { loggedErrors.push(values); };
    try {
      const provider: ModelProvider = {
        id: "unexpected-built-in-error-test",
        isAiEnabled: true,
        generateStructured: async () => {
          throw createError();
        },
      };
      const baseUrl = await startApi(provider);

      const response = await fetch(`${baseUrl}/api/plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(goal),
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Internal server error" });
      expect(JSON.parse(String(loggedErrors[0]?.[0]))).toMatchObject({
        category: "api",
        path: "/api/plans",
        errorType,
      });
      expect(JSON.stringify(loggedErrors)).not.toMatch(/secret-token|private-adapter/);
    } finally {
      console.error = consoleError;
    }
  });

  it("templates dynamic paths and suppresses unknown path content in telemetry", async () => {
    const requestEvents: RequestLogEvent[] = [];
    const auditEvents: SecurityAuditEvent[] = [];
    const privatePlanId = "private-course-and-learner-id";
    const baseUrl = await startApi(new DeterministicModelProvider(), {
      syncStore: {} as SyncStore,
      resolvePrincipal: async () => null,
      requestLogSink: { record: (event) => { requestEvents.push(event); } },
      auditSink: { record: (event) => { auditEvents.push(event); } },
    });

    const syncResponse = await fetch(`${baseUrl}/api/sync/plans/${privatePlanId}`);
    expect(syncResponse.status).toBe(401);
    await syncResponse.json();
    const unknownResponse = await fetch(`${baseUrl}/private-notes/${privatePlanId}`);
    expect(unknownResponse.status).toBe(404);
    await unknownResponse.json();

    expect(requestEvents.map((event) => event.path)).toEqual([
      "/api/sync/plans/:planId",
      "/unmatched",
    ]);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "sync.read",
      path: "/api/sync/plans/:planId",
      status: 401,
      reason: "authentication-required",
    });
    expect(JSON.stringify({ requestEvents, auditEvents })).not.toContain(privatePlanId);
  });

  it("creates a validated plan through the Agent boundary", async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/plans`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(goal),
    });
    const plan = await response.json() as { today: Array<{ minutes: number }> };
    expect(response.status).toBe(201);
    expect(plan.today.reduce((sum, task) => sum + task.minutes, 0)).toBe(60);
  });

  it("requires JSON media types before invoking an Agent", async () => {
    let providerCalls = 0;
    const provider: ModelProvider = {
      id: "live-test",
      isAiEnabled: true,
      generateStructured: async () => {
        providerCalls += 1;
        throw new Error("must not run");
      },
    };
    const baseUrl = await startApi(provider);

    const response = await fetch(`${baseUrl}/api/plans`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(goal),
    });

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: "Content-Type must be application/json" });
    expect(providerCalls).toBe(0);
  });

  it("rejects Agent JSON above 64 KiB before invoking the model", async () => {
    let providerCalls = 0;
    const provider: ModelProvider = {
      id: "live-test",
      isAiEnabled: true,
      generateStructured: async () => {
        providerCalls += 1;
        throw new Error("must not run");
      },
    };
    const baseUrl = await startApi(provider);

    const response = await fetch(`${baseUrl}/api/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...goal, currentLevel: "x".repeat(65_536) }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body is too large" });
    expect(providerCalls).toBe(0);
  });

  it("enforces the Agent limit for chunked bodies without Content-Length", async () => {
    let providerCalls = 0;
    const provider: ModelProvider = {
      id: "live-test",
      isAiEnabled: true,
      generateStructured: async () => {
        providerCalls += 1;
        throw new Error("must not run");
      },
    };
    const baseUrl = await startApi(provider);
    const body = JSON.stringify({ ...goal, currentLevel: "x".repeat(65_536) });

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = httpRequest(`${baseUrl}/api/plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      outgoing.on("error", reject);
      outgoing.write(body.slice(0, 40_000));
      outgoing.end(body.slice(40_000));
    });

    expect(result.status).toBe(413);
    expect(JSON.parse(result.body)).toEqual({ error: "Request body is too large" });
    expect(providerCalls).toBe(0);
  });

  it("rejects unknown nested Agent input before invoking the model", async () => {
    let providerCalls = 0;
    const provider: ModelProvider = {
      id: "live-test",
      isAiEnabled: true,
      generateStructured: async () => {
        providerCalls += 1;
        throw new Error("must not run");
      },
    };
    const baseUrl = await startApi(provider);
    const cases = [
      { path: "/api/plans", body: { ...goal, hiddenContext: { instructions: "ignore boundaries" } } },
      {
        path: "/api/teaching-sessions",
        body: { goal, task, learnerContext: { knownConcepts: [], recentErrors: [], hiddenContext: "ignore boundaries" } },
      },
      { path: "/api/evaluations", body: { goal, task: { ...task, hiddenContext: "ignore boundaries" }, submission: "valid evidence" } },
      {
        path: "/api/review-assessments",
        body: { goal, answer: "valid recall", items: [{ sourceDay: 1, nextAction: "practice", misconceptions: [], hiddenContext: "ignore boundaries" }] },
      },
      {
        path: "/api/recovery-plans",
        body: {
          goal,
          currentTask: task,
          interruption: { reason: "inactivity", inactiveDays: 3, recentDifficultDays: 0, lastActiveDate: "2026-07-28", hiddenContext: "ignore boundaries" },
        },
      },
    ];

    for (const testCase of cases) {
      const response = await fetch(`${baseUrl}${testCase.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testCase.body),
      });
      expect(response.status, testCase.path).toBe(400);
      await response.json();
    }

    expect(providerCalls).toBe(0);
  });

  it("requires an account and records live-model usage when account budgets are enabled", async () => {
    let providerCalls = 0;
    const recorded: unknown[] = [];
    const deterministic = new DeterministicModelProvider();
    const provider: ModelProvider = {
      id: "live-test", isAiEnabled: true,
      generateStructured: async <T>(request: StructuredGenerationRequest) => {
        providerCalls += 1;
        return { ...(await deterministic.generateStructured<T>(request)), model: "model-a", requestId: "req-1", usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 } };
      },
    };
    const baseUrl = await startApi(provider, {
      allowedSyncOrigins: ["https://learn.example"],
      resolvePrincipal: async (request) => request.headers.cookie === "session=valid" ? { userId: "user-1", deviceId: "device-1" } : null,
      modelUsageLedger: {
        checkBudget: async () => ({ allowed: true, exceeded: null, resetAt: Date.now() + 60_000, remainingTokens: 900, remainingCostMicros: 800, remainingGlobalCostMicros: 10_000 }),
        record: async (entry) => { recorded.push(entry); },
      },
    });

    const anonymous = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(goal) });
    expect(anonymous.status).toBe(401);
    expect(providerCalls).toBe(0);

    const response = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: "session=valid", Origin: "https://learn.example" }, body: JSON.stringify(goal) });
    expect(response.status).toBe(201);
    expect(response.headers.get("modelbudget-remaining-tokens")).toBe("900");
    expect(response.headers.get("modelbudget-remaining-global-cost-micros")).toBe("10000");
    expect(recorded).toEqual([{ userId: "user-1", action: "ai.plan.create", provider: "live-test", model: "model-a", requestId: "req-1", inputTokens: 100, outputTokens: 25 }]);
  });

  it("rejects exhausted account budgets before reading the body or calling the model", async () => {
    let providerCalls = 0;
    const provider: ModelProvider = { id: "live-test", isAiEnabled: true, generateStructured: async () => { providerCalls += 1; throw new Error("must not run"); } };
    const baseUrl = await startApi(provider, {
      allowedSyncOrigins: ["https://learn.example"],
      resolvePrincipal: async () => ({ userId: "user-1", deviceId: "device-1" }),
      modelUsageLedger: {
        checkBudget: async () => ({ allowed: false, exceeded: "account", resetAt: Date.now() + 60_000, remainingTokens: 0, remainingCostMicros: 0 }),
        record: async () => undefined,
      },
    });
    const response = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { Origin: "https://learn.example" }, body: "not-json" });
    expect(response.status).toBe(429);
    expect(providerCalls).toBe(0);
    await expect(response.json()).resolves.toEqual({ error: "Monthly model budget exceeded" });
  });

  it("rejects a depleted global model budget before reading the request body", async () => {
    const baseUrl = await startApi(new DeterministicModelProvider(), {
      allowedSyncOrigins: ["https://learn.example"],
      resolvePrincipal: async () => ({ userId: "user-1", deviceId: "device-1" }),
      modelUsageLedger: {
        checkBudget: async () => ({ allowed: false, exceeded: "global", resetAt: Date.now() + 60_000, remainingTokens: 900, remainingCostMicros: 800, remainingGlobalCostMicros: 0 }),
        record: async () => undefined,
      },
    });
    const response = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { Origin: "https://learn.example" }, body: "not-json" });
    expect(response.status).toBe(429);
    expect(response.headers.get("modelbudget-remaining-global-cost-micros")).toBe("0");
    await expect(response.json()).resolves.toEqual({ error: "Global monthly model budget exceeded" });
  });

  it("rejects cross-origin authenticated model calls before budget or model work", async () => {
    let budgetChecks = 0;
    let providerCalls = 0;
    const provider: ModelProvider = {
      id: "live-test",
      isAiEnabled: true,
      generateStructured: async () => {
        providerCalls += 1;
        throw new Error("must not run");
      },
    };
    const baseUrl = await startApi(provider, {
      allowedSyncOrigins: ["https://learn.example"],
      resolvePrincipal: async () => ({ userId: "user-1", deviceId: "device-1" }),
      modelUsageLedger: {
        checkBudget: async () => {
          budgetChecks += 1;
          return { allowed: true, exceeded: null, resetAt: Date.now() + 60_000, remainingTokens: 1_000, remainingCostMicros: 1_000 };
        },
        record: async () => undefined,
      },
    });

    const response = await fetch(`${baseUrl}/api/plans`, {
      method: "POST",
      headers: { Cookie: "session=valid", Origin: "https://attacker.example" },
      body: "not-json",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Request origin is not allowed" });
    expect(budgetChecks).toBe(0);
    expect(providerCalls).toBe(0);
  });

  it("enforces subscription denial, plan changes, and grace periods before budget and model work", async () => {
    let providerCalls = 0;
    let budgetChecks = 0;
    const budgetPlans: Array<string | null | undefined> = [];
    let decision: SubscriptionEntitlementDecision = { allowed: false, state: "inactive", planKey: null, accessUntil: null };
    const provider: ModelProvider = {
      id: "live-test", isAiEnabled: true,
      generateStructured: async <T>(request: StructuredGenerationRequest) => {
        providerCalls += 1;
        return {
          ...(await new DeterministicModelProvider().generateStructured<T>(request)),
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      },
    };
    const baseUrl = await startApi(provider, {
      allowedSyncOrigins: ["https://learn.example"],
      resolvePrincipal: async () => ({ userId: "user-1", deviceId: "device-1" }),
      subscriptionEntitlements: { checkEntitlement: async () => decision },
      modelUsageLedger: {
        checkBudget: async (_userId, planKey) => {
          budgetChecks += 1;
          budgetPlans.push(planKey);
          return { allowed: true, exceeded: null, resetAt: Date.now() + 60_000, remainingTokens: 1_000, remainingCostMicros: 1_000 };
        },
        record: async () => undefined,
      },
    });
    const request = () => fetch(`${baseUrl}/api/plans`, {
      method: "POST", headers: { Origin: "https://learn.example", "Content-Type": "application/json" }, body: JSON.stringify(goal),
    });

    const denied = await request();
    expect(denied.status).toBe(402);
    await expect(denied.json()).resolves.toEqual({ error: "Active subscription required" });
    expect(budgetChecks).toBe(0);
    expect(providerCalls).toBe(0);

    decision = { allowed: true, state: "active", planKey: "starter", accessUntil: Date.now() + 86_400_000 };
    const starter = await request();
    expect(starter.status).toBe(201);
    expect(starter.headers.get("subscription-plan")).toBe("starter");

    decision = { allowed: true, state: "active", planKey: "pro", accessUntil: Date.now() + 86_400_000 };
    const switched = await request();
    expect(switched.status).toBe(201);
    expect(switched.headers.get("subscription-plan")).toBe("pro");

    decision = { allowed: true, state: "grace", planKey: "pro", accessUntil: Date.now() + 3_600_000 };
    const grace = await request();
    expect(grace.status).toBe(201);
    expect(grace.headers.get("subscription-state")).toBe("grace");
    expect(budgetChecks).toBe(3);
    expect(budgetPlans).toEqual(["starter", "pro", "pro"]);
    expect(providerCalls).toBe(3);
  });

  it("creates a teaching session with active understanding checks", async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/teaching-sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, task, learnerContext: { knownConcepts: ["Java 接口"], recentErrors: ["没有处理超时"] } }),
    });
    const session = await response.json() as { understandingChecks: unknown[]; completionSignals: unknown[] };
    expect(response.status).toBe(201);
    expect(session.understandingChecks).toHaveLength(2);
    expect(session.completionSignals.length).toBeGreaterThan(0);
  });

  it("creates a low-pressure recovery plan after a learning interruption", async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/recovery-plans`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal,
        currentTask: task,
        interruption: { reason: "inactivity", inactiveDays: 3, recentDifficultDays: 0, lastActiveDate: "2026-07-28" },
      }),
    });
    const plan = await response.json() as { totalMinutes: number; steps: unknown[] };
    expect(response.status).toBe(201);
    expect(plan.totalMinutes).toBe(12);
    expect(plan.steps).toHaveLength(2);
  });

  it("evaluates a submission against the fixed rubric", async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/evaluations`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, task, submission: "我实现了工具调用，记录了输入、输出和失败后的重试结果，并复盘了超时处理。" }),
    });
    const evaluation = await response.json() as { rubric: unknown[]; totalScore: number; masteryLevel: string };
    expect(response.status).toBe(201);
    expect(evaluation.rubric).toHaveLength(4);
    expect(evaluation.totalScore).toBe(8);
    expect(evaluation.masteryLevel).toBe("developing");
  });

  it("rejects an empty evaluation submission", async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/evaluations`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, task, submission: "  " }),
    });
    expect(response.status).toBe(400);
  });

  it("does not reflect malformed JSON contents in validation errors", async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"currentLevel":"private learner context","subject": secret-token}',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Request body must be valid JSON" });
  });

  it("rejects malformed UTF-8 JSON before invoking the model", async () => {
    let providerCalls = 0;
    const provider: ModelProvider = {
      id: "live-test",
      isAiEnabled: true,
      generateStructured: async () => {
        providerCalls += 1;
        throw new Error("must not run");
      },
    };
    const baseUrl = await startApi(provider);
    const target = new URL("/api/plans", baseUrl);

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = httpRequest(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      outgoing.on("error", reject);
      outgoing.end(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
    });

    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: "Request body must be valid UTF-8 JSON" });
    expect(providerCalls).toBe(0);
  });

  it("automatically scores an active-recall answer", async () => {
    const baseUrl = await startApi();
    const answer = "重试是再次执行失败步骤，恢复是从检查点继续。我会画出状态路径并标出失败分支。";
    const response = await fetch(`${baseUrl}/api/review-assessments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, answer, items: [{ sourceDay: 1, nextAction: "画出恢复路径", misconceptions: ["混淆重试与恢复"] }] }),
    });
    const assessment = await response.json() as { answer: string; score: number; recall: string };
    expect(response.status).toBe(201);
    expect(assessment.answer).toBe(answer);
    expect(assessment.score).toBeGreaterThanOrEqual(2);
    expect(assessment.recall).toBe("effortful");
  });

  it("rejects an empty active-recall answer", async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/review-assessments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, answer: " ", items: [{ sourceDay: 1, nextAction: "画出恢复路径", misconceptions: [] }] }),
    });
    expect(response.status).toBe(400);
  });

  it("cancels an Agent call when its client disconnects", async () => {
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    const requestEvents: RequestLogEvent[] = [];
    const auditEvents: SecurityAuditEvent[] = [];
    const capacityMonitor = new RollingRequestCapacityMonitor();
    let markLogged!: () => void;
    let markAudited!: () => void;
    const logged = new Promise<void>((resolve) => { markLogged = resolve; });
    const audited = new Promise<void>((resolve) => { markAudited = resolve; });
    const provider: ModelProvider = {
      id: "cancellation-test",
      isAiEnabled: true,
      generateStructured: ({ signal }) => new Promise((_resolve, reject) => {
        markStarted();
        signal?.addEventListener("abort", () => {
          markAborted();
          reject(new ModelProviderError("cancelled", 499));
        }, { once: true });
      }),
    };
    const baseUrl = await startApi(provider, {
      capacityMonitor,
      requestLogSink: { record: (event) => { requestEvents.push(event); markLogged(); } },
      auditSink: { record: (event) => { auditEvents.push(event); markAudited(); } },
    });
    const controller = new AbortController();
    const fetchResult = fetch(`${baseUrl}/api/plans`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(goal), signal: controller.signal,
    });
    await started;
    controller.abort();

    await expect(fetchResult).rejects.toThrow();
    await expect(aborted).resolves.toBeUndefined();
    await Promise.all([logged, audited]);
    expect(requestEvents).toHaveLength(1);
    expect(requestEvents[0]).toMatchObject({
      method: "POST", path: "/api/plans", status: 499, outcome: "rejected", termination: "client-disconnected",
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "ai.plan.create", status: 499, outcome: "rejected", reason: "client-disconnected",
    });
    expect(capacityMonitor.snapshot()).toMatchObject({
      inFlight: 0, requests: 1, rejected: 1, failed: 0,
      byScope: { "ai-plan": { requests: 1, rejected: 1, failed: 0 } },
    });
  });

  it("rejects excess concurrent Agent work before reading its body or calling the model", async () => {
    const deterministic = new DeterministicModelProvider();
    let allowFirst!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { allowFirst = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let modelCalls = 0;
    const provider: ModelProvider = {
      id: "concurrency-test",
      isAiEnabled: true,
      generateStructured: async <T>(request: StructuredGenerationRequest) => {
        modelCalls += 1;
        if (modelCalls === 1) {
          markStarted();
          await gate;
        }
        return deterministic.generateStructured<T>(request);
      },
    };
    const baseUrl = await startApi(provider, { agentConcurrencyLimiter: new InMemoryConcurrencyLimiter(1) });
    const first = fetch(`${baseUrl}/api/plans`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(goal),
    });
    await started;

    const second = await fetch(`${baseUrl}/api/plans`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(goal),
    });
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("1");
    await expect(second.json()).resolves.toEqual({ error: "Agent capacity is temporarily full" });
    expect(modelCalls).toBe(1);

    await expect(fetch(`${baseUrl}/api/health`).then((response) => response.json())).resolves.toMatchObject({
      agentConcurrency: { limit: 1, inFlight: 1, rejected: 1 },
    });
    allowFirst();
    expect((await first).status).toBe(201);
    await expect(fetch(`${baseUrl}/api/health`).then((response) => response.json())).resolves.toMatchObject({
      agentConcurrency: { limit: 1, inFlight: 0, rejected: 1 },
    });
  });

  it("reports, rotates, and revokes authenticated browser sessions", async () => {
    const calls: string[] = [];
    const options: Parameters<typeof createApp>[1] = {
      allowedSyncOrigins: ["https://learn.example"],
      sessionCookieName: "session",
      resolvePrincipal: async (request) => request.headers.cookie === "session=old-token"
        ? { userId: "user-1", deviceId: "device-1" } : null,
      sessionLifecycle: {
        establishFromOidc: async () => { throw new Error("not used"); },
        rotate: async (token) => {
          calls.push(`rotate:${token}`);
          return { token: "new-token", userId: "user-1", deviceId: "device-1", expiresAt: new Date(Date.now() + 60_000).toISOString() };
        },
        revoke: async (token) => {
          calls.push(`revoke:${token}`);
          return true;
        },
        revokeAll: async (token) => {
          calls.push(`revoke-all:${token}`);
          return true;
        },
        listActiveDevices: async (token) => {
          calls.push(`devices:${token}`);
          return [{ id: "device-1", label: "Laptop", createdAt: "2026-08-01T10:00:00.000Z", lastSeenAt: "2026-08-01T12:00:00.000Z", current: true }];
        },
        revokeDevice: async (token, deviceId) => {
          calls.push(`revoke-device:${token}:${deviceId}`);
          return true;
        },
      },
      accountDataLifecycle: {
        deleteAccount: async (token) => {
          calls.push(`delete:${token}`);
          return true;
        },
      },
    };
    const baseUrl = await startApi(new DeterministicModelProvider(), options);

    const current = await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: "session=old-token" } });
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toMatchObject({ authenticated: true, principal: { userId: "user-1" } });

    const refreshed = await fetch(`${baseUrl}/api/auth/session/refresh`, {
      method: "POST", headers: { Cookie: "session=old-token", Origin: "https://learn.example" },
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("set-cookie")).toMatch(/^session=new-token;.*HttpOnly; Secure; SameSite=Lax/);

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST", headers: { Cookie: "session=new-token", Origin: "https://learn.example" },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(calls).toEqual(["rotate:old-token", "revoke:new-token"]);

    const devices = await fetch(`${baseUrl}/api/auth/devices`, { headers: { Cookie: "session=old-token" } });
    expect(devices.status).toBe(200);
    await expect(devices.json()).resolves.toMatchObject({ devices: [{ id: "device-1", current: true }] });

    const revokeDevice = await fetch(`${baseUrl}/api/auth/devices/device-2`, {
      method: "DELETE", headers: { Cookie: "session=old-token", Origin: "https://learn.example" },
    });
    expect(revokeDevice.status).toBe(200);
    await expect(revokeDevice.json()).resolves.toEqual({ revoked: true, revokedCurrent: false });

    const logoutAll = await fetch(`${baseUrl}/api/auth/logout-all`, {
      method: "POST", headers: { Cookie: "session=old-token", Origin: "https://learn.example" },
    });
    expect(logoutAll.status).toBe(200);
    expect(logoutAll.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(calls).toEqual(["rotate:old-token", "revoke:new-token", "devices:old-token", "revoke-device:old-token:device-2", "revoke-all:old-token"]);

    const deletion = await fetch(`${baseUrl}/api/auth/account`, {
      method: "DELETE", headers: { Cookie: "session=old-token", Origin: "https://learn.example" },
    });
    expect(deletion.status).toBe(200);
    expect(deletion.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(calls).toEqual(["rotate:old-token", "revoke:new-token", "devices:old-token", "revoke-device:old-token:device-2", "revoke-all:old-token", "delete:old-token"]);
  });

  it("migrates a legacy default session to the host-only cookie on rotation", async () => {
    const rotate = vi.fn(async () => ({
      token: "host-token",
      userId: "user-1",
      deviceId: "device-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const baseUrl = await startApi(new DeterministicModelProvider(), {
      allowedSyncOrigins: ["https://learn.example"],
      resolvePrincipal: async () => ({ userId: "user-1", deviceId: "device-1" }),
      sessionLifecycle: {
        establishFromOidc: async () => { throw new Error("not used"); },
        rotate,
        revoke: async () => true,
        revokeAll: async () => true,
        listActiveDevices: async () => [],
        revokeDevice: async () => true,
      },
    });

    const response = await fetch(`${baseUrl}/api/auth/session/refresh`, {
      method: "POST",
      headers: { Cookie: "ai_learning_os_session=legacy-token", Origin: "https://learn.example" },
    });

    expect(response.status).toBe(200);
    expect(rotate).toHaveBeenCalledWith("legacy-token");
    expect(response.headers.get("set-cookie")).toMatch(
      /^__Host-ai_learning_os_session=host-token; Path=\/; HttpOnly; Secure; SameSite=Lax/,
    );
  });

  it("rejects cross-origin session changes", async () => {
    const baseUrl = await startApi(new DeterministicModelProvider(), {
      allowedSyncOrigins: ["https://learn.example"],
      resolvePrincipal: async () => ({ userId: "user-1", deviceId: "device-1" }),
      sessionLifecycle: { establishFromOidc: async () => { throw new Error("not used"); }, rotate: async () => null, revoke: async () => true, revokeAll: async () => true, listActiveDevices: async () => [], revokeDevice: async () => true },
    });
    const response = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { Origin: "https://evil.example" } });
    expect(response.status).toBe(403);
  });

  it("completes OIDC login and issues an application session", async () => {
    const established: unknown[] = [];
    const baseUrl = await startApi(new DeterministicModelProvider(), {
      allowedSyncOrigins: ["https://learn.example"],
      resolvePrincipal: async () => null,
      oidcAuthenticator: {
        transactionCookieName: "oidc_txn",
        begin: async () => ({ authorizationUrl: "https://identity.example/authorize", transactionCookie: "signed-transaction" }),
        complete: async () => ({
          identity: { issuer: "https://identity.example", subject: "subject-1", deviceLabel: "Browser" },
          returnTo: "/progress",
        }),
      },
      sessionLifecycle: {
        establishFromOidc: async (identity) => {
          established.push(identity);
          return { token: "application-token", userId: "user-1", deviceId: "device-1", expiresAt: new Date(Date.now() + 60_000).toISOString() };
        },
        rotate: async () => null,
        revoke: async () => true,
        revokeAll: async () => true,
        listActiveDevices: async () => [],
        revokeDevice: async () => true,
      },
    });

    const login = await fetch(`${baseUrl}/api/auth/login?returnTo=%2Fprogress`, { redirect: "manual" });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("https://identity.example/authorize");
    expect(login.headers.get("set-cookie")).toContain("oidc_txn=signed-transaction");

    const callback = await fetch(`${baseUrl}/api/auth/callback?code=code&state=state`, { redirect: "manual" });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/progress");
    expect(callback.headers.get("set-cookie")).toContain("__Host-ai_learning_os_session=application-token");
    expect(established).toHaveLength(1);
  });

  it("does not reflect provider callback errors in authentication responses", async () => {
    const baseUrl = await startApi(new DeterministicModelProvider(), {
      resolvePrincipal: async () => null,
      oidcAuthenticator: {
        transactionCookieName: "oidc_txn",
        begin: async () => ({ authorizationUrl: "https://identity.example/authorize", transactionCookie: "transaction" }),
        complete: async () => { throw new PublicHttpError(400, "OIDC provider rejected login"); },
      },
      sessionLifecycle: {
        establishFromOidc: async () => { throw new Error("not used"); },
        rotate: async () => null,
        revoke: async () => false,
        revokeAll: async () => false,
        listActiveDevices: async () => null,
        revokeDevice: async () => false,
      },
    });

    const response = await fetch(`${baseUrl}/api/auth/callback?error=secret-token%20private-context`, { redirect: "manual" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "OIDC provider rejected login" });
  });

  it("returns a retryable response when an account reaches its active device limit", async () => {
    const baseUrl = await startApi(new DeterministicModelProvider(), {
      resolvePrincipal: async () => null,
      oidcAuthenticator: {
        transactionCookieName: "oidc_txn",
        begin: async () => ({ authorizationUrl: "https://identity.example/authorize", transactionCookie: "transaction" }),
        complete: async () => ({
          identity: { issuer: "https://identity.example", subject: "subject-1", deviceLabel: "Browser" },
          returnTo: "/",
        }),
      },
      sessionLifecycle: {
        establishFromOidc: async () => { throw new AuthDeviceLimitError("Active device limit reached"); },
        rotate: async () => null,
        revoke: async () => false,
        revokeAll: async () => false,
        listActiveDevices: async () => null,
        revokeDevice: async () => false,
      },
    });

    const response = await fetch(`${baseUrl}/api/auth/callback?code=code&state=state`, { redirect: "manual" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
    await expect(response.json()).resolves.toEqual({ error: "Active device limit reached" });
  });

  it("rate limits protected routes before auth work and emits privacy-safe audit metadata", async () => {
    let beginCalls = 0;
    let resolveAudit!: (event: SecurityAuditEvent) => void;
    const audited = new Promise<SecurityAuditEvent>((resolve) => { resolveAudit = resolve; });
    const baseUrl = await startApi(new DeterministicModelProvider(), {
      resolvePrincipal: async () => null,
      sessionLifecycle: {
        establishFromOidc: async () => { throw new Error("not used"); },
        rotate: async () => null,
        revoke: async () => false,
        revokeAll: async () => false,
        listActiveDevices: async () => null,
        revokeDevice: async () => false,
      },
      oidcAuthenticator: {
        transactionCookieName: "oidc_txn",
        begin: async () => {
          beginCalls += 1;
          return { authorizationUrl: "https://identity.example/authorize", transactionCookie: "secret-transaction" };
        },
        complete: async () => { throw new Error("not used"); },
      },
      rateLimiter: {
        consume: () => ({ allowed: false, limit: 20, remaining: 0, resetAt: Date.now() + 30_000 }),
      },
      auditSink: { record: resolveAudit },
    });

    const response = await fetch(`${baseUrl}/api/auth/login?returnTo=%2Fprivate`, {
      headers: { Cookie: "ai_learning_os_session=secret-token" },
      redirect: "manual",
    });
    const event = await audited;

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
    expect(beginCalls).toBe(0);
    expect(event).toMatchObject({
      action: "auth.login",
      method: "GET",
      path: "/api/auth/login",
      status: 429,
      outcome: "rejected",
      reason: "rate-limit-exceeded",
    });
    expect(JSON.stringify(event)).not.toMatch(/secret|private|returnTo|cookie/i);
  });

  it("rate limits Agent work before model calls and reports the cost-control scope", async () => {
    let modelCalls = 0;
    let consumed: { scope: string; limit: number } | undefined;
    let resolveAudit!: (event: SecurityAuditEvent) => void;
    const audited = new Promise<SecurityAuditEvent>((resolve) => { resolveAudit = resolve; });
    const provider: ModelProvider = {
      id: "metered-model",
      isAiEnabled: true,
      generateStructured: async () => {
        modelCalls += 1;
        throw new Error("Model must not be called after quota rejection");
      },
    };
    const baseUrl = await startApi(provider, {
      rateLimiter: {
        consume: (scope, _key, policy) => {
          consumed = { scope, limit: policy.limit };
          return { allowed: false, limit: policy.limit, remaining: 0, resetAt: Date.now() + 5_000 };
        },
      },
      auditSink: { record: resolveAudit },
    });

    const response = await fetch(`${baseUrl}/api/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...goal, currentLevel: "private learner context" }),
    });
    const event = await audited;

    expect(response.status).toBe(429);
    expect(response.headers.get("ratelimit-limit")).toBe("10");
    expect(consumed).toEqual({ scope: "ai-plan", limit: 10 });
    expect(modelCalls).toBe(0);
    expect(event).toMatchObject({
      action: "ai.plan.create",
      method: "POST",
      path: "/api/plans",
      status: 429,
      reason: "rate-limit-exceeded",
    });
    expect(JSON.stringify(event)).not.toContain("private learner context");

    await expect(fetch(`${baseUrl}/api/health`).then((health) => health.json())).resolves.toMatchObject({
      capacity: {
        requests: 1,
        rejected: 1,
        rateLimited: 1,
        byScope: { "ai-plan": { requests: 1, rejected: 1, rateLimited: 1 } },
      },
    });
  });
});
