import { describe, expect, it } from "vitest";
import { completionRate, generateLearningPlan, validateGoal } from "./planner";
import type { LearningGoal } from "./types";

const goal: LearningGoal = {
  subject: "AI Agent 工程",
  currentLevel: "Java 高级工程师",
  targetOutcome: "独立交付企业级 Agent 应用",
  dailyMinutes: 60,
  durationWeeks: 12,
};

describe("Planner Agent domain", () => {
  it("generates a staged plan with a complete first-day loop", () => {
    const plan = generateLearningPlan(goal, new Date("2026-07-30T10:00:00.000Z"));

    expect(plan.id).toBe("ai-agent-工程-2026-07-30");
    expect(plan.stages).toHaveLength(4);
    expect(plan.stages[0]).toMatchObject({ startWeek: 1, endWeek: 3 });
    expect(plan.stages.at(-1)).toMatchObject({ startWeek: 10, endWeek: 12 });
    expect(plan.today.map((task) => task.type)).toEqual(["diagnose", "learn", "practice", "reflect"]);
    expect(plan.today.reduce((sum, task) => sum + task.minutes, 0)).toBe(60);
  });

  it("adapts short plans without creating empty stages", () => {
    const plan = generateLearningPlan({ ...goal, durationWeeks: 2 });
    expect(plan.stages).toHaveLength(2);
    expect(plan.stages.map((stage) => [stage.startWeek, stage.endWeek])).toEqual([[1, 1], [2, 2]]);
  });

  it("rejects unusable goals", () => {
    expect(validateGoal({ ...goal, subject: "", dailyMinutes: 5 })).toEqual([
      "请填写要学习的主题",
      "每日时间应在 15–240 分钟之间",
    ]);
  });

  it("calculates completion percentage", () => {
    const plan = generateLearningPlan(goal);
    plan.today[0].completed = true;
    expect(completionRate(plan.today)).toBe(25);
  });
});

