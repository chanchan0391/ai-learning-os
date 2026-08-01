import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { initializeLearningState } from "../../src/learning-state";
import { generateLearningPlan } from "../../src/planner";
import { createApp } from "../app";
import { DeterministicModelProvider } from "../ai/deterministic-provider";
import { InMemorySyncStore, type SyncPrincipal } from "./sync-store";

const servers: ReturnType<typeof createApp>[] = [];
const alice: SyncPrincipal = { userId: "user-alice", deviceId: "device-laptop" };
const bob: SyncPrincipal = { userId: "user-bob", deviceId: "device-phone" };

afterEach(() => servers.splice(0).forEach((server) => server.close()));

function resolveTestPrincipal(cookie: string | undefined): SyncPrincipal | null {
  if (cookie === "session=alice") return alice;
  if (cookie === "session=bob") return bob;
  return null;
}

async function startApi(store = new InMemorySyncStore()) {
  const server = createApp(new DeterministicModelProvider(), {
    syncStore: store,
    resolvePrincipal: (request) => resolveTestPrincipal(request.headers.cookie),
    allowedSyncOrigins: ["http://127.0.0.1:5173"],
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const goal = {
  subject: "分布式系统",
  currentLevel: "了解单体应用",
  targetOutcome: "能设计可恢复的服务",
  dailyMinutes: 45,
  durationWeeks: 8,
};

describe("authenticated sync HTTP API", () => {
  const writeOrigin = { Origin: "http://127.0.0.1:5173" };
  it("rejects requests without a principal resolved from a trusted session", async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/sync/changes`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Authentication required" });
  });

  it("requires write preconditions and validates the plan against its route ID", async () => {
    const baseUrl = await startApi();
    const plan = generateLearningPlan(goal, new Date("2026-08-01T10:00:00.000Z"));
    const missingPrecondition = await fetch(`${baseUrl}/api/sync/plans/${plan.id}`, {
      method: "PUT",
      headers: { ...writeOrigin, Cookie: "session=alice", "Idempotency-Key": "create-plan" },
      body: JSON.stringify(plan),
    });
    const mismatchedId = await fetch(`${baseUrl}/api/sync/plans/different-id`, {
      method: "PUT",
      headers: { ...writeOrigin, Cookie: "session=alice", "Idempotency-Key": "invalid-plan", "If-None-Match": "*" },
      body: JSON.stringify(plan),
    });

    expect(missingPrecondition.status).toBe(428);
    expect(mismatchedId.status).toBe(400);
  });

  it("creates, retries, pulls, and conditionally updates a plan", async () => {
    const baseUrl = await startApi();
    const plan = generateLearningPlan(goal, new Date("2026-08-01T10:00:00.000Z"));
    const create = () => fetch(`${baseUrl}/api/sync/plans/${encodeURIComponent(plan.id)}`, {
      method: "PUT",
      headers: { ...writeOrigin, Cookie: "session=alice", "Idempotency-Key": "create-plan", "If-None-Match": "*" },
      body: JSON.stringify(plan),
    });

    const first = await create();
    const retry = await create();
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe('"1"');
    expect(await retry.json()).toEqual(firstBody);

    const pull = await fetch(`${baseUrl}/api/sync/changes`, { headers: { Cookie: "session=alice" } });
    await expect(pull.json()).resolves.toMatchObject({ changes: [{ entityType: "learning-plan", revision: 1 }] });

    const update = await fetch(`${baseUrl}/api/sync/plans/${encodeURIComponent(plan.id)}`, {
      method: "PUT",
      headers: { ...writeOrigin, Cookie: "session=alice", "Idempotency-Key": "update-plan", "If-Match": '"1"' },
      body: JSON.stringify({ ...plan, goal: { ...plan.goal, targetOutcome: "能评审可恢复的服务" } }),
    });
    expect(update.status).toBe(200);
    expect(update.headers.get("etag")).toBe('"2"');
  });

  it("returns the current entity on revision conflicts and isolates users", async () => {
    const baseUrl = await startApi();
    const plan = generateLearningPlan(goal, new Date("2026-08-01T10:00:00.000Z"));
    const createHeaders = { ...writeOrigin, Cookie: "session=alice", "Idempotency-Key": "create-plan", "If-None-Match": "*" };
    await fetch(`${baseUrl}/api/sync/plans/${plan.id}`, { method: "PUT", headers: createHeaders, body: JSON.stringify(plan) });
    const conflict = await fetch(`${baseUrl}/api/sync/plans/${plan.id}`, {
      method: "PUT",
      headers: { ...writeOrigin, Cookie: "session=alice", "Idempotency-Key": "stale-write", "If-None-Match": "*" },
      body: JSON.stringify(plan),
    });
    const bobPull = await fetch(`${baseUrl}/api/sync/changes`, { headers: { Cookie: "session=bob" } });

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: "revision-conflict", current: { revision: 1 } });
    await expect(bobPull.json()).resolves.toMatchObject({ changes: [] });
  });

  it("writes a validated daily record only after its owned plan exists", async () => {
    const baseUrl = await startApi();
    const plan = generateLearningPlan(goal, new Date("2026-08-01T10:00:00.000Z"));
    const record = initializeLearningState(plan, new Date("2026-08-01T10:00:00.000Z")).days[0];
    const recordId = `${plan.id}:day-1`;
    const writeRecord = (cookie: string) => fetch(`${baseUrl}/api/sync/daily-records/${encodeURIComponent(recordId)}`, {
      method: "PUT",
      headers: { ...writeOrigin, Cookie: cookie, "Idempotency-Key": "create-day", "If-None-Match": "*" },
      body: JSON.stringify({ planId: plan.id, record }),
    });

    expect((await writeRecord("session=alice")).status).toBe(422);
    await fetch(`${baseUrl}/api/sync/plans/${plan.id}`, {
      method: "PUT",
      headers: { ...writeOrigin, Cookie: "session=alice", "Idempotency-Key": "create-plan", "If-None-Match": "*" },
      body: JSON.stringify(plan),
    });
    const created = await writeRecord("session=alice");
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({ entityType: "daily-record", revision: 1 });
  });

  it("rejects cross-origin writes before reading their content", async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/sync/plans/plan-1`, {
      method: "PUT",
      headers: { Origin: "https://attacker.example", Cookie: "session=alice", "Idempotency-Key": "attack", "If-None-Match": "*" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(403);
  });

  it("maps invalid cursors and idempotency-key reuse to stable client errors", async () => {
    const baseUrl = await startApi();
    const plan = generateLearningPlan(goal, new Date("2026-08-01T10:00:00.000Z"));
    const endpoint = `${baseUrl}/api/sync/plans/${plan.id}`;
    const headers = { ...writeOrigin, Cookie: "session=alice", "Idempotency-Key": "same-operation", "If-None-Match": "*" };
    await fetch(endpoint, { method: "PUT", headers, body: JSON.stringify(plan) });
    const reusedKey = await fetch(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...plan, createdAt: "2026-08-02T10:00:00.000Z" }),
    });
    const invalidCursor = await fetch(`${baseUrl}/api/sync/changes?cursor=not-issued`, { headers: { Cookie: "session=alice" } });

    expect(reusedKey.status).toBe(409);
    await expect(reusedKey.json()).resolves.toMatchObject({ error: "idempotency-mismatch" });
    expect(invalidCursor.status).toBe(400);
    await expect(invalidCursor.json()).resolves.toMatchObject({ error: "invalid-cursor" });
  });
});
