import { validateGoal } from "../../src/planner";
import type { RecoveryPlan, RecoveryPlanRequest } from "../../src/types";
import type { JsonSchema, ModelProvider } from "../ai/model-provider";
import { AgentOutputError } from "./agent-errors";
import { AGENT_OUTPUT_LIMITS, hasOnlyKeys, isBoundedText, isValidAgentTask } from "./request-validation";

export const RECOVERY_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "acknowledgement", "totalMinutes", "steps", "nextCheckIn"],
  properties: {
    headline: { type: "string", minLength: 1, maxLength: AGENT_OUTPUT_LIMITS.titleCharacters },
    acknowledgement: { type: "string", minLength: 1, maxLength: AGENT_OUTPUT_LIMITS.longTextCharacters },
    totalMinutes: { type: "integer", minimum: 10, maximum: 20 },
    steps: {
      type: "array",
      minItems: 2,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "description", "minutes"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: AGENT_OUTPUT_LIMITS.idCharacters },
          title: { type: "string", minLength: 1, maxLength: AGENT_OUTPUT_LIMITS.titleCharacters },
          description: { type: "string", minLength: 1, maxLength: AGENT_OUTPUT_LIMITS.longTextCharacters },
          minutes: { type: "integer", minimum: 3, maximum: 12 },
        },
      },
    },
    nextCheckIn: { type: "string", minLength: 1, maxLength: AGENT_OUTPUT_LIMITS.shortTextCharacters },
  },
};

function validateRequest(request: RecoveryPlanRequest): void {
  if (!hasOnlyKeys(request, ["goal", "currentTask", "interruption"])) throw new TypeError("恢复计划请求格式无效");
  if (!hasOnlyKeys(request.goal, ["subject", "currentLevel", "targetOutcome", "dailyMinutes", "durationWeeks"])) {
    throw new TypeError("学习目标格式无效");
  }
  const errors = validateGoal(request.goal);
  if (errors.length > 0) throw new TypeError(errors.join("；"));
  if (!isValidAgentTask(request.currentTask)) {
    throw new TypeError("当前学习任务格式无效或超出长度限制");
  }
  const interruption = request.interruption;
  if (!hasOnlyKeys(interruption, ["reason", "inactiveDays", "recentDifficultDays", "lastActiveDate"])
    || !["inactivity", "repeated-difficulty", "both"].includes(interruption.reason)
    || !Number.isInteger(interruption.inactiveDays) || interruption.inactiveDays < 0
    || !Number.isInteger(interruption.recentDifficultDays) || interruption.recentDifficultDays < 0 || interruption.recentDifficultDays > 2
    || !/^\d{4}-\d{2}-\d{2}$/.test(interruption.lastActiveDate)) {
    throw new TypeError("学习中断上下文无效");
  }
  const hasInactivity = interruption.inactiveDays >= 2;
  const hasRepeatedDifficulty = interruption.recentDifficultDays >= 2;
  if ((interruption.reason === "inactivity" && (!hasInactivity || hasRepeatedDifficulty))
    || (interruption.reason === "repeated-difficulty" && (hasInactivity || !hasRepeatedDifficulty))
    || (interruption.reason === "both" && (!hasInactivity || !hasRepeatedDifficulty))) {
    throw new TypeError("学习中断原因与上下文不一致");
  }
}

function assertPlan(plan: RecoveryPlan, dailyMinutes: number): void {
  if (!plan || !isBoundedText(plan.headline, AGENT_OUTPUT_LIMITS.titleCharacters)
    || !isBoundedText(plan.acknowledgement, AGENT_OUTPUT_LIMITS.longTextCharacters)
    || !isBoundedText(plan.nextCheckIn, AGENT_OUTPUT_LIMITS.shortTextCharacters)) {
    throw new AgentOutputError("Coach Agent returned incomplete recovery guidance");
  }
  if (!Array.isArray(plan.steps) || plan.steps.length < 2 || plan.steps.length > 3) {
    throw new AgentOutputError("Coach Agent must return two or three recovery steps");
  }
  const ids = new Set<string>();
  let minutes = 0;
  for (const step of plan.steps) {
    if (!step || !isBoundedText(step.id, AGENT_OUTPUT_LIMITS.idCharacters)
      || !isBoundedText(step.title, AGENT_OUTPUT_LIMITS.titleCharacters)
      || !isBoundedText(step.description, AGENT_OUTPUT_LIMITS.longTextCharacters)
      || !Number.isInteger(step.minutes) || step.minutes < 3 || step.minutes > 12) {
      throw new AgentOutputError("Coach Agent returned an invalid recovery step");
    }
    ids.add(step.id);
    minutes += step.minutes;
  }
  if (ids.size !== plan.steps.length) throw new AgentOutputError("Coach Agent returned duplicate recovery step IDs");
  if (!Number.isInteger(plan.totalMinutes) || plan.totalMinutes !== minutes || minutes < 10 || minutes > Math.min(20, dailyMinutes)) {
    throw new AgentOutputError("Recovery plan must use 10–20 minutes and stay within the daily budget");
  }
}

export function createCoachAgent(provider: ModelProvider) {
  return {
    async createRecoveryPlan(request: RecoveryPlanRequest, signal?: AbortSignal): Promise<RecoveryPlan> {
      validateRequest(request);
      const result = await provider.generateStructured<RecoveryPlan>({
        instructions: [
          "你是 AI Learning OS 的 Coach Agent。",
          "学习者在中断或连续受挫后回归；用不评判、不制造内疚的语言承认现实。",
          "生成 2–3 个低压力恢复步骤，总时长 10–20 分钟且不超过 dailyMinutes。",
          "不要改写完整学习计划，不要求补完错过的内容，只聚焦重新启动当前任务。",
          "nextCheckIn 给出完成后的一个简短自我检查问题。",
          "只返回符合给定 JSON Schema 的数据。",
        ].join("\n"),
        input: JSON.stringify(request),
        signal,
        schema: { name: "recovery_plan", value: RECOVERY_PLAN_SCHEMA },
      });
      assertPlan(result.value, request.goal.dailyMinutes);
      return result.value;
    },
  };
}
