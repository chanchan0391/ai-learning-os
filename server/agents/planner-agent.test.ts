import { describe, expect, it } from "vitest";
import type { ModelProvider } from "../ai/model-provider";
import { AgentOutputError, createPlannerAgent } from "./planner-agent";
import { AGENT_OUTPUT_LIMITS } from "./request-validation";

const goal = { subject: "AI Agent 工程", currentLevel: "Java 工程师", targetOutcome: "交付 Agent 应用", dailyMinutes: 60, durationWeeks: 12 };

describe("Planner Agent", () => {
  it("rejects a model plan that violates the learner time budget", async () => {
    const provider: ModelProvider = {
      id: "fake", isAiEnabled: true,
      async generateStructured<T>() {
        return { model: "fake", value: { stages: [{ id: "s1", title: "基础", outcome: "掌握基础", startWeek: 1, endWeek: 12 }], today: [{ id: "t1", type: "learn", title: "学习", description: "学习", minutes: 20, completed: false }] } as T };
      },
    };
    await expect(createPlannerAgent(provider).createPlan(goal)).rejects.toBeInstanceOf(AgentOutputError);
  });

  it("rejects excessive model-generated stage cardinality", async () => {
    const provider: ModelProvider = {
      id: "fake", isAiEnabled: true,
      async generateStructured<T>() {
        return { model: "fake", value: {
          stages: Array.from({ length: AGENT_OUTPUT_LIMITS.plannerStages + 1 }, (_, index) => ({
            id: `s${index}`, title: "阶段", outcome: "掌握阶段成果", startWeek: 1, endWeek: 12,
          })),
          today: [{ id: "t1", type: "learn", title: "学习", description: "学习", minutes: 60, completed: false }],
        } as T };
      },
    };
    await expect(createPlannerAgent(provider).createPlan(goal)).rejects.toBeInstanceOf(AgentOutputError);
  });
});
