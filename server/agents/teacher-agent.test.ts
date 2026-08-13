import { describe, expect, it } from "vitest";
import type { TeachingSession } from "../../src/types";
import type { ModelProvider } from "../ai/model-provider";
import { AgentOutputError } from "./agent-errors";
import { createTeacherAgent } from "./teacher-agent";
import { AGENT_INPUT_LIMITS } from "./request-validation";

const request = {
  goal: { subject: "AI Agent 工程", currentLevel: "Java 工程师", targetOutcome: "交付 Agent 应用", dailyMinutes: 60, durationWeeks: 12 },
  task: { id: "learn-1", type: "learn" as const, title: "工具调用", description: "实现调用闭环", minutes: 20, completed: false },
  learnerContext: { knownConcepts: ["Java 接口"], recentErrors: ["遗漏超时处理"] },
};

function providerWith(value: TeachingSession): ModelProvider {
  return { id: "fake", isAiEnabled: true, async generateStructured<T>() { return { model: "fake", value: value as T }; } };
}

describe("Teacher Agent", () => {
  it("accepts a session with explanation, active checks, and completion signals", async () => {
    const value: TeachingSession = {
      concept: "工具调用", explanation: "模型选择工具并提供参数。", workedExample: "先定义 schema，再执行并回传结果。",
      understandingChecks: [
        { id: "recall", prompt: "解释调用流程", expectedSignals: ["提到参数校验"] },
        { id: "apply", prompt: "设计一个天气工具", expectedSignals: ["给出成功标准"] },
      ],
      practicePrompt: "实现一个工具", completionSignals: ["可运行", "有验证结果"],
    };
    await expect(createTeacherAgent(providerWith(value)).createSession(request)).resolves.toEqual(value);
  });

  it("rejects duplicate understanding check IDs", async () => {
    const value: TeachingSession = {
      concept: "工具调用", explanation: "解释", workedExample: "示例",
      understandingChecks: [
        { id: "same", prompt: "问题一", expectedSignals: ["信号"] },
        { id: "same", prompt: "问题二", expectedSignals: ["信号"] },
      ],
      practicePrompt: "练习", completionSignals: ["可运行"],
    };
    await expect(createTeacherAgent(providerWith(value)).createSession(request)).rejects.toBeInstanceOf(AgentOutputError);
  });

  it("rejects oversized learner context before calling the provider", async () => {
    let called = false;
    const provider: ModelProvider = { id: "fake", isAiEnabled: true, async generateStructured<T>() { called = true; return { model: "fake", value: {} as T }; } };
    await expect(createTeacherAgent(provider).createSession({
      ...request,
      learnerContext: { ...request.learnerContext, knownConcepts: ["x".repeat(AGENT_INPUT_LIMITS.learnerContextItemCharacters + 1)] },
    })).rejects.toThrow("学习者上下文格式无效");
    expect(called).toBe(false);
  });
});
