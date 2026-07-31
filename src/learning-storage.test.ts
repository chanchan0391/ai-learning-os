// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { initializeLearningState } from "./learning-state";
import {
  BrowserLearningStateRepository,
  CURRENT_LEARNING_STATE_KEY,
  LEGACY_LEARNING_PLAN_KEY,
  PREVIOUS_LEARNING_STATE_KEY,
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
    for (const key of [CURRENT_LEARNING_STATE_KEY, PREVIOUS_LEARNING_STATE_KEY, LEGACY_LEARNING_PLAN_KEY]) {
      localStorage.setItem(key, "data");
    }

    repository.clear();

    expect(localStorage.length).toBe(0);
  });
});
