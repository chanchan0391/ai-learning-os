import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { DeterministicModelProvider } from "./ai/deterministic-provider";
import { ModelProviderError, type ModelProvider, type StructuredGenerationRequest } from "./ai/model-provider";
import type { SecurityAuditEvent } from "./security/request-security";

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
      status: "ok", provider: "deterministic-development", aiEnabled: false, syncEnabled: false,
      capacity: { inFlight: 0, requests: 0, rejected: 0, failed: 0, rateLimited: 0, byScope: {} },
    });
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
      resolvePrincipal: async (request) => request.headers.cookie === "session=valid" ? { userId: "user-1", deviceId: "device-1" } : null,
      modelUsageLedger: {
        checkBudget: async () => ({ allowed: true, exceeded: null, resetAt: Date.now() + 60_000, remainingTokens: 900, remainingCostMicros: 800, remainingGlobalCostMicros: 10_000 }),
        record: async (entry) => { recorded.push(entry); },
      },
    });

    const anonymous = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(goal) });
    expect(anonymous.status).toBe(401);
    expect(providerCalls).toBe(0);

    const response = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: "session=valid" }, body: JSON.stringify(goal) });
    expect(response.status).toBe(201);
    expect(response.headers.get("modelbudget-remaining-tokens")).toBe("900");
    expect(response.headers.get("modelbudget-remaining-global-cost-micros")).toBe("10000");
    expect(recorded).toEqual([{ userId: "user-1", action: "ai.plan.create", provider: "live-test", model: "model-a", requestId: "req-1", inputTokens: 100, outputTokens: 25 }]);
  });

  it("rejects exhausted account budgets before reading the body or calling the model", async () => {
    let providerCalls = 0;
    const provider: ModelProvider = { id: "live-test", isAiEnabled: true, generateStructured: async () => { providerCalls += 1; throw new Error("must not run"); } };
    const baseUrl = await startApi(provider, {
      resolvePrincipal: async () => ({ userId: "user-1", deviceId: "device-1" }),
      modelUsageLedger: {
        checkBudget: async () => ({ allowed: false, exceeded: "account", resetAt: Date.now() + 60_000, remainingTokens: 0, remainingCostMicros: 0 }),
        record: async () => undefined,
      },
    });
    const response = await fetch(`${baseUrl}/api/plans`, { method: "POST", body: "not-json" });
    expect(response.status).toBe(429);
    expect(providerCalls).toBe(0);
    await expect(response.json()).resolves.toEqual({ error: "Monthly model budget exceeded" });
  });

  it("rejects a depleted global model budget before reading the request body", async () => {
    const baseUrl = await startApi(new DeterministicModelProvider(), {
      resolvePrincipal: async () => ({ userId: "user-1", deviceId: "device-1" }),
      modelUsageLedger: {
        checkBudget: async () => ({ allowed: false, exceeded: "global", resetAt: Date.now() + 60_000, remainingTokens: 900, remainingCostMicros: 800, remainingGlobalCostMicros: 0 }),
        record: async () => undefined,
      },
    });
    const response = await fetch(`${baseUrl}/api/plans`, { method: "POST", body: "not-json" });
    expect(response.status).toBe(429);
    expect(response.headers.get("modelbudget-remaining-global-cost-micros")).toBe("0");
    await expect(response.json()).resolves.toEqual({ error: "Global monthly model budget exceeded" });
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
    const baseUrl = await startApi(provider);
    const controller = new AbortController();
    const fetchResult = fetch(`${baseUrl}/api/plans`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(goal), signal: controller.signal,
    });
    await started;
    controller.abort();

    await expect(fetchResult).rejects.toThrow();
    await expect(aborted).resolves.toBeUndefined();
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
    expect(callback.headers.get("set-cookie")).toContain("ai_learning_os_session=application-token");
    expect(established).toHaveLength(1);
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
