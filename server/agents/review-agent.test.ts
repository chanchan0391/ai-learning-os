import { describe, expect, it } from "vitest";
import type { ReviewAssessment } from "../../src/types";
import type { ModelProvider } from "../ai/model-provider";
import { AgentOutputError } from "./agent-errors";
import { createReviewAgent } from "./review-agent";
import { AGENT_INPUT_LIMITS } from "./request-validation";

const request = {
  goal: { subject: "AI Agent 工程", currentLevel: "Java 工程师", targetOutcome: "交付 Agent 应用", dailyMinutes: 60, durationWeeks: 12 },
  items: [{ sourceDay: 1, nextAction: "画出恢复路径", misconceptions: ["混淆重试与恢复"] }],
  answer: "重试再次执行同一步，恢复则从持久化检查点继续；我会画出失败到恢复的状态路径。",
};

function providerWith(value: ReviewAssessment): ModelProvider {
  return { id: "fake", isAiEnabled: true, async generateStructured<T>() { return { model: "fake", value: value as T }; } };
}

const valid: ReviewAssessment = { answer: request.answer, score: 4, recall: "easy", evidence: "区分重试与恢复并给出状态路径", feedback: "补充一个恢复失败分支。" };

describe("Review Agent", () => {
  it("accepts an evidence-backed assessment", async () => {
    await expect(createReviewAgent(providerWith(valid)).assess(request)).resolves.toEqual(valid);
  });

  it("rejects a recall label that contradicts the score", async () => {
    await expect(createReviewAgent(providerWith({ ...valid, recall: "effortful" })).assess(request)).rejects.toBeInstanceOf(AgentOutputError);
  });

  it("rejects an assessment that rewrites the learner answer", async () => {
    await expect(createReviewAgent(providerWith({ ...valid, answer: "different" })).assess(request)).rejects.toBeInstanceOf(AgentOutputError);
  });

  it("rejects an excessive number of review items before calling the provider", async () => {
    let called = false;
    const provider: ModelProvider = { id: "fake", isAiEnabled: true, async generateStructured<T>() { called = true; return { model: "fake", value: valid as T }; } };
    await expect(createReviewAgent(provider).assess({
      ...request,
      items: Array.from({ length: AGENT_INPUT_LIMITS.reviewItems + 1 }, (_, index) => ({ sourceDay: index + 1, nextAction: "practice", misconceptions: [] })),
    })).rejects.toThrow("复习薄弱点不能为空或超出长度限制");
    expect(called).toBe(false);
  });
});
