import { describe, expect, it } from "vitest";
import { initializeLearningState } from "../../src/learning-state";
import { generateLearningPlan } from "../../src/planner";
import {
  InMemorySyncStore,
  MAX_SYNC_IDENTIFIER_LENGTH,
  SyncConflictError,
  SyncRequestError,
  type SyncPrincipal,
} from "./sync-store";

const alice: SyncPrincipal = { userId: "user-alice", deviceId: "device-phone" };
const aliceLaptop: SyncPrincipal = { userId: "user-alice", deviceId: "device-laptop" };
const bob: SyncPrincipal = { userId: "user-bob", deviceId: "device-phone" };
const goal = {
  subject: "分布式系统",
  currentLevel: "了解单体应用",
  targetOutcome: "能设计可恢复的服务",
  dailyMinutes: 45,
  durationWeeks: 8,
};

function setup() {
  let cursor = 0;
  const store = new InMemorySyncStore(
    () => new Date("2026-07-31T12:00:00.000Z"),
    () => `opaque-${++cursor}`,
  );
  const plan = generateLearningPlan(goal, new Date("2026-07-31T10:00:00.000Z"));
  return { store, plan, state: initializeLearningState(plan) };
}

describe("in-memory sync store", () => {
  it("creates and conditionally updates an entity with increasing revisions", () => {
    const { store, plan } = setup();
    const created = store.putPlan(alice, { operationId: "op-create", entityId: plan.id, baseRevision: null, value: plan });
    const updatedPlan = { ...plan, goal: { ...plan.goal, targetOutcome: "能评审可恢复的服务" } };
    const updated = store.putPlan(aliceLaptop, { operationId: "op-update", entityId: plan.id, baseRevision: 1, value: updatedPlan });

    expect(created.revision).toBe(1);
    expect(updated).toMatchObject({ revision: 2, value: { goal: { targetOutcome: "能评审可恢复的服务" } } });
  });

  it("returns the current entity when a stale device causes a revision conflict", () => {
    const { store, plan } = setup();
    store.putPlan(alice, { operationId: "op-create", entityId: plan.id, baseRevision: null, value: plan });
    store.putPlan(alice, { operationId: "op-update", entityId: plan.id, baseRevision: 1, value: { ...plan, createdAt: "2026-07-31T11:00:00.000Z" } });

    expect(() => store.putPlan(aliceLaptop, {
      operationId: "op-stale",
      entityId: plan.id,
      baseRevision: 1,
      value: plan,
    })).toThrow(SyncConflictError);
    try {
      store.putPlan(aliceLaptop, { operationId: "op-stale-2", entityId: plan.id, baseRevision: 1, value: plan });
    } catch (error) {
      expect(error).toBeInstanceOf(SyncConflictError);
      expect((error as SyncConflictError).current?.revision).toBe(2);
    }
  });

  it("makes retries idempotent and rejects operation ID reuse with different content", () => {
    const { store, plan } = setup();
    const request = { operationId: "op-create", entityId: plan.id, baseRevision: null, value: plan };
    const first = store.putPlan(alice, request);
    const retry = store.putPlan(aliceLaptop, request);

    expect(retry).toEqual(first);
    expect(store.getChanges(alice).changes).toHaveLength(1);
    expect(() => store.putPlan(alice, { ...request, value: { ...plan, createdAt: "2026-08-01T10:00:00.000Z" } })).toThrowError(
      expect.objectContaining<Partial<SyncRequestError>>({ code: "idempotency-mismatch" }),
    );
  });

  it("treats equivalent JSON key orders as the same idempotent operation", () => {
    const { store, plan } = setup();
    const first = store.putPlan(alice, {
      operationId: "op-create", entityId: plan.id, baseRevision: null, value: plan,
    });
    const reorderedPlan = {
      notes: plan.notes,
      today: plan.today,
      stages: plan.stages,
      goal: {
        durationWeeks: plan.goal.durationWeeks,
        dailyMinutes: plan.goal.dailyMinutes,
        targetOutcome: plan.goal.targetOutcome,
        currentLevel: plan.goal.currentLevel,
        subject: plan.goal.subject,
      },
      createdAt: plan.createdAt,
      id: plan.id,
    };

    expect(store.putPlan(aliceLaptop, {
      value: reorderedPlan,
      baseRevision: null,
      entityId: plan.id,
      operationId: "op-create",
    })).toEqual(first);
  });

  it("returns only changes after an opaque cursor", () => {
    const { store, plan, state } = setup();
    store.putPlan(alice, { operationId: "op-plan", entityId: plan.id, baseRevision: null, value: plan });
    const firstPull = store.getChanges(aliceLaptop);
    store.putDailyRecord(alice, {
      operationId: "op-day",
      entityId: `${plan.id}:day-1`,
      baseRevision: null,
      value: { planId: plan.id, record: state.days[0] },
    });
    const secondPull = store.getChanges(aliceLaptop, firstPull.cursor);

    expect(firstPull.changes.map((change) => change.entityType)).toEqual(["learning-plan"]);
    expect(secondPull.changes.map((change) => change.entityType)).toEqual(["daily-record"]);
    expect(store.getChanges(aliceLaptop, secondPull.cursor).changes).toEqual([]);
  });

  it("paginates large snapshots without skipping or repeating entities", () => {
    let cursor = 0;
    const store = new InMemorySyncStore(
      () => new Date("2026-07-31T12:00:00.000Z"),
      () => `page-${++cursor}`,
      2,
    );
    const plan = generateLearningPlan(goal, new Date("2026-07-31T10:00:00.000Z"));
    const state = initializeLearningState(plan);
    store.putPlan(alice, { operationId: "page-plan", entityId: plan.id, baseRevision: null, value: plan });
    for (let day = 1; day <= 3; day += 1) {
      store.putDailyRecord(alice, {
        operationId: `page-day-${day}`,
        entityId: `${plan.id}:day-${day}`,
        baseRevision: null,
        value: { planId: plan.id, record: { ...state.days[0], day } },
      });
    }

    const first = store.getChanges(alice);
    const second = store.getChanges(alice, first.cursor);

    expect(first).toMatchObject({ hasMore: true });
    expect(second).toMatchObject({ hasMore: false });
    expect([...first.changes, ...second.changes].map((entity) => entity.entityId)).toEqual([
      plan.id,
      `${plan.id}:day-1`,
      `${plan.id}:day-2`,
      `${plan.id}:day-3`,
    ]);
  });

  it("paginates by encoded bytes without skipping entities", () => {
    let cursor = 0;
    const store = new InMemorySyncStore(
      () => new Date("2026-07-31T12:00:00.000Z"),
      () => `bytes-${++cursor}`,
      250,
      2_000,
    );
    const plan = generateLearningPlan(goal, new Date("2026-07-31T10:00:00.000Z"));
    const state = initializeLearningState(plan);
    store.putPlan(alice, { operationId: "bytes-plan", entityId: plan.id, baseRevision: null, value: plan });
    store.putDailyRecord(alice, {
      operationId: "bytes-day", entityId: `${plan.id}:day-1`, baseRevision: null,
      value: { planId: plan.id, record: state.days[0] },
    });

    const first = store.getChanges(alice);
    const second = store.getChanges(alice, first.cursor);

    expect(first).toMatchObject({ hasMore: true });
    expect(first.changes).toHaveLength(1);
    expect(second).toMatchObject({ hasMore: false });
    expect([...first.changes, ...second.changes].map((entity) => entity.entityType))
      .toEqual(["learning-plan", "daily-record"]);
  });

  it("isolates entities, operations, and cursors by authenticated user", () => {
    const { store, plan } = setup();
    store.putPlan(alice, { operationId: "same-operation", entityId: plan.id, baseRevision: null, value: plan });
    store.putPlan(bob, { operationId: "same-operation", entityId: plan.id, baseRevision: null, value: plan });
    const alicePull = store.getChanges(alice);

    expect(alicePull.changes).toHaveLength(1);
    expect(store.getChanges(bob).changes).toHaveLength(1);
    expect(() => store.getChanges(bob, alicePull.cursor)).toThrowError(
      expect.objectContaining<Partial<SyncRequestError>>({ code: "invalid-cursor" }),
    );
  });

  it("rejects oversized indexed identifiers and cursors", () => {
    const { store, plan } = setup();
    const oversized = "x".repeat(MAX_SYNC_IDENTIFIER_LENGTH + 1);

    expect(() => store.putPlan(alice, {
      operationId: oversized, entityId: plan.id, baseRevision: null, value: plan,
    })).toThrow(/1-256 characters/);
    expect(() => store.putPlan(alice, {
      operationId: "bounded-operation", entityId: oversized, baseRevision: null, value: plan,
    })).toThrow(/1-256 characters/);
    expect(() => store.getChanges(alice, oversized)).toThrowError(
      expect.objectContaining<Partial<SyncRequestError>>({ code: "invalid-cursor" }),
    );
  });

  it("does not allow a daily record to reference another user's plan", () => {
    const { store, plan, state } = setup();
    store.putPlan(alice, { operationId: "op-plan", entityId: plan.id, baseRevision: null, value: plan });

    expect(() => store.putDailyRecord(bob, {
      operationId: "op-day",
      entityId: `${plan.id}:day-1`,
      baseRevision: null,
      value: { planId: plan.id, record: state.days[0] },
    })).toThrowError(expect.objectContaining<Partial<SyncRequestError>>({ code: "missing-plan" }));
  });

  it("enforces account entity and encoded-byte quotas without charging updates twice", () => {
    const plan = generateLearningPlan(goal, new Date("2026-07-31T10:00:00.000Z"));
    const planBytes = Buffer.byteLength(JSON.stringify(plan), "utf8");
    const entityLimited = new InMemorySyncStore(undefined, undefined, 250, undefined, {
      maxEntities: 1,
      maxBytes: planBytes * 2,
    });
    entityLimited.putPlan(alice, { operationId: "plan", entityId: plan.id, baseRevision: null, value: plan });

    expect(() => entityLimited.putDailyRecord(alice, {
      operationId: "day",
      entityId: `${plan.id}:day-1`,
      baseRevision: null,
      value: { planId: plan.id, record: initializeLearningState(plan).days[0] },
    })).toThrowError(expect.objectContaining<Partial<SyncRequestError>>({ code: "storage-quota-exceeded" }));

    const byteLimited = new InMemorySyncStore(undefined, undefined, 250, undefined, {
      maxEntities: 10,
      maxBytes: planBytes,
    });
    byteLimited.putPlan(alice, { operationId: "create", entityId: plan.id, baseRevision: null, value: plan });
    expect(byteLimited.putPlan(alice, {
      operationId: "same-size", entityId: plan.id, baseRevision: 1, value: plan,
    })).toMatchObject({ revision: 2 });
    expect(() => byteLimited.putPlan(alice, {
      operationId: "grow", entityId: plan.id, baseRevision: 2,
      value: { ...plan, goal: { ...plan.goal, targetOutcome: `${plan.goal.targetOutcome}扩容` } },
    })).toThrowError(expect.objectContaining<Partial<SyncRequestError>>({ code: "storage-quota-exceeded" }));
  });
});
