import { readFile } from "node:fs/promises";
import { newDb } from "pg-mem";
import { afterEach, describe, expect, it } from "vitest";
import { initializeLearningState } from "../../src/learning-state";
import { generateLearningPlan } from "../../src/planner";
import { PostgresSyncStore } from "./postgres-sync-store";
import { MAX_SYNC_IDENTIFIER_LENGTH, SyncConflictError, SyncRequestError, type SyncPrincipal } from "./sync-store";

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
const pools: Array<{ end(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

async function setup() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  pools.push(pool);
  const migration = await readFile(new URL("./migrations/001-initial-sync-schema.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query("INSERT INTO users (id) VALUES ($1), ($2)", [alice.userId, bob.userId]);
  await pool.query(
    `INSERT INTO sync_devices (user_id, id, label) VALUES
      ($1, $2, 'Alice phone'), ($1, $3, 'Alice laptop'), ($4, $2, 'Bob phone')`,
    [alice.userId, alice.deviceId, aliceLaptop.deviceId, bob.userId],
  );
  let cursor = 0;
  let now = new Date("2026-07-31T12:00:00.000Z");
  const store = new PostgresSyncStore(
    pool,
    () => now,
    () => `opaque-${++cursor}`,
  );
  const plan = generateLearningPlan(goal, new Date("2026-07-31T10:00:00.000Z"));
  return { pool, store, plan, state: initializeLearningState(plan), setNow: (value: Date) => { now = value; } };
}

describe("PostgreSQL sync store", () => {
  it("creates and conditionally updates plans with durable revisions", async () => {
    const { store, plan } = await setup();
    const created = await store.putPlan(alice, {
      operationId: "op-create", entityId: plan.id, baseRevision: null, value: plan,
    });
    const updated = await store.putPlan(aliceLaptop, {
      operationId: "op-update",
      entityId: plan.id,
      baseRevision: 1,
      value: { ...plan, goal: { ...plan.goal, targetOutcome: "能评审可恢复的服务" } },
    });

    expect(created.revision).toBe(1);
    expect(updated).toMatchObject({ revision: 2, value: { goal: { targetOutcome: "能评审可恢复的服务" } } });
  });

  it("returns the current entity on a stale revision", async () => {
    const { store, plan } = await setup();
    await store.putPlan(alice, { operationId: "op-create", entityId: plan.id, baseRevision: null, value: plan });
    await store.putPlan(alice, {
      operationId: "op-update", entityId: plan.id, baseRevision: 1,
      value: { ...plan, createdAt: "2026-07-31T11:00:00.000Z" },
    });

    await expect(store.putPlan(aliceLaptop, {
      operationId: "op-stale", entityId: plan.id, baseRevision: 1, value: plan,
    })).rejects.toMatchObject({ code: "revision-conflict", current: { revision: 2 } });
  });

  it("persists idempotent operation results and rejects changed retries", async () => {
    const { pool, store, plan } = await setup();
    const request = { operationId: "op-create", entityId: plan.id, baseRevision: null, value: plan };
    const first = await store.putPlan(alice, request);
    const retry = await store.putPlan(aliceLaptop, request);

    expect(retry).toEqual(first);
    await expect(store.putPlan(alice, {
      ...request, value: { ...plan, createdAt: "2026-08-01T10:00:00.000Z" },
    })).rejects.toMatchObject({ code: "idempotency-mismatch" } satisfies Partial<SyncRequestError>);
    const operationCount = await pool.query("SELECT count(*)::int AS count FROM sync_operations");
    expect(operationCount.rows[0].count).toBe(1);
  });

  it("accepts an idempotent retry with equivalent JSON key ordering", async () => {
    const { store, plan } = await setup();
    const first = await store.putPlan(alice, {
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

    await expect(store.putPlan(aliceLaptop, {
      value: reorderedPlan,
      baseRevision: null,
      entityId: plan.id,
      operationId: "op-create",
    })).resolves.toEqual(first);
  });

  it("returns isolated incremental changes through opaque cursors", async () => {
    const { store, plan, state } = await setup();
    await store.putPlan(alice, { operationId: "op-plan", entityId: plan.id, baseRevision: null, value: plan });
    await store.putPlan(bob, { operationId: "op-bob-plan", entityId: plan.id, baseRevision: null, value: plan });
    const firstPull = await store.getChanges(aliceLaptop);
    await store.putDailyRecord(alice, {
      operationId: "op-day",
      entityId: `${plan.id}:day-1`,
      baseRevision: null,
      value: { planId: plan.id, record: state.days[0] },
    });
    const secondPull = await store.getChanges(aliceLaptop, firstPull.cursor);

    expect(firstPull.changes.map((change) => change.entityType)).toEqual(["learning-plan"]);
    expect(secondPull.changes.map((change) => change.entityType)).toEqual(["daily-record"]);
    await expect(store.getChanges(aliceLaptop, secondPull.cursor)).resolves.toMatchObject({ changes: [] });
    await expect(store.getChanges(bob, firstPull.cursor)).rejects.toMatchObject(
      { code: "invalid-cursor" } satisfies Partial<SyncRequestError>,
    );
  });

  it("paginates account snapshots with an opaque continuation cursor", async () => {
    const { pool, plan, state } = await setup();
    let cursor = 0;
    const store = new PostgresSyncStore(
      pool,
      () => new Date("2026-07-31T12:00:00.000Z"),
      () => `page-${++cursor}`,
      2,
    );
    await store.putPlan(alice, { operationId: "page-plan", entityId: plan.id, baseRevision: null, value: plan });
    for (let day = 1; day <= 3; day += 1) {
      await store.putDailyRecord(alice, {
        operationId: `page-day-${day}`,
        entityId: `${plan.id}:day-${day}`,
        baseRevision: null,
        value: { planId: plan.id, record: { ...state.days[0], day } },
      });
    }

    const first = await store.getChanges(alice);
    const second = await store.getChanges(alice, first.cursor);

    expect(first).toMatchObject({ hasMore: true });
    expect(second).toMatchObject({ hasMore: false });
    expect([...first.changes, ...second.changes].map((entity) => entity.entityId)).toEqual([
      plan.id,
      `${plan.id}:day-1`,
      `${plan.id}:day-2`,
      `${plan.id}:day-3`,
    ]);
  });

  it("paginates account snapshots by encoded bytes without skipping entities", async () => {
    const { pool, plan, state } = await setup();
    let cursor = 0;
    const store = new PostgresSyncStore(
      pool,
      () => new Date("2026-07-31T12:00:00.000Z"),
      () => `bytes-${++cursor}`,
      250,
      2_000,
    );
    await store.putPlan(alice, { operationId: "bytes-plan", entityId: plan.id, baseRevision: null, value: plan });
    await store.putDailyRecord(alice, {
      operationId: "bytes-day", entityId: `${plan.id}:day-1`, baseRevision: null,
      value: { planId: plan.id, record: state.days[0] },
    });

    const first = await store.getChanges(alice);
    const second = await store.getChanges(alice, first.cursor);

    expect(first).toMatchObject({ hasMore: true });
    expect(first.changes).toHaveLength(1);
    expect(second).toMatchObject({ hasMore: false });
    expect([...first.changes, ...second.changes].map((entity) => entity.entityType))
      .toEqual(["learning-plan", "daily-record"]);
  });

  it("requires an active provisioned device and an owned plan", async () => {
    const { store, plan, state } = await setup();
    await store.putPlan(alice, { operationId: "op-plan", entityId: plan.id, baseRevision: null, value: plan });

    await expect(store.putDailyRecord(bob, {
      operationId: "op-day", entityId: `${plan.id}:day-1`, baseRevision: null,
      value: { planId: plan.id, record: state.days[0] },
    })).rejects.toMatchObject({ code: "missing-plan" } satisfies Partial<SyncRequestError>);
    await expect(store.getChanges({ userId: alice.userId, deviceId: "unknown-device" }))
      .rejects.toMatchObject({ code: "unknown-principal" } satisfies Partial<SyncRequestError>);
  });

  it("rejects oversized indexed identifiers before querying sync metadata", async () => {
    const { store, plan } = await setup();
    const oversized = "x".repeat(MAX_SYNC_IDENTIFIER_LENGTH + 1);

    await expect(store.putPlan(alice, {
      operationId: oversized, entityId: plan.id, baseRevision: null, value: plan,
    })).rejects.toThrow(/1-256 characters/);
    await expect(store.getChanges(alice, oversized)).rejects.toMatchObject(
      { code: "invalid-cursor" } satisfies Partial<SyncRequestError>,
    );
  });

  it("expires cursors and idempotency records after 30 days without deleting learning data", async () => {
    const { pool, store, plan, setNow } = await setup();
    await store.putPlan(alice, { operationId: "op-plan", entityId: plan.id, baseRevision: null, value: plan });
    const firstPull = await store.getChanges(alice);
    await pool.query("UPDATE sync_operations SET created_at = $1", ["2026-07-01T00:00:00.000Z"]);
    await pool.query("UPDATE sync_cursors SET created_at = $1", ["2026-07-01T00:00:00.000Z"]);

    setNow(new Date("2026-09-01T12:00:00.000Z"));
    const freshPull = await store.getChanges(alice);

    expect(freshPull.changes).toHaveLength(1);
    await expect(store.getChanges(alice, firstPull.cursor)).rejects.toMatchObject(
      { code: "invalid-cursor" } satisfies Partial<SyncRequestError>,
    );
    await expect(store.putPlan(alice, {
      operationId: "op-plan", entityId: plan.id, baseRevision: null, value: plan,
    })).rejects.toMatchObject({ code: "revision-conflict" } satisfies Partial<SyncConflictError>);
    const [operations, cursors, plans] = await Promise.all([
      pool.query("SELECT count(*)::int AS count FROM sync_operations"),
      pool.query("SELECT count(*)::int AS count FROM sync_cursors"),
      pool.query("SELECT count(*)::int AS count FROM learning_plans"),
    ]);
    expect([operations.rows[0].count, cursors.rows[0].count, plans.rows[0].count]).toEqual([0, 1, 1]);
  });
});
