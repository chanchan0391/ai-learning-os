import { describe, expect, it } from "vitest";
import {
  AgentSessionExpiredError,
  InvalidAgentResponseError,
  agentRequestError,
  validateEvaluationResponse,
  validateLearningPlanResponse,
  validateRecoveryPlanResponse,
  validateReviewAssessmentResponse,
  validateTeachingSessionResponse,
} from "./agent-response-validation";
import { generateLearningPlan } from "./planner";

describe("browser Agent response validation", () => {
  it("classifies HTTP failures without exposing server-provided details", () => {
    expect(agentRequestError(401, "请求失败")).toBeInstanceOf(AgentSessionExpiredError);
    expect(agentRequestError(401, "请求失败").message).toContain("重新登录");
    expect(agentRequestError(402, "请求失败").message).toContain("权益");
    expect(agentRequestError(413, "请求失败").message).toContain("请求上限");
    expect(agentRequestError(429, "请求失败").message).toContain("额度");
    expect(agentRequestError(400, "请求失败").message).toContain("检查输入");
    expect(agentRequestError(503, "教学会话生成失败").message).toBe("教学会话生成失败，服务暂时不可用，请稍后重试。");
  });

  it("accepts a complete learning plan and rejects undeclared or inconsistent data", () => {
    const { notes: _notes, ...plan } = generateLearningPlan({ subject: "系统设计", currentLevel: "了解基础", targetOutcome: "完成案例", dailyMinutes: 60, durationWeeks: 4 });
    expect(validateLearningPlanResponse(plan)).toBe(plan);
    expect(() => validateLearningPlanResponse({ ...plan, privateContext: "unexpected" })).toThrow(InvalidAgentResponseError);
    expect(() => validateLearningPlanResponse({ ...plan, today: plan.today.map((task, index) => index === 0 ? { ...task, minutes: task.minutes + 1 } : task) })).toThrow(InvalidAgentResponseError);
  });

  it("accepts the longest valid subject-derived plan identifier", () => {
    const { notes: _notes, ...plan } = generateLearningPlan({ subject: "课".repeat(200), currentLevel: "了解基础", targetOutcome: "完成案例", dailyMinutes: 60, durationWeeks: 4 });
    expect(validateLearningPlanResponse(plan).id).toHaveLength(211);
  });

  it("validates teaching checks, bounded signals, and unique identifiers", () => {
    const session = {
      concept: "幂等性",
      explanation: "重复执行仍保持相同结果。",
      workedExample: "使用请求键去重。",
      understandingChecks: [
        { id: "check-1", prompt: "解释幂等性", expectedSignals: ["提到重复执行"] },
        { id: "check-2", prompt: "给出例子", expectedSignals: ["提到请求键"] },
      ],
      practicePrompt: "设计一次安全重试。",
      completionSignals: ["包含失败路径"],
    };
    expect(validateTeachingSessionResponse(session)).toBe(session);
    expect(() => validateTeachingSessionResponse({ ...session, understandingChecks: session.understandingChecks.map((check) => ({ ...check, id: "duplicate" })) })).toThrow(InvalidAgentResponseError);
  });

  it("recomputes evaluation totals and mastery instead of trusting response labels", () => {
    const rubric = ["understanding", "application", "evidence", "reflection"].map((dimension) => ({
      dimension, score: 3, evidence: "可见证据", feedback: "补一个反例",
    }));
    const evaluation = { rubric, totalScore: 12, masteryLevel: "developing", misconceptions: [], nextAction: "补充边界测试" };
    expect(validateEvaluationResponse(evaluation)).toBe(evaluation);
    expect(() => validateEvaluationResponse({ ...evaluation, totalScore: 16, masteryLevel: "ready" })).toThrow(InvalidAgentResponseError);
    expect(() => validateEvaluationResponse({ ...evaluation, rubric: rubric.map((item) => ({ ...item, dimension: "understanding" })) })).toThrow(InvalidAgentResponseError);
  });

  it("binds review scores to the submitted answer and recall category", () => {
    const assessment = { answer: "我的闭卷答案", score: 4, recall: "easy", evidence: "回答给出原因", feedback: "补充限制条件" };
    expect(validateReviewAssessmentResponse(assessment, " 我的闭卷答案 ")).toBe(assessment);
    expect(() => validateReviewAssessmentResponse({ ...assessment, recall: "forgot" }, assessment.answer)).toThrow(InvalidAgentResponseError);
    expect(() => validateReviewAssessmentResponse({ ...assessment, answer: "被替换" }, "我的闭卷答案")).toThrow(InvalidAgentResponseError);
  });

  it("recomputes recovery duration and enforces the learner budget", () => {
    const recovery = {
      headline: "轻量重新开始",
      acknowledgement: "中断很常见。",
      totalMinutes: 10,
      steps: [
        { id: "step-1", title: "回看目标", description: "只看当前目标。", minutes: 5 },
        { id: "step-2", title: "完成一步", description: "执行最小动作。", minutes: 5 },
      ],
      nextCheckIn: "现在更容易继续吗？",
    };
    expect(validateRecoveryPlanResponse(recovery, 15)).toBe(recovery);
    expect(() => validateRecoveryPlanResponse({ ...recovery, totalMinutes: 12 }, 15)).toThrow(InvalidAgentResponseError);
    expect(() => validateRecoveryPlanResponse(recovery, 9)).toThrow(InvalidAgentResponseError);
  });
});
