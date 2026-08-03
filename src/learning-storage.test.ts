// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { completeCurrentDay, getCurrentRecord, initializeLearningState, startStageMasteryFollowUp, toggleCurrentTask } from "./learning-state";
import {
  BrowserLearningStateRepository,
  ACTIVE_LEARNING_STATES_KEY,
  ARCHIVED_LEARNING_STATES_KEY,
  CURRENT_LEARNING_STATE_KEY,
  LEGACY_LEARNING_PLAN_KEY,
  PREVIOUS_LEARNING_STATE_KEY,
  PORTFOLIO_DAILY_BUDGET_KEY,
} from "./learning-storage";
import { generateLearningPlan } from "./planner";

const goal = {
  subject: "分布式系统",
  currentLevel: "了解单体应用",
  targetOutcome: "能设计可恢复的服务",
  dailyMinutes: 45,
  durationWeeks: 8,
};

describe("browser learning-state repository", () => {
  beforeEach(() => localStorage.clear());

  it("loads and saves the current state through one persistence boundary", () => {
    const repository = new BrowserLearningStateRepository(localStorage);
    const state = initializeLearningState(generateLearningPlan(goal));

    repository.save(state);

    expect(repository.load()).toEqual({ state, status: "valid" });
    expect(repository.loadActive()).toEqual([state]);
  });

  it("keeps multiple active goals and restores the selected goal across reloads", () => {
    const repository = new BrowserLearningStateRepository(localStorage);
    const first = initializeLearningState(generateLearningPlan(goal));
    const second = initializeLearningState(generateLearningPlan({ ...goal, subject: "事件驱动架构" }, new Date("2026-08-02T10:00:00.000Z")));

    repository.save(first);
    repository.save(second);

    expect(repository.loadActive().map((state) => state.plan.goal.subject)).toEqual(["事件驱动架构", "分布式系统"]);
    expect(repository.load().state?.plan.id).toBe(second.plan.id);
    expect(repository.selectActive(first.plan.id)).toEqual(first);
    expect(repository.load().state?.plan.id).toBe(first.plan.id);

    repository.deselectActive();
    expect(repository.load()).toEqual({ state: null, status: "empty" });
    expect(repository.loadActive()).toHaveLength(2);
    expect(localStorage.getItem(CURRENT_LEARNING_STATE_KEY)).toBeNull();
  });

  it("replaces synchronized active goals without changing the current selection", () => {
    const repository = new BrowserLearningStateRepository(localStorage);
    const first = initializeLearningState(generateLearningPlan(goal));
    const second = initializeLearningState(generateLearningPlan({ ...goal, subject: "事件驱动架构" }, new Date("2026-08-02T10:00:00.000Z")));
    const remote = initializeLearningState(generateLearningPlan({ ...goal, subject: "数据库内核" }, new Date("2026-08-03T10:00:00.000Z")));
    repository.save(first);
    repository.save(second);
    repository.selectActive(first.plan.id);

    repository.replaceActive([second, first, remote]);

    expect(repository.load().state?.plan.id).toBe(first.plan.id);
    expect(repository.loadActive().map((state) => state.plan.id)).toEqual([second.plan.id, first.plan.id, remote.plan.id]);
  });

  it("migrates the former single active state into the active-goal collection", () => {
    const repository = new BrowserLearningStateRepository(localStorage);
    const state = initializeLearningState(generateLearningPlan(goal));
    localStorage.setItem(CURRENT_LEARNING_STATE_KEY, JSON.stringify(state));

    expect(repository.load()).toEqual({ state, status: "valid" });
    expect(JSON.parse(localStorage.getItem(ACTIVE_LEARNING_STATES_KEY)!)).toEqual({ selectedPlanId: state.plan.id, states: [state] });
  });

  it("promotes a legacy plan and removes obsolete keys", () => {
    const repository = new BrowserLearningStateRepository(localStorage);
    const plan = generateLearningPlan(goal, new Date("2026-07-31T10:00:00.000Z"));
    localStorage.setItem(LEGACY_LEARNING_PLAN_KEY, JSON.stringify(plan));

    const result = repository.load(new Date("2026-08-01T10:00:00.000Z"));

    expect(result.status).toBe("migrated");
    expect(JSON.parse(localStorage.getItem(CURRENT_LEARNING_STATE_KEY)!).version).toBe(3);
    expect(localStorage.getItem(LEGACY_LEARNING_PLAN_KEY)).toBeNull();
  });

  it("clears current and legacy keys when stored data is corrupt", () => {
    const repository = new BrowserLearningStateRepository(localStorage);
    localStorage.setItem(CURRENT_LEARNING_STATE_KEY, "{broken");
    localStorage.setItem(PREVIOUS_LEARNING_STATE_KEY, "old");
    localStorage.setItem(LEGACY_LEARNING_PLAN_KEY, "older");

    expect(repository.load().status).toBe("recovered");
    expect(localStorage.getItem(CURRENT_LEARNING_STATE_KEY)).toBeNull();
    expect(localStorage.getItem(PREVIOUS_LEARNING_STATE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_LEARNING_PLAN_KEY)).toBeNull();
  });

  it("degrades to a recoverable empty state when storage access is denied", () => {
    const deniedStorage: Storage = {
      length: 0,
      clear: () => { throw new DOMException("denied", "SecurityError"); },
      getItem: () => { throw new DOMException("denied", "SecurityError"); },
      key: () => null,
      removeItem: () => { throw new DOMException("denied", "SecurityError"); },
      setItem: () => { throw new DOMException("denied", "SecurityError"); },
    };

    expect(new BrowserLearningStateRepository(deniedStorage).load()).toEqual({ state: null, status: "recovered" });
  });

  it("removes every supported local version", () => {
    const repository = new BrowserLearningStateRepository(localStorage);
    for (const key of [CURRENT_LEARNING_STATE_KEY, PREVIOUS_LEARNING_STATE_KEY, LEGACY_LEARNING_PLAN_KEY, ARCHIVED_LEARNING_STATES_KEY, ACTIVE_LEARNING_STATES_KEY, PORTFOLIO_DAILY_BUDGET_KEY]) {
      localStorage.setItem(key, "data");
    }

    repository.clear();

    expect(localStorage.length).toBe(0);
  });

  it("persists and validates the local cross-goal daily budget", () => {
    const repository = new BrowserLearningStateRepository(localStorage);

    repository.saveDailyBudget(90);
    expect(repository.loadDailyBudget()).toBe(90);
    expect(localStorage.getItem(PORTFOLIO_DAILY_BUDGET_KEY)).toBe("90");
    expect(() => repository.saveDailyBudget(0)).toThrow("15–1440");

    localStorage.setItem(PORTFOLIO_DAILY_BUDGET_KEY, "invalid");
    expect(repository.loadDailyBudget()).toBeNull();
    expect(localStorage.getItem(PORTFOLIO_DAILY_BUDGET_KEY)).toBeNull();
  });

  it("archives a completed goal as a full snapshot and can restore it", () => {
    const repository = new BrowserLearningStateRepository(localStorage);
    let state = initializeLearningState(generateLearningPlan({ ...goal, durationWeeks: 1 }));
    for (let index = 0; index < 7; index += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      state = completeCurrentDay(state, { difficulty: "just-right", reflection: `完成第 ${index + 1} 天` }, new Date(`2026-08-0${index + 1}T10:00:00.000Z`));
    }
    repository.save(state);

    const archived = repository.archiveCompleted(state, new Date("2026-08-08T10:00:00.000Z"));

    expect(repository.load().state).toBeNull();
    expect(archived).toEqual([{ archivedAt: "2026-08-08T10:00:00.000Z", state }]);
    expect(repository.loadArchived()).toEqual(archived);
    expect(repository.restoreArchived(state.plan.id)).toEqual(state);
    expect(repository.load().state).toEqual(state);
    expect(repository.loadArchived()).toEqual([]);
  });

  it("archives completed final-stage follow-up evidence with the goal", () => {
    const repository = new BrowserLearningStateRepository(localStorage);
    let state = initializeLearningState(generateLearningPlan({ ...goal, durationWeeks: 1 }));
    for (let index = 0; index < 7; index += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      state = completeCurrentDay(state, { difficulty: "just-right", reflection: "" });
    }
    state = startStageMasteryFollowUp(state, "stage-1");
    for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
    state = completeCurrentDay(state, { difficulty: "just-right", reflection: "补充了最终证据" });
    repository.save(state);

    const archived = repository.archiveCompleted(state, new Date("2026-08-10T10:00:00.000Z"));

    expect(archived[0].state.days).toHaveLength(8);
    expect(archived[0].state.days[7].artifacts["day-8-stage-mastery-stage-1"].stageMasteryRemediation).toMatchObject({ stageId: "stage-1" });
  });

  it("refuses to archive an unfinished goal", () => {
    const repository = new BrowserLearningStateRepository(localStorage);
    const state = initializeLearningState(generateLearningPlan(goal));

    expect(() => repository.archiveCompleted(state)).toThrow("只有完成全部计划学习日后才能归档目标");
    expect(repository.loadArchived()).toEqual([]);
  });

  it("selects another active goal after archiving a completed goal", () => {
    const repository = new BrowserLearningStateRepository(localStorage);
    const remaining = initializeLearningState(generateLearningPlan({ ...goal, subject: "事件驱动架构" }));
    let completed = initializeLearningState(generateLearningPlan({ ...goal, durationWeeks: 1 }, new Date("2026-08-02T10:00:00.000Z")));
    repository.save(remaining);
    for (let index = 0; index < 7; index += 1) {
      for (const task of getCurrentRecord(completed).tasks) completed = toggleCurrentTask(completed, task.id);
      completed = completeCurrentDay(completed, { difficulty: "just-right", reflection: "完成" });
    }
    repository.save(completed);

    repository.archiveCompleted(completed);

    expect(repository.load().state?.plan.id).toBe(remaining.plan.id);
    expect(repository.loadActive()).toEqual([remaining]);
  });

  it("merges newly downloaded archives without replacing an existing local snapshot", () => {
    const repository = new BrowserLearningStateRepository(localStorage);
    const local = { archivedAt: "2026-08-08T10:00:00.000Z", state: initializeLearningState(generateLearningPlan(goal)) };
    const remoteDuplicate = { archivedAt: "2026-08-09T10:00:00.000Z", state: { ...structuredClone(local.state), currentDay: 1 } };
    const remoteNew = {
      archivedAt: "2026-08-10T10:00:00.000Z",
      state: initializeLearningState(generateLearningPlan({ ...goal, subject: "事件驱动架构" }, new Date("2026-08-02T10:00:00.000Z"))),
    };

    expect(repository.mergeArchived([local])).toEqual([local]);
    expect(repository.mergeArchived([remoteDuplicate, remoteNew])).toEqual([remoteNew, local]);
    expect(repository.loadArchived()).toEqual([remoteNew, local]);
  });
});
