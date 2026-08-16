import { AGENT_INPUT_LIMITS, AGENT_OUTPUT_LIMITS } from "./agent-limits";
import { LEARNING_GOAL_LIMITS, validateGoal } from "./planner";
import type { EvaluationResult, LearningPlan, RecoveryPlan, ReviewAssessment, TeachingSession } from "./types";

export class InvalidAgentResponseError extends Error {
  constructor() {
    super("Agent 返回了无效响应，请稍后重试");
    this.name = "InvalidAgentResponseError";
  }
}

export class AgentSessionExpiredError extends Error {
  constructor() {
    super("登录已过期，请重新登录后继续使用 Agent。");
    this.name = "AgentSessionExpiredError";
  }
}

export function agentRequestError(status: number, fallback: string): Error {
  if (status === 401) return new AgentSessionExpiredError();
  if (status === 402) return new Error("当前账号暂无可用的 Agent 权益，请检查订阅状态。");
  if (status === 413) return new Error("学习内容超过 Agent 请求上限，请缩短后重试。");
  if (status === 429) return new Error("Agent 请求暂时受限或本月额度已用完，请稍后重试。");
  if (status >= 400 && status < 500) return new Error("Agent 请求无法处理，请检查输入后重试。");
  return new Error(`${fallback}，服务暂时不可用，请稍后重试。`);
}

function hasOnlyKeys(value: unknown, allowedKeys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function assertValid<T>(value: unknown, valid: boolean): T {
  if (!valid) throw new InvalidAgentResponseError();
  return value as T;
}

function isTask(value: unknown): boolean {
  return hasOnlyKeys(value, ["id", "type", "title", "description", "minutes", "completed"])
    && isBoundedText(value.id, AGENT_INPUT_LIMITS.taskIdCharacters)
    && ["diagnose", "learn", "practice", "reflect"].includes(String(value.type))
    && isBoundedText(value.title, AGENT_INPUT_LIMITS.taskTitleCharacters)
    && isBoundedText(value.description, AGENT_INPUT_LIMITS.taskDescriptionCharacters)
    && Number.isInteger(value.minutes) && Number(value.minutes) >= 1 && Number(value.minutes) <= 240
    && value.completed === false;
}

export function validateLearningPlanResponse(value: unknown): LearningPlan {
  if (!hasOnlyKeys(value, ["id", "createdAt", "goal", "stages", "today"])
    || !isBoundedText(value.id, LEARNING_GOAL_LIMITS.subjectCharacters + 11)
    || !isIsoTimestamp(value.createdAt)
    || !hasOnlyKeys(value.goal, ["subject", "currentLevel", "targetOutcome", "dailyMinutes", "durationWeeks"])
    || validateGoal(value.goal as unknown as LearningPlan["goal"]).length > 0
    || !Array.isArray(value.stages) || value.stages.length === 0 || value.stages.length > AGENT_OUTPUT_LIMITS.plannerStages
    || !Array.isArray(value.today) || value.today.length === 0 || value.today.length > AGENT_OUTPUT_LIMITS.plannerTasks) {
    throw new InvalidAgentResponseError();
  }
  const goal = value.goal as unknown as LearningPlan["goal"];
  const stagesValid = value.stages.every((stage) => hasOnlyKeys(stage, ["id", "title", "outcome", "startWeek", "endWeek"])
    && isBoundedText(stage.id, AGENT_OUTPUT_LIMITS.idCharacters)
    && isBoundedText(stage.title, AGENT_OUTPUT_LIMITS.titleCharacters)
    && isBoundedText(stage.outcome, AGENT_INPUT_LIMITS.taskDescriptionCharacters)
    && Number.isInteger(stage.startWeek) && Number(stage.startWeek) >= 1
    && Number.isInteger(stage.endWeek) && Number(stage.endWeek) >= Number(stage.startWeek)
    && Number(stage.endWeek) <= goal.durationWeeks);
  const stageIds = value.stages.map((stage) => (stage as Record<string, unknown>).id);
  const taskIds = value.today.map((task) => (task as Record<string, unknown>).id);
  return assertValid<LearningPlan>(value, stagesValid
    && value.today.every(isTask)
    && new Set(stageIds).size === stageIds.length
    && new Set(taskIds).size === taskIds.length
    && value.today.reduce((sum, task) => sum + Number((task as Record<string, unknown>).minutes), 0) === goal.dailyMinutes);
}

export function validateTeachingSessionResponse(value: unknown): TeachingSession {
  if (!hasOnlyKeys(value, ["concept", "explanation", "workedExample", "understandingChecks", "practicePrompt", "completionSignals"])) {
    throw new InvalidAgentResponseError();
  }
  const checks = value.understandingChecks;
  const signals = value.completionSignals;
  const valid = isBoundedText(value.concept, AGENT_OUTPUT_LIMITS.titleCharacters)
    && isBoundedText(value.explanation, AGENT_OUTPUT_LIMITS.longTextCharacters)
    && isBoundedText(value.workedExample, AGENT_OUTPUT_LIMITS.longTextCharacters)
    && isBoundedText(value.practicePrompt, AGENT_OUTPUT_LIMITS.longTextCharacters)
    && Array.isArray(checks) && checks.length >= 2 && checks.length <= 3
    && checks.every((check) => hasOnlyKeys(check, ["id", "prompt", "expectedSignals"])
      && isBoundedText(check.id, AGENT_OUTPUT_LIMITS.idCharacters)
      && isBoundedText(check.prompt, AGENT_OUTPUT_LIMITS.longTextCharacters)
      && Array.isArray(check.expectedSignals) && check.expectedSignals.length >= 1
      && check.expectedSignals.length <= AGENT_OUTPUT_LIMITS.teacherSignalsPerCheck
      && check.expectedSignals.every((signal) => isBoundedText(signal, AGENT_OUTPUT_LIMITS.shortTextCharacters)))
    && new Set(Array.isArray(checks) ? checks.map((check) => (check as Record<string, unknown>).id) : []).size === (Array.isArray(checks) ? checks.length : -1)
    && Array.isArray(signals) && signals.length >= 1 && signals.length <= AGENT_OUTPUT_LIMITS.teacherCompletionSignals
    && signals.every((signal) => isBoundedText(signal, AGENT_OUTPUT_LIMITS.shortTextCharacters));
  return assertValid<TeachingSession>(value, valid);
}

export function validateEvaluationResponse(value: unknown): EvaluationResult {
  if (!hasOnlyKeys(value, ["rubric", "totalScore", "masteryLevel", "misconceptions", "nextAction"]) || !Array.isArray(value.rubric)) {
    throw new InvalidAgentResponseError();
  }
  const dimensions = ["understanding", "application", "evidence", "reflection"];
  const validRubric = value.rubric.length === 4 && value.rubric.every((item) => hasOnlyKeys(item, ["dimension", "score", "evidence", "feedback"])
    && dimensions.includes(String(item.dimension))
    && Number.isInteger(item.score) && Number(item.score) >= 0 && Number(item.score) <= 4
    && isBoundedText(item.evidence, AGENT_OUTPUT_LIMITS.longTextCharacters)
    && isBoundedText(item.feedback, AGENT_OUTPUT_LIMITS.longTextCharacters));
  const total = value.rubric.reduce((sum, item) => sum + Number((item as Record<string, unknown>).score), 0);
  const expectedMastery = total <= 7 ? "needs-support" : total <= 12 ? "developing" : "ready";
  return assertValid<EvaluationResult>(value, validRubric
    && new Set(value.rubric.map((item) => (item as Record<string, unknown>).dimension)).size === 4
    && value.totalScore === total && value.masteryLevel === expectedMastery
    && Array.isArray(value.misconceptions) && value.misconceptions.length <= AGENT_OUTPUT_LIMITS.evaluationMisconceptions
    && value.misconceptions.every((item) => isBoundedText(item, AGENT_OUTPUT_LIMITS.shortTextCharacters))
    && isBoundedText(value.nextAction, AGENT_OUTPUT_LIMITS.longTextCharacters));
}

export function validateReviewAssessmentResponse(value: unknown, expectedAnswer: string): ReviewAssessment {
  if (!hasOnlyKeys(value, ["answer", "score", "recall", "evidence", "feedback"])) throw new InvalidAgentResponseError();
  const expectedRecall = Number(value.score) <= 1 ? "forgot" : Number(value.score) <= 3 ? "effortful" : "easy";
  return assertValid<ReviewAssessment>(value,
    value.answer === expectedAnswer.trim() && isBoundedText(value.answer, AGENT_INPUT_LIMITS.reviewAnswerCharacters)
    && Number.isInteger(value.score) && Number(value.score) >= 0 && Number(value.score) <= 4
    && value.recall === expectedRecall
    && isBoundedText(value.evidence, AGENT_OUTPUT_LIMITS.longTextCharacters)
    && isBoundedText(value.feedback, AGENT_OUTPUT_LIMITS.longTextCharacters));
}

export function validateRecoveryPlanResponse(value: unknown, dailyMinutes: number): RecoveryPlan {
  if (!hasOnlyKeys(value, ["headline", "acknowledgement", "totalMinutes", "steps", "nextCheckIn"]) || !Array.isArray(value.steps)) {
    throw new InvalidAgentResponseError();
  }
  const stepsValid = value.steps.length >= 2 && value.steps.length <= 3 && value.steps.every((step) => hasOnlyKeys(step, ["id", "title", "description", "minutes"])
    && isBoundedText(step.id, AGENT_OUTPUT_LIMITS.idCharacters)
    && isBoundedText(step.title, AGENT_OUTPUT_LIMITS.titleCharacters)
    && isBoundedText(step.description, AGENT_OUTPUT_LIMITS.longTextCharacters)
    && Number.isInteger(step.minutes) && Number(step.minutes) >= 3 && Number(step.minutes) <= 12);
  const minutes = value.steps.reduce((sum, step) => sum + Number((step as Record<string, unknown>).minutes), 0);
  return assertValid<RecoveryPlan>(value, isBoundedText(value.headline, AGENT_OUTPUT_LIMITS.titleCharacters)
    && isBoundedText(value.acknowledgement, AGENT_OUTPUT_LIMITS.longTextCharacters)
    && isBoundedText(value.nextCheckIn, AGENT_OUTPUT_LIMITS.shortTextCharacters)
    && stepsValid && new Set(value.steps.map((step) => (step as Record<string, unknown>).id)).size === value.steps.length
    && value.totalMinutes === minutes && minutes >= 10 && minutes <= Math.min(20, dailyMinutes));
}
