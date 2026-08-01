import { generateLearningPlan } from "../../src/planner";
import type { EvaluationRequest, EvaluationResult, LearningGoal, RecoveryPlan, RecoveryPlanRequest, ReviewAssessment, ReviewAssessmentRequest, TeachingSession, TeachingSessionRequest } from "../../src/types";
import type { ModelProvider, StructuredGenerationRequest, StructuredGenerationResult } from "./model-provider";

export class DeterministicModelProvider implements ModelProvider {
  readonly id = "deterministic-development";
  readonly isAiEnabled = false;

  async generateStructured<T>(request: StructuredGenerationRequest): Promise<StructuredGenerationResult<T>> {
    const input: unknown = JSON.parse(request.input);
    let value: unknown;

    if (request.schema.name === "learning_plan") {
      const plan = generateLearningPlan(input as LearningGoal);
      value = { stages: plan.stages, today: plan.today };
    } else if (request.schema.name === "teaching_session") {
      const { goal, task, learnerContext } = input as TeachingSessionRequest;
      const priorKnowledge = learnerContext.knownConcepts[0] ?? goal.currentLevel;
      const recentError = learnerContext.recentErrors[0] ?? "尚未记录具体错误";
      value = {
        concept: task.title,
        explanation: `把“${task.title}”理解为通向“${goal.targetOutcome}”的一项可验证能力。先连接已有知识“${priorKnowledge}”，再聚焦任务要求：${task.description}`,
        workedExample: `示例：选择一个最小场景，明确输入、执行步骤和预期输出；运行后保存结果，并解释它为何满足“${task.title}”。特别检查：${recentError}。`,
        understandingChecks: [
          { id: "recall", prompt: `不用查资料，用自己的话解释“${task.title}”解决什么问题。`, expectedSignals: ["说明问题背景", "给出核心机制"] },
          { id: "apply", prompt: "换一个具体场景，说明你会如何应用并验证它。", expectedSignals: ["给出具体步骤", "包含可观察的成功标准"] },
        ],
        practicePrompt: `为“${goal.targetOutcome}”完成一个与“${task.title}”有关的最小成果，并附上运行或验证证据。`,
        completionSignals: ["能用自己的话解释", "能在新场景中应用", "能提供可复查证据"],
      } satisfies TeachingSession;
    } else if (request.schema.name === "recovery_plan") {
      const { currentTask, interruption } = input as RecoveryPlanRequest;
      const acknowledgement = interruption.reason === "repeated-difficulty"
        ? "连续觉得困难并不代表失败，先把今天缩小到一个容易启动的动作。"
        : "离开几天很正常，不需要补完错过的内容，今天只重新接上线。";
      value = {
        headline: "用 12 分钟轻量重启",
        acknowledgement,
        totalMinutes: 12,
        steps: [
          { id: "recall", title: "找回上下文", description: `不查资料，写下你还记得的“${currentTask.title}”要点。`, minutes: 4 },
          { id: "restart", title: "完成最小一步", description: `只执行当前任务的第一步：${currentTask.description}`, minutes: 8 },
        ],
        nextCheckIn: "完成后问自己：现在继续五分钟，是否比开始前更容易？",
      } satisfies RecoveryPlan;
    } else if (request.schema.name === "review_assessment") {
      const { answer } = input as ReviewAssessmentRequest;
      const normalized = answer.trim();
      const score = normalized.length >= 80 ? 4 : normalized.length >= 30 ? 3 : normalized.length >= 12 ? 2 : normalized.length >= 5 ? 1 : 0;
      value = {
        answer: normalized,
        score,
        recall: score <= 1 ? "forgot" : score <= 3 ? "effortful" : "easy",
        evidence: score === 0 ? "回答中尚无足够证据。" : `回答提供了 ${normalized.length} 个字符的主动回忆证据。`,
        feedback: score === 4 ? "补充一个反例，确认理解可以迁移。" : "明确纠正薄弱点，并写出下一步的具体做法。",
      } satisfies ReviewAssessment;
    } else if (request.schema.name === "learning_evaluation") {
      const { submission } = input as EvaluationRequest;
      const detailed = submission.trim().length >= 120;
      const score = detailed ? 3 : 2;
      const feedback = detailed ? "已提供较完整说明；下一步补充边界条件。" : "信息基本相关；下一步增加具体步骤和验证结果。";
      const rubric: EvaluationResult["rubric"] = [
        { dimension: "understanding", score, evidence: submission.trim().slice(0, 160), feedback },
        { dimension: "application", score, evidence: "提交内容中的实践描述", feedback },
        { dimension: "evidence", score, evidence: "提交内容中的验证说明", feedback },
        { dimension: "reflection", score, evidence: "提交内容中的复盘说明", feedback },
      ];
      const totalScore = score * rubric.length;
      value = {
        rubric,
        totalScore,
        masteryLevel: totalScore <= 7 ? "needs-support" : totalScore <= 12 ? "developing" : "ready",
        misconceptions: [],
        nextAction: detailed ? "补充一个失败案例并说明恢复方式。" : "补充一个可复现步骤和对应输出。",
      } satisfies EvaluationResult;
    } else {
      throw new Error(`Unsupported deterministic schema: ${request.schema.name}`);
    }

    return { value: value as T, model: this.id };
  }
}
