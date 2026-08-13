import { describe, expect, it } from "vitest";
import type { EvaluationResult } from "../../src/types";
import type { ModelProvider } from "../ai/model-provider";
import { AgentOutputError } from "./agent-errors";
import { createEvaluatorAgent } from "./evaluator-agent";
import { AGENT_INPUT_LIMITS, AGENT_OUTPUT_LIMITS } from "./request-validation";

const request = {
  goal: { subject: "AI Agent 工程", currentLevel: "Java 工程师", targetOutcome: "交付 Agent 应用", dailyMinutes: 60, durationWeeks: 12 },
  task: { id: "practice-1", type: "practice" as const, title: "工具调用", description: "实现调用闭环", minutes: 30, completed: false },
  submission: "实现了调用流程并记录输入、输出和一次失败案例。",
};

function providerWith(value: EvaluationResult): ModelProvider {
  return { id: "fake", isAiEnabled: true, async generateStructured<T>() { return { model: "fake", value: value as T }; } };
}

const valid: EvaluationResult = {
  rubric: [
    { dimension: "understanding", score: 3, evidence: "解释了流程", feedback: "补充边界" },
    { dimension: "application", score: 3, evidence: "完成了实现", feedback: "增加约束" },
    { dimension: "evidence", score: 2, evidence: "记录了输出", feedback: "附上失败输出" },
    { dimension: "reflection", score: 2, evidence: "提到失败", feedback: "解释改进" },
  ],
  totalScore: 10, masteryLevel: "developing", misconceptions: [], nextAction: "补充失败恢复测试。",
};

describe("Evaluator Agent", () => {
  it("accepts evidence-backed scores whose total and mastery agree", async () => {
    await expect(createEvaluatorAgent(providerWith(valid)).evaluate(request)).resolves.toEqual(valid);
  });

  it("rejects a total that does not equal the rubric sum", async () => {
    await expect(createEvaluatorAgent(providerWith({ ...valid, totalScore: 11 })).evaluate(request)).rejects.toBeInstanceOf(AgentOutputError);
  });

  it("rejects a mastery label that contradicts the score threshold", async () => {
    await expect(createEvaluatorAgent(providerWith({ ...valid, masteryLevel: "ready" })).evaluate(request)).rejects.toBeInstanceOf(AgentOutputError);
  });

  it("rejects excessive model-generated misconceptions", async () => {
    await expect(createEvaluatorAgent(providerWith({
      ...valid,
      misconceptions: Array.from({ length: AGENT_OUTPUT_LIMITS.evaluationMisconceptions + 1 }, () => "误解"),
    })).evaluate(request)).rejects.toBeInstanceOf(AgentOutputError);
  });

  it("rejects oversized submissions before calling the provider", async () => {
    let called = false;
    const provider: ModelProvider = { id: "fake", isAiEnabled: true, async generateStructured<T>() { called = true; return { model: "fake", value: valid as T }; } };
    await expect(createEvaluatorAgent(provider).evaluate({ ...request, submission: "x".repeat(AGENT_INPUT_LIMITS.submissionCharacters + 1) }))
      .rejects.toThrow("学习成果不能为空或超出长度限制");
    expect(called).toBe(false);
  });
});
