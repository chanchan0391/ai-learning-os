import { describe, expect, it } from "vitest";
import {
  completeCurrentDay,
  completedDayCount,
  getCurrentRecord,
  initializeLearningState,
  learningStreak,
  parseLearningState,
  toggleCurrentTask,
} from "./learning-state";
import { generateLearningPlan } from "./planner";

const goal = {
  subject: "AI Agent 工程",
  currentLevel: "Java 高级工程师",
  targetOutcome: "独立交付企业级 Agent 应用",
  dailyMinutes: 60,
  durationWeeks: 12,
};

function completedState() {
  const plan = generateLearningPlan(goal, new Date("2026-07-30T10:00:00.000Z"));
  let state = initializeLearningState(plan, new Date("2026-07-30T10:00:00.000Z"));
  for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
  return state;
}

describe("multi-day learning state", () => {
  it("migrates a valid v1 plan into versioned state", () => {
    const plan = generateLearningPlan(goal, new Date("2026-07-30T10:00:00.000Z"));
    const result = parseLearningState(JSON.stringify(plan), new Date("2026-07-31T08:00:00.000Z"));

    expect(result.status).toBe("migrated");
    expect(result.state).toMatchObject({ version: 2, currentDay: 1 });
    expect(result.state?.days[0].tasks).toHaveLength(4);
  });

  it("rejects corrupt saved data instead of trusting a partial object", () => {
    expect(parseLearningState("{broken").status).toBe("recovered");
    expect(parseLearningState(JSON.stringify({ version: 2, days: [] })).state).toBeNull();
  });

  it("requires every task before closing the day", () => {
    const plan = generateLearningPlan(goal);
    const state = initializeLearningState(plan);
    expect(() => completeCurrentDay(state, { difficulty: "just-right", reflection: "" })).toThrow("请先完成今天的全部任务");
  });

  it("records feedback and creates an adaptive next-day loop", () => {
    const state = completeCurrentDay(
      completedState(),
      { difficulty: "too-hard", reflection: "工具调用失败后如何恢复？" },
      new Date("2026-07-31T10:00:00.000Z"),
    );

    expect(state.currentDay).toBe(2);
    expect(state.days[0]).toMatchObject({ status: "completed", feedback: { difficulty: "too-hard" } });
    expect(state.days[1].tasks.map((task) => task.type)).toEqual(["diagnose", "learn", "practice", "reflect"]);
    expect(state.days[1].tasks.reduce((sum, task) => sum + task.minutes, 0)).toBe(60);
    expect(state.days[1].tasks[1].description).toContain("先缩小范围");
    expect(completedDayCount(state)).toBe(1);
    expect(learningStreak(state)).toBe(1);
  });

  it("preserves prior history while advancing consecutive days", () => {
    let state = completeCurrentDay(completedState(), { difficulty: "just-right", reflection: "" });
    for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
    state = completeCurrentDay(state, { difficulty: "too-easy", reflection: "增加真实约束" });

    expect(state.currentDay).toBe(3);
    expect(completedDayCount(state)).toBe(2);
    expect(learningStreak(state)).toBe(2);
    expect(state.days.map((day) => day.day)).toEqual([1, 2, 3]);
  });

  it("does not reopen a completed final day", () => {
    const plan = generateLearningPlan({ ...goal, durationWeeks: 1 });
    let state = initializeLearningState(plan);
    state = { ...state, currentDay: 7, days: [{ ...state.days[0], day: 7, tasks: state.days[0].tasks.map((task) => ({ ...task, completed: true })) }] };
    state = completeCurrentDay(state, { difficulty: "just-right", reflection: "完成" });

    expect(state.currentDay).toBe(7);
    expect(getCurrentRecord(state).status).toBe("completed");
    expect(toggleCurrentTask(state, getCurrentRecord(state).tasks[0].id)).toBe(state);
  });
});
