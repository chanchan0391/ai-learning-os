import { validateGoal } from "../../src/planner";
import type { TeachingSession, TeachingSessionRequest } from "../../src/types";
import type { JsonSchema, ModelProvider } from "../ai/model-provider";
import { AgentOutputError } from "./agent-errors";
import { AGENT_INPUT_LIMITS, AGENT_OUTPUT_LIMITS, hasOnlyKeys, isBoundedText, isBoundedTextList, isValidAgentTask } from "./request-validation";

export const TEACHING_SESSION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["concept", "explanation", "workedExample", "understandingChecks", "practicePrompt", "completionSignals"],
  properties: {
    concept: { type: "string", minLength: 1, maxLength: AGENT_OUTPUT_LIMITS.titleCharacters },
    explanation: { type: "string", minLength: 1, maxLength: AGENT_OUTPUT_LIMITS.longTextCharacters },
    workedExample: { type: "string", minLength: 1, maxLength: AGENT_OUTPUT_LIMITS.longTextCharacters },
    understandingChecks: {
      type: "array",
      minItems: 2,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "prompt", "expectedSignals"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: AGENT_OUTPUT_LIMITS.idCharacters },
          prompt: { type: "string", minLength: 1, maxLength: AGENT_OUTPUT_LIMITS.longTextCharacters },
          expectedSignals: { type: "array", minItems: 1, maxItems: AGENT_OUTPUT_LIMITS.teacherSignalsPerCheck, items: { type: "string", minLength: 1, maxLength: AGENT_OUTPUT_LIMITS.shortTextCharacters } },
        },
      },
    },
    practicePrompt: { type: "string", minLength: 1, maxLength: AGENT_OUTPUT_LIMITS.longTextCharacters },
    completionSignals: { type: "array", minItems: 1, maxItems: AGENT_OUTPUT_LIMITS.teacherCompletionSignals, items: { type: "string", minLength: 1, maxLength: AGENT_OUTPUT_LIMITS.shortTextCharacters } },
  },
};

function validateRequest(request: TeachingSessionRequest): void {
  if (!hasOnlyKeys(request, ["goal", "task", "learnerContext"])) throw new TypeError("教学请求格式无效");
  if (!hasOnlyKeys(request.goal, ["subject", "currentLevel", "targetOutcome", "dailyMinutes", "durationWeeks"])) {
    throw new TypeError("学习目标格式无效");
  }
  const errors = validateGoal(request.goal);
  if (errors.length > 0) throw new TypeError(errors.join("；"));
  if (!isValidAgentTask(request.task)) throw new TypeError("教学任务格式无效或超出长度限制");
  if (!hasOnlyKeys(request.learnerContext, ["knownConcepts", "recentErrors"])
    || !isBoundedTextList(request.learnerContext.knownConcepts, AGENT_INPUT_LIMITS.learnerContextItems, AGENT_INPUT_LIMITS.learnerContextItemCharacters)
    || !isBoundedTextList(request.learnerContext.recentErrors, AGENT_INPUT_LIMITS.learnerContextItems, AGENT_INPUT_LIMITS.learnerContextItemCharacters)) {
    throw new TypeError("学习者上下文格式无效");
  }
}

function assertSession(value: TeachingSession): void {
  if (!value || !isBoundedText(value.concept, AGENT_OUTPUT_LIMITS.titleCharacters)
    || !isBoundedText(value.explanation, AGENT_OUTPUT_LIMITS.longTextCharacters)
    || !isBoundedText(value.workedExample, AGENT_OUTPUT_LIMITS.longTextCharacters)
    || !isBoundedText(value.practicePrompt, AGENT_OUTPUT_LIMITS.longTextCharacters)) {
    throw new AgentOutputError("Teacher Agent returned incomplete teaching content");
  }
  if (!Array.isArray(value.understandingChecks) || value.understandingChecks.length < 2 || value.understandingChecks.length > 3) {
    throw new AgentOutputError("Teacher Agent must return two or three understanding checks");
  }
  const ids = new Set<string>();
  for (const check of value.understandingChecks) {
    if (!check || !isBoundedText(check.id, AGENT_OUTPUT_LIMITS.idCharacters)
      || !isBoundedText(check.prompt, AGENT_OUTPUT_LIMITS.longTextCharacters)
      || !Array.isArray(check.expectedSignals) || check.expectedSignals.length === 0
      || !isBoundedTextList(check.expectedSignals, AGENT_OUTPUT_LIMITS.teacherSignalsPerCheck, AGENT_OUTPUT_LIMITS.shortTextCharacters)) {
      throw new AgentOutputError("Teacher Agent returned an invalid understanding check");
    }
    ids.add(check.id);
  }
  if (ids.size !== value.understandingChecks.length) throw new AgentOutputError("Teacher Agent returned duplicate understanding check IDs");
  if (!Array.isArray(value.completionSignals) || value.completionSignals.length === 0
    || !isBoundedTextList(value.completionSignals, AGENT_OUTPUT_LIMITS.teacherCompletionSignals, AGENT_OUTPUT_LIMITS.shortTextCharacters)) {
    throw new AgentOutputError("Teacher Agent returned no observable completion signals");
  }
}

export function createTeacherAgent(provider: ModelProvider) {
  return {
    async createSession(request: TeachingSessionRequest, signal?: AbortSignal): Promise<TeachingSession> {
      validateRequest(request);
      const result = await provider.generateStructured<TeachingSession>({
        instructions: [
          "你是 AI Learning OS 的 Teacher Agent。",
          "围绕当前任务提供一个短教学会话，适配学习者已有知识和近期错误。",
          "先解释概念，再给完整示例；理解检查必须要求学习者主动回忆或应用，不能只是判断题。",
          "completionSignals 必须是可观察、可用于后续评估的表现。",
          "只返回符合给定 JSON Schema 的数据。",
        ].join("\n"),
        input: JSON.stringify(request),
        signal,
        schema: { name: "teaching_session", value: TEACHING_SESSION_SCHEMA },
      });
      assertSession(result.value);
      return result.value;
    },
  };
}
