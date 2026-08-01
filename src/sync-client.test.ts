// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { initializeLearningState, toggleCurrentTask } from "./learning-state";
import { generateLearningPlan } from "./planner";
import { BrowserSyncClient, SYNC_METADATA_KEY, SyncConflictError } from "./sync-client";

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

  it("uploads a new local plan and its daily record with revision metadata", async () => {
    const server = fakeServer();
    const state = learningState();
    const client = new BrowserSyncClient(localStorage, server.request);

    const result = await client.sync(state);

    expect(result).toMatchObject({ uploaded: 2, downloaded: 0, state });
    expect(server.entities.size).toBe(2);
    expect(JSON.parse(localStorage.getItem(SYNC_METADATA_KEY)!).entities).toMatchObject({
      [`learning-plan:${state.plan.id}`]: { revision: 1 },
      [`daily-record:${state.plan.id}:day-1`]: { revision: 1 },
    });
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
