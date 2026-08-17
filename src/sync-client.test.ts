// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeLearningState, toggleCurrentTask } from "./learning-state";
import { generateLearningPlan } from "./planner";
import { AuthSessionExpiredError, BrowserSyncClient, PermanentSyncError, SYNC_METADATA_KEY, SyncConflictError } from "./sync-client";

interface RemoteEntity {
  entityType: "learning-plan" | "daily-record";
  entityId: string;
  revision: number;
  updatedAt: string;
  value: unknown;
}

const goal = {
  subject: "分布式系统",
  currentLevel: "了解单体应用",
  targetOutcome: "能设计可恢复的服务",
  dailyMinutes: 45,
  durationWeeks: 8,
};

function learningState() {
  return initializeLearningState(generateLearningPlan(goal, new Date("2026-08-01T10:00:00.000Z")), new Date("2026-08-01T10:00:00.000Z"));
}

function fakeServer(initial: RemoteEntity[] = []) {
  const entities = new Map(initial.map((entity) => [`${entity.entityType}:${entity.entityId}`, structuredClone(entity)]));
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/auth/session") {
      return Response.json({ authenticated: true, principal: { userId: "user-1", deviceId: "device-1" } });
    }
    if (url.pathname === "/api/sync/changes") {
      return Response.json({ changes: [...entities.values()], cursor: "cursor-1" });
    }
    const match = /^\/api\/sync\/(plans|daily-records)\/(.+)$/.exec(url.pathname);
    if (init?.method === "PUT" && match) {
      const entityType = match[1] === "plans" ? "learning-plan" as const : "daily-record" as const;
      const entityId = decodeURIComponent(match[2]);
      const key = `${entityType}:${entityId}`;
      const current = entities.get(key);
      const ifMatch = new Headers(init.headers).get("If-Match");
      const ifNoneMatch = new Headers(init.headers).get("If-None-Match");
      const expectedRevision = ifMatch ? Number(ifMatch.replaceAll('"', "")) : null;
      if ((ifNoneMatch === "*" && current) || (ifMatch && current?.revision !== expectedRevision)) {
        return Response.json({ error: "revision-conflict", current }, { status: 409 });
      }
      const entity: RemoteEntity = {
        entityType,
        entityId,
        revision: (current?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        value: JSON.parse(String(init.body)),
      };
      entities.set(key, entity);
      return Response.json(entity, { headers: { ETag: `"${entity.revision}"` } });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };
  return { entities, request: request as typeof fetch };
}

describe("browser sync client", () => {
  beforeEach(() => localStorage.clear());

  it("propagates cancellation to sync requests without committing metadata", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | null | undefined;
    const request = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;
    const client = new BrowserSyncClient(localStorage, request);
    const pending = client.sync(learningState(), controller.signal);

    controller.abort();

    await expect(pending).rejects.toBeDefined();
    expect(observedSignal).toBe(controller.signal);
    expect(localStorage.getItem(SYNC_METADATA_KEY)).toBeNull();
  });

  it("lists active devices and requests targeted revocation with an encoded ID", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/auth/devices") return Response.json({
        devices: [{ id: "phone/1", label: "Phone", createdAt: "2026-08-01T10:00:00.000Z", lastSeenAt: "2026-08-01T12:00:00.000Z", current: true }],
      });
      return Response.json({ revoked: true });
    }) as typeof fetch;
    const client = new BrowserSyncClient(localStorage, request);

    await expect(client.getActiveDevices()).resolves.toMatchObject([{ id: "phone/1", label: "Phone" }]);
    await client.revokeDevice("phone/1");

    expect(calls).toEqual([
      { url: "/api/auth/devices", method: "GET" },
      { url: "/api/auth/devices/phone%2F1", method: "DELETE" },
    ]);
  });

  it("rejects an oversized authentication response before retaining device data", async () => {
    const request = vi.fn(async () => new Response("{}", {
      headers: { "Content-Length": String(64 * 1024 + 1), "Content-Type": "application/json" },
    })) as typeof fetch;
    const client = new BrowserSyncClient(localStorage, request);

    await expect(client.getActiveDevices()).rejects.toThrow("账号响应超过安全上限，请稍后重试");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed session principals", async () => {
    const invalidSessions = [
      { authenticated: true, principal: { userId: "user-1", deviceId: "" } },
      { authenticated: true, principal: { userId: "user-1", deviceId: "device-1", role: "admin" } },
      { authenticated: false, principal: { userId: "user-1", deviceId: "device-1" } },
    ];

    for (const session of invalidSessions) {
      const request = vi.fn(async () => Response.json(session)) as typeof fetch;
      await expect(new BrowserSyncClient(localStorage, request).getAuthState())
        .resolves.toEqual({ status: "local-only" });
    }
  });

  it("rejects malformed or ambiguous active device envelopes", async () => {
    const validDevice = {
      id: "device-1",
      label: "Laptop",
      createdAt: "2026-08-01T10:00:00.000Z",
      lastSeenAt: "2026-08-01T12:00:00.000Z",
      current: true,
    };
    const invalidEnvelopes = [
      { devices: [{ ...validDevice, label: "" }] },
      { devices: [{ ...validDevice, unexpected: true }] },
      { devices: [validDevice, { ...validDevice }] },
      { devices: [{ ...validDevice, current: false }] },
      { devices: [], error: "ignored" },
    ];

    for (const envelope of invalidEnvelopes) {
      const request = vi.fn(async () => Response.json(envelope)) as typeof fetch;
      await expect(new BrowserSyncClient(localStorage, request).getActiveDevices())
        .rejects.toThrow("登录设备响应格式无效，请稍后重试");
    }
  });

  it("classifies expired authenticated account actions without exposing server details", async () => {
    const request = vi.fn(async () => Response.json(
      { error: "private-session-database-detail" },
      { status: 401 },
    )) as typeof fetch;
    const client = new BrowserSyncClient(localStorage, request);

    for (const action of [
      () => client.logoutAll(),
      () => client.getActiveDevices(),
      () => client.revokeDevice("device-2"),
      () => client.deleteAccount(),
    ]) {
      await expect(action()).rejects.toThrow(AuthSessionExpiredError);
      await expect(action()).rejects.not.toThrow("private-session-database-detail");
    }
  });

  it("uses privacy-safe account action errors for non-authentication failures", async () => {
    const request = vi.fn(async () => Response.json(
      { error: "private-session-database-detail" },
      { status: 503 },
    )) as typeof fetch;
    const client = new BrowserSyncClient(localStorage, request);

    await expect(client.getActiveDevices()).rejects.toThrow("无法读取登录设备，请稍后重试");
    await expect(client.revokeDevice("device-2")).rejects.toThrow("设备退出失败，请稍后重试");
    await expect(client.logoutAll()).rejects.toThrow("退出所有设备失败，请稍后重试");
    await expect(client.deleteAccount()).rejects.toThrow("账号数据删除失败，请稍后重试");
  });

  it("cancels unused account action response bodies after headers settle", async () => {
    let cancelled = 0;
    const request = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled += 1;
      },
    }), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const client = new BrowserSyncClient(localStorage, request);

    await client.logout();
    await client.logoutAll();
    await client.revokeDevice("device-2");
    await client.deleteAccount();

    expect(request).toHaveBeenCalledTimes(4);
    expect(cancelled).toBe(4);
  });

  it("cancels unused account error bodies before returning a safe failure", async () => {
    let cancelled = false;
    const request = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }), { status: 503, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const client = new BrowserSyncClient(localStorage, request);

    await expect(client.logoutAll()).rejects.toThrow("退出所有设备失败，请稍后重试");
    expect(cancelled).toBe(true);
  });

  it("cancels unused session discovery error bodies before settling auth state", async () => {
    const statuses = [401, 503, 500];
    let cancelled = 0;
    const request = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled += 1;
      },
    }), { status: statuses.shift(), headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const client = new BrowserSyncClient(localStorage, request);

    await expect(client.getAuthState()).resolves.toEqual({ status: "signed-out" });
    await expect(client.getAuthState()).resolves.toEqual({ status: "local-only" });
    await expect(client.getAuthState()).resolves.toEqual({ status: "local-only" });
    expect(cancelled).toBe(3);
  });

  it("bounds stalled session discovery and account controls", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const request = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal) signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("private network detail", "AbortError")), { once: true });
      });
    }) as typeof fetch;
    const client = new BrowserSyncClient(localStorage, request, { accountRequestTimeoutMs: 50 });

    const auth = client.getAuthState();
    await vi.advanceTimersByTimeAsync(50);
    await expect(auth).resolves.toEqual({ status: "local-only" });

    const devices = client.getActiveDevices();
    const deviceExpectation = expect(devices).rejects.toThrow("无法读取登录设备，请稍后重试");
    await vi.advanceTimersByTimeAsync(50);
    await deviceExpectation;
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    vi.useRealTimers();
  });

  it("keeps the account timeout active while reading a stalled response body", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal) signals.push(signal);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(new DOMException("private body detail", "AbortError")), { once: true });
        },
      });
      return new Response(stream, { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = new BrowserSyncClient(localStorage, request, { accountRequestTimeoutMs: 50 });

    const auth = client.getAuthState();
    await vi.advanceTimersByTimeAsync(50);
    await expect(auth).resolves.toEqual({ status: "local-only" });

    const devices = client.getActiveDevices();
    const deviceExpectation = expect(devices).rejects.toThrow("无法读取登录设备，请稍后重试");
    await vi.advanceTimersByTimeAsync(50);
    await deviceExpectation;
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    vi.useRealTimers();
  });

  it("rejects invalid account timeout configuration", () => {
    expect(() => new BrowserSyncClient(localStorage, undefined, { accountRequestTimeoutMs: 0 }))
      .toThrow("Account request timeout must be a positive finite number");
  });

  it("uploads a new local plan and its daily record with revision metadata", async () => {
    const server = fakeServer();
    const state = learningState();
    const client = new BrowserSyncClient(localStorage, server.request);

    const result = await client.sync(state);

    expect(result).toMatchObject({ uploaded: 2, downloaded: 0, state });
    expect(server.entities.size).toBe(2);
    expect(JSON.parse(localStorage.getItem(SYNC_METADATA_KEY)!).plans[state.plan.id]).toMatchObject({
      [`learning-plan:${state.plan.id}`]: { revision: 1 },
      [`daily-record:${state.plan.id}:day-1`]: { revision: 1 },
    });
  });

  it("syncs multiple active goals with isolated revision metadata", async () => {
    const server = fakeServer();
    const first = learningState();
    const second = initializeLearningState(generateLearningPlan(
      { ...goal, subject: "事件驱动架构" },
      new Date("2026-08-02T10:00:00.000Z"),
    ), new Date("2026-08-02T10:00:00.000Z"));
    const client = new BrowserSyncClient(localStorage, server.request);

    const initial = await client.syncActive([first, second]);
    const changedFirst = toggleCurrentTask(first, first.days[0].tasks[0].id);
    const changedSecond = toggleCurrentTask(second, second.days[0].tasks[1].id);
    const updated = await client.syncActive([changedFirst, changedSecond]);

    expect(initial).toMatchObject({ uploaded: 4, downloaded: 0 });
    expect(updated).toMatchObject({ uploaded: 2, downloaded: 0 });
    expect(updated.states).toEqual([changedFirst, changedSecond]);
    const metadata = JSON.parse(localStorage.getItem(SYNC_METADATA_KEY)!);
    expect(metadata.version).toBe(2);
    expect(Object.keys(metadata.plans).sort()).toEqual([first.plan.id, second.plan.id].sort());
    expect(metadata.plans[first.plan.id][`daily-record:${first.plan.id}:day-1`].revision).toBe(2);
    expect(metadata.plans[second.plan.id][`daily-record:${second.plan.id}:day-1`].revision).toBe(2);
  });

  it("downloads every missing active cloud goal into an empty browser", async () => {
    const first = learningState();
    const second = initializeLearningState(generateLearningPlan(
      { ...goal, subject: "事件驱动架构" },
      new Date("2026-08-02T10:00:00.000Z"),
    ), new Date("2026-08-02T10:00:00.000Z"));
    const entities = [first, second].flatMap((state) => [
      { entityType: "learning-plan" as const, entityId: state.plan.id, revision: 1, updatedAt: state.plan.createdAt, value: state.plan },
      { entityType: "daily-record" as const, entityId: `${state.plan.id}:day-1`, revision: 1, updatedAt: state.plan.createdAt, value: { planId: state.plan.id, record: state.days[0] } },
    ]);

    const result = await new BrowserSyncClient(localStorage, fakeServer(entities).request).syncActive([]);

    expect(result.downloaded).toBe(4);
    expect(result.states.map((state) => state.plan.id).sort()).toEqual([first.plan.id, second.plan.id].sort());
  });

  it("drains paginated cloud snapshots before restoring goals", async () => {
    const state = learningState();
    const pages = [
      [{ entityType: "learning-plan" as const, entityId: state.plan.id, revision: 1, updatedAt: state.plan.createdAt, value: state.plan }],
      [{ entityType: "daily-record" as const, entityId: `${state.plan.id}:day-1`, revision: 1, updatedAt: state.plan.createdAt, value: { planId: state.plan.id, record: state.days[0] } }],
    ];
    const requested: string[] = [];
    const request = vi.fn(async (input: string | URL | Request) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requested.push(rawUrl);
      const url = new URL(rawUrl, "http://localhost");
      const page = url.searchParams.get("cursor") === "page-1" ? 1 : 0;
      return Response.json({ changes: pages[page], cursor: `page-${page + 1}`, hasMore: page === 0 });
    }) as typeof fetch;

    const result = await new BrowserSyncClient(localStorage, request).sync(null);

    expect(result.state).toEqual(state);
    expect(result.downloaded).toBe(2);
    expect(requested).toEqual(["/api/sync/changes", "/api/sync/changes?cursor=page-1"]);
  });

  it("rejects a cloud page that exceeds the documented entity limit", async () => {
    const request = vi.fn(async () => Response.json({
      changes: Array.from({ length: 251 }, (_, index) => ({
        entityType: "learning-plan",
        entityId: `plan-${index}`,
        revision: 1,
        updatedAt: "2026-08-01T10:00:00.000Z",
        value: {},
      })),
      cursor: "oversized-page",
      hasMore: false,
    })) as typeof fetch;

    await expect(new BrowserSyncClient(localStorage, request).sync(null))
      .rejects.toThrow("云端同步分页超过安全上限，请稍后重试");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed cloud entity envelopes before using their identifiers or revisions", async () => {
    const invalidEntities = [
      { entityType: "unknown", entityId: "plan-1", revision: 1, updatedAt: "2026-08-01T10:00:00.000Z", value: {} },
      { entityType: "learning-plan", entityId: "plan-1", revision: Number.MAX_SAFE_INTEGER + 1, updatedAt: "2026-08-01T10:00:00.000Z", value: {} },
      { entityType: "learning-plan", entityId: "plan-1", revision: 1, updatedAt: "not-a-date", value: {} },
    ];

    for (const entity of invalidEntities) {
      const request = vi.fn(async () => Response.json({ changes: [entity], cursor: "page-1", hasMore: false })) as typeof fetch;
      await expect(new BrowserSyncClient(localStorage, request).sync(null))
        .rejects.toThrow("云端同步响应格式无效，请稍后重试");
    }
  });

  it("rejects malformed pagination metadata before following another page", async () => {
    const state = learningState();
    const request = vi.fn(async () => Response.json({
      changes: [{ entityType: "learning-plan", entityId: state.plan.id, revision: 1, updatedAt: state.plan.createdAt, value: state.plan }],
      cursor: "x".repeat(257),
      hasMore: true,
    })) as typeof fetch;

    await expect(new BrowserSyncClient(localStorage, request).sync(null))
      .rejects.toThrow("云端同步分页游标无效，请稍后重试");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed write response before saving sync metadata", async () => {
    const state = learningState();
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (!init?.method) return Response.json({ changes: [], cursor: "page-1", hasMore: false });
      return Response.json({
        entityType: "learning-plan",
        entityId: "different-plan",
        revision: 1,
        updatedAt: state.plan.createdAt,
        value: state.plan,
      });
    }) as typeof fetch;

    await expect(new BrowserSyncClient(localStorage, request).sync(state))
      .rejects.toThrow("云端写入响应格式无效，请稍后重试");
    expect(localStorage.getItem(SYNC_METADATA_KEY)).toBeNull();
  });

  it("cancels a streamed cloud page that exceeds the response byte limit", async () => {
    const oversized = `{"changes":[],"padding":"${"x".repeat(9 * 1024 * 1024)}"}`;
    const request = vi.fn(async () => new Response(oversized, {
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

    await expect(new BrowserSyncClient(localStorage, request).sync(null))
      .rejects.toThrow("云端同步响应超过安全上限，请稍后重试");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("classifies permanent client failures without exposing server details", async () => {
    const request = vi.fn(async () => Response.json({
      error: "database-column-and-private-request-detail",
      message: "sensitive server detail",
    }, { status: 400 })) as typeof fetch;

    const promise = new BrowserSyncClient(localStorage, request).sync(null);

    await expect(promise).rejects.toBeInstanceOf(PermanentSyncError);
    await expect(promise).rejects.not.toThrow(/database|sensitive/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps service outages retriable with a stable client message", async () => {
    const request = vi.fn(async () => Response.json({ error: "private-upstream-name" }, { status: 503 })) as typeof fetch;

    await expect(new BrowserSyncClient(localStorage, request).sync(null))
      .rejects.toThrow("无法读取云端进度");
  });

  it("distinguishes revision conflicts from permanent idempotency failures", async () => {
    const state = learningState();
    for (const [code, errorType] of [
      ["revision-conflict", SyncConflictError],
      ["idempotency-mismatch", PermanentSyncError],
    ] as const) {
      let reads = 0;
      const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if (!init?.method) {
          reads += 1;
          return Response.json({ changes: [], cursor: `cursor-${reads}` });
        }
        return Response.json({ error: code }, { status: 409 });
      }) as typeof fetch;

      await expect(new BrowserSyncClient(localStorage, request).sync(state)).rejects.toBeInstanceOf(errorType);
    }
  });

  it("stops a snapshot after the total distinct entity limit", async () => {
    let page = 0;
    const request = vi.fn(async () => {
      const offset = page * 250;
      page += 1;
      return Response.json({
        changes: Array.from({ length: 250 }, (_, index) => ({
          entityType: "learning-plan",
          entityId: `plan-${offset + index}`,
          revision: 1,
          updatedAt: "2026-08-01T10:00:00.000Z",
          value: {},
        })),
        cursor: `page-${page}`,
        hasMore: true,
      });
    }) as typeof fetch;

    await expect(new BrowserSyncClient(localStorage, request).sync(null))
      .rejects.toThrow("云端学习记录过多，无法在单次同步中安全读取");
    expect(request).toHaveBeenCalledTimes(100);
  });

  it("marks a completed goal as archived and does not treat it as a competing active plan", async () => {
    const server = fakeServer();
    const client = new BrowserSyncClient(localStorage, server.request);
    const archivedState = learningState();

    await client.sync(archivedState);
    const archived = await client.syncArchived({
      archivedAt: "2026-08-02T12:00:00.000Z",
      state: archivedState,
    });
    const nextState = initializeLearningState(generateLearningPlan(
      { ...goal, subject: "事件驱动架构" },
      new Date("2026-08-03T10:00:00.000Z"),
    ), new Date("2026-08-03T10:00:00.000Z"));
    const next = await client.sync(nextState);

    expect(archived.uploaded).toBe(1);
    expect((server.entities.get(`learning-plan:${archivedState.plan.id}`)?.value as { archivedAt?: string }).archivedAt)
      .toBe("2026-08-02T12:00:00.000Z");
    expect(next.state?.plan.id).toBe(nextState.plan.id);
    expect(next.uploaded).toBe(2);
  });

  it("does not restore an archived cloud plan as the active goal", async () => {
    const state = learningState();
    const server = fakeServer([{
      entityType: "learning-plan",
      entityId: state.plan.id,
      revision: 2,
      updatedAt: "2026-08-02T12:00:00.000Z",
      value: { ...state.plan, archivedAt: "2026-08-02T12:00:00.000Z" },
    }]);

    const result = await new BrowserSyncClient(localStorage, server.request).sync(null);

    expect(result).toEqual({ state: null, uploaded: 0, downloaded: 0 });
  });

  it("downloads archived cloud snapshots without exposing their sync marker locally", async () => {
    const state = learningState();
    const archivedAt = "2026-08-02T12:00:00.000Z";
    const server = fakeServer([
      {
        entityType: "learning-plan", entityId: state.plan.id, revision: 2, updatedAt: archivedAt,
        value: { ...state.plan, archivedAt },
      },
      {
        entityType: "daily-record", entityId: `${state.plan.id}:day-1`, revision: 1, updatedAt: archivedAt,
        value: { planId: state.plan.id, record: state.days[0] },
      },
    ]);

    const result = await new BrowserSyncClient(localStorage, server.request).downloadArchived([]);

    expect(result.downloaded).toBe(2);
    expect(result.entries).toEqual([{ archivedAt, state }]);
    expect(result.entries[0].state.plan.archivedAt).toBeUndefined();
  });

  it("skips archived snapshots already stored locally or active on this device", async () => {
    const state = learningState();
    const archivedAt = "2026-08-02T12:00:00.000Z";
    const server = fakeServer([{
      entityType: "learning-plan", entityId: state.plan.id, revision: 2, updatedAt: archivedAt,
      value: { ...state.plan, archivedAt },
    }]);
    const client = new BrowserSyncClient(localStorage, server.request);

    await expect(client.downloadArchived([state.plan.id])).resolves.toEqual({ entries: [], downloaded: 0 });
    await expect(client.downloadArchived([], state.plan.id)).resolves.toEqual({ entries: [], downloaded: 0 });
  });

  it("explicitly restores an archived cloud plan without a false divergence conflict", async () => {
    const state = learningState();
    const archivedAt = "2026-08-02T12:00:00.000Z";
    const server = fakeServer([
      {
        entityType: "learning-plan", entityId: state.plan.id, revision: 2, updatedAt: archivedAt,
        value: { ...state.plan, archivedAt },
      },
      {
        entityType: "daily-record", entityId: `${state.plan.id}:day-1`, revision: 1, updatedAt: archivedAt,
        value: { planId: state.plan.id, record: state.days[0] },
      },
    ]);
    const client = new BrowserSyncClient(localStorage, server.request);
    client.markArchiveRestored(state.plan.id);

    const result = await client.sync(state);

    expect(result.uploaded).toBe(1);
    expect(server.entities.get(`learning-plan:${state.plan.id}`)?.revision).toBe(3);
    expect((server.entities.get(`learning-plan:${state.plan.id}`)?.value as { archivedAt?: string }).archivedAt).toBeUndefined();
  });

  it("conditionally uploads a local change after the first successful sync", async () => {
    const server = fakeServer();
    const client = new BrowserSyncClient(localStorage, server.request);
    const state = learningState();
    await client.sync(state);
    const changed = toggleCurrentTask(state, state.days[0].tasks[0].id);

    const result = await client.sync(changed);

    expect(result.uploaded).toBe(1);
    expect(server.entities.get(`daily-record:${state.plan.id}:day-1`)?.revision).toBe(2);
  });

  it("upgrades legacy single-plan metadata without losing its sync base", async () => {
    const server = fakeServer();
    const client = new BrowserSyncClient(localStorage, server.request);
    const state = learningState();
    await client.sync(state);
    const current = JSON.parse(localStorage.getItem(SYNC_METADATA_KEY)!);
    localStorage.setItem(SYNC_METADATA_KEY, JSON.stringify({
      version: 1,
      planId: state.plan.id,
      entities: current.plans[state.plan.id],
    }));

    const changed = toggleCurrentTask(state, state.days[0].tasks[0].id);
    const result = await client.sync(changed);

    expect(result.uploaded).toBe(1);
    expect(JSON.parse(localStorage.getItem(SYNC_METADATA_KEY)!)).toMatchObject({
      version: 2,
      plans: { [state.plan.id]: { [`daily-record:${state.plan.id}:day-1`]: { revision: 2 } } },
    });
  });

  it("pulls a remote change when the local entity still matches its sync base", async () => {
    const server = fakeServer();
    const client = new BrowserSyncClient(localStorage, server.request);
    const state = learningState();
    await client.sync(state);
    const key = `daily-record:${state.plan.id}:day-1`;
    const remote = server.entities.get(key)!;
    const value = structuredClone(remote.value) as { planId: string; record: typeof state.days[0] };
    value.record.tasks[0].completed = true;
    server.entities.set(key, { ...remote, revision: 2, value });

    const result = await client.sync(state);

    expect(result.downloaded).toBe(1);
    expect(result.state?.days[0].tasks[0].completed).toBe(true);
  });

  it("refuses to overwrite when local and remote copies both diverged", async () => {
    const server = fakeServer();
    const client = new BrowserSyncClient(localStorage, server.request);
    const state = learningState();
    await client.sync(state);
    const local = toggleCurrentTask(state, state.days[0].tasks[0].id);
    const key = `daily-record:${state.plan.id}:day-1`;
    const remote = server.entities.get(key)!;
    const value = structuredClone(remote.value) as { planId: string; record: typeof state.days[0] };
    value.record.tasks[1].description = "另一台设备更新的学习说明";
    server.entities.set(key, { ...remote, revision: 2, value });

    const conflict = await client.sync(local).catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(SyncConflictError);
    expect((conflict as SyncConflictError).preview).toMatchObject({
      kind: "diverged-entity",
      entityType: "daily-record",
      localState: local,
    });
    expect(server.entities.get(key)?.revision).toBe(2);
  });

  it("resolves a diverged record by keeping the selected local version", async () => {
    const server = fakeServer();
    const client = new BrowserSyncClient(localStorage, server.request);
    const state = learningState();
    await client.sync(state);
    const local = toggleCurrentTask(state, state.days[0].tasks[0].id);
    const key = `daily-record:${state.plan.id}:day-1`;
    const remote = server.entities.get(key)!;
    const value = structuredClone(remote.value) as { planId: string; record: typeof state.days[0] };
    value.record.tasks[1].description = "另一台设备更新的学习说明";
    server.entities.set(key, { ...remote, revision: 2, value });
    const conflict = await client.sync(local).then(
      () => { throw new Error("expected sync conflict"); },
      (error: unknown) => error as SyncConflictError,
    );

    const result = await client.resolveConflict(conflict.preview!, "local");

    expect(result.uploaded).toBe(1);
    expect((server.entities.get(key)?.value as { record: typeof state.days[0] }).record.tasks[0].completed).toBe(true);
    expect(server.entities.get(key)?.revision).toBe(3);
  });

  it("resolves a diverged record by adopting the selected cloud version", async () => {
    const server = fakeServer();
    const client = new BrowserSyncClient(localStorage, server.request);
    const state = learningState();
    await client.sync(state);
    const local = toggleCurrentTask(state, state.days[0].tasks[0].id);
    const key = `daily-record:${state.plan.id}:day-1`;
    const remote = server.entities.get(key)!;
    const value = structuredClone(remote.value) as { planId: string; record: typeof state.days[0] };
    value.record.tasks[1].description = "采用云端学习说明";
    server.entities.set(key, { ...remote, revision: 2, value });
    const conflict = await client.sync(local).then(
      () => { throw new Error("expected sync conflict"); },
      (error: unknown) => error as SyncConflictError,
    );

    const result = await client.resolveConflict(conflict.preview!, "remote");

    expect(result.state?.days[0].tasks[0].completed).toBe(false);
    expect(result.state?.days[0].tasks[1].description).toBe("采用云端学习说明");
    expect(server.entities.get(key)?.revision).toBe(2);
  });

  it("restores the newest cloud plan into an empty browser", async () => {
    const state = learningState();
    const planEntity: RemoteEntity = {
      entityType: "learning-plan", entityId: state.plan.id, revision: 1,
      updatedAt: "2026-08-01T10:00:00.000Z", value: state.plan,
    };
    const recordEntity: RemoteEntity = {
      entityType: "daily-record", entityId: `${state.plan.id}:day-1`, revision: 1,
      updatedAt: "2026-08-01T10:00:01.000Z", value: { planId: state.plan.id, record: state.days[0] },
    };
    const server = fakeServer([planEntity, recordEntity]);

    const result = await new BrowserSyncClient(localStorage, server.request).sync(null);

    expect(result.downloaded).toBe(2);
    expect(result.state).toEqual(state);
  });
});
