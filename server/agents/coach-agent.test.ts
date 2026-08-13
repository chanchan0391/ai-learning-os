import { describe, expect, it } from "vitest";
import type { RecoveryPlan, RecoveryPlanRequest } from "../../src/types";
import type { ModelProvider } from "../ai/model-provider";
import { AgentOutputError } from "./agent-errors";
import { createCoachAgent } from "./coach-agent";
import { AGENT_INPUT_LIMITS, AGENT_OUTPUT_LIMITS } from "./request-validation";

const request: RecoveryPlanRequest = {
  goal: { subject: "AI Agent 工程", currentLevel: "Java 工程师", targetOutcome: "交付 Agent 应用", dailyMinutes: 60, durationWeeks: 12 },
  currentTask: { id: "learn-1", type: "learn", title: "工具调用", description: "实现调用闭环", minutes: 20, completed: false },
  interruption: { reason: "inactivity", inactiveDays: 3, recentDifficultDays: 0, lastActiveDate: "2026-07-28" },
};

function providerWith(value: RecoveryPlan): ModelProvider {
  return { id: "fake", isAiEnabled: true, async generateStructured<T>() { return { model: "fake", value: value as T }; } };
}

describe("Coach Agent", () => {
  it("accepts a small recovery plan that restarts the current task", async () => {
    const value: RecoveryPlan = {
      headline: "先重新接上线",
      acknowledgement: "停几天很正常，今天只做一个小启动。",
      totalMinutes: 12,
      steps: [
        { id: "recall", title: "回忆", description: "写下还记得的两点。", minutes: 4 },
        { id: "restart", title: "最小实践", description: "完成当前任务的第一步。", minutes: 8 },
      ],
      nextCheckIn: "现在继续是否比开始前容易一点？",
    };
    await expect(createCoachAgent(providerWith(value)).createRecoveryPlan(request)).resolves.toEqual(value);
  });

  it("rejects plans whose step minutes do not match the total", async () => {
    const value: RecoveryPlan = {
      headline: "重新开始", acknowledgement: "欢迎回来。", totalMinutes: 15,
      steps: [
        { id: "one", title: "回忆", description: "写下已知内容。", minutes: 4 },
        { id: "two", title: "行动", description: "完成第一步。", minutes: 8 },
      ],
      nextCheckIn: "是否更容易继续？",
    };
    await expect(createCoachAgent(providerWith(value)).createRecoveryPlan(request)).rejects.toBeInstanceOf(AgentOutputError);
  });

  it("rejects oversized model-generated recovery guidance", async () => {
    const value: RecoveryPlan = {
      headline: "x".repeat(AGENT_OUTPUT_LIMITS.titleCharacters + 1), acknowledgement: "欢迎回来。", totalMinutes: 12,
      steps: [
        { id: "one", title: "回忆", description: "写下已知内容。", minutes: 4 },
        { id: "two", title: "行动", description: "完成第一步。", minutes: 8 },
      ],
      nextCheckIn: "是否更容易继续？",
    };
    await expect(createCoachAgent(providerWith(value)).createRecoveryPlan(request)).rejects.toBeInstanceOf(AgentOutputError);
  });

  it("rejects interruption reasons that do not meet the detection threshold", async () => {
    const provider = providerWith({} as RecoveryPlan);
    await expect(createCoachAgent(provider).createRecoveryPlan({
      ...request,
      interruption: { ...request.interruption, inactiveDays: 1 },
    })).rejects.toThrow("学习中断原因与上下文不一致");
  });

  it("rejects oversized task descriptions before calling the provider", async () => {
    let called = false;
    const provider: ModelProvider = { id: "fake", isAiEnabled: true, async generateStructured<T>() { called = true; return { model: "fake", value: {} as T }; } };
    await expect(createCoachAgent(provider).createRecoveryPlan({
      ...request,
      currentTask: { ...request.currentTask, description: "x".repeat(AGENT_INPUT_LIMITS.taskDescriptionCharacters + 1) },
    })).rejects.toThrow("当前学习任务格式无效或超出长度限制");
    expect(called).toBe(false);
  });
});
