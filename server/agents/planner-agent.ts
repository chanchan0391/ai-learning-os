import { validateGoal } from "../../src/planner";
import type { DailyTask, LearningGoal, LearningPlan, LearningStage } from "../../src/types";
import type { JsonSchema, ModelProvider } from "../ai/model-provider";
import { AgentOutputError } from "./agent-errors";
import { AGENT_INPUT_LIMITS, AGENT_OUTPUT_LIMITS, PublicHttpError, hasOnlyKeys, isBoundedText, isValidAgentTask } from "./request-validation";

export { AgentOutputError } from "./agent-errors";

interface GeneratedPlan {
  stages: LearningStage[];
  today: DailyTask[];
}

export const LEARNING_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["stages", "today"],
  properties: {
    stages: {
      type: "array",
      minItems: 1,
      maxItems: AGENT_OUTPUT_LIMITS.plannerStages,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "outcome", "startWeek", "endWeek"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: AGENT_OUTPUT_LIMITS.idCharacters },
          title: { type: "string", minLength: 1, maxLength: AGENT_OUTPUT_LIMITS.titleCharacters },
          outcome: { type: "string", minLength: 1, maxLength: AGENT_INPUT_LIMITS.taskDescriptionCharacters },
          startWeek: { type: "integer", minimum: 1 }, endWeek: { type: "integer", minimum: 1 },
        },
      },
    },
    today: {
      type: "array",
      minItems: 1,
      maxItems: AGENT_OUTPUT_LIMITS.plannerTasks,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "title", "description", "minutes", "completed"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: AGENT_INPUT_LIMITS.taskIdCharacters },
          type: { type: "string", enum: ["diagnose", "learn", "practice", "reflect"] },
          title: { type: "string", minLength: 1, maxLength: AGENT_INPUT_LIMITS.taskTitleCharacters },
          description: { type: "string", minLength: 1, maxLength: AGENT_INPUT_LIMITS.taskDescriptionCharacters },
          minutes: { type: "integer", minimum: 1, maximum: 240 },
          completed: { type: "boolean", const: false },
        },
      },
    },
  },
};

function planId(subject: string, now: Date): string {
  const slug = subject.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "learning-goal";
  return `${slug}-${now.toISOString().slice(0, 10)}`;
}

function assertGeneratedPlan(value: GeneratedPlan, goal: LearningGoal): void {
  if (!value || !Array.isArray(value.stages) || value.stages.length === 0 || value.stages.length > AGENT_OUTPUT_LIMITS.plannerStages) {
    throw new AgentOutputError("Planner Agent returned an invalid number of stages");
  }
  if (!Array.isArray(value.today) || value.today.length === 0 || value.today.length > AGENT_OUTPUT_LIMITS.plannerTasks
    || value.today.some((task) => !isValidAgentTask(task))) {
    throw new AgentOutputError("Planner Agent returned invalid daily tasks");
  }
  const stageIds = new Set<string>();
  for (const stage of value.stages) {
    if (!stage || !isBoundedText(stage.id, AGENT_OUTPUT_LIMITS.idCharacters)
      || !isBoundedText(stage.title, AGENT_OUTPUT_LIMITS.titleCharacters)
      || !isBoundedText(stage.outcome, AGENT_INPUT_LIMITS.taskDescriptionCharacters)
      || !Number.isInteger(stage.startWeek) || !Number.isInteger(stage.endWeek)) {
      throw new AgentOutputError("Planner Agent returned an invalid stage");
    }
    stageIds.add(stage.id);
  }
  if (stageIds.size !== value.stages.length) throw new AgentOutputError("Planner Agent returned duplicate stage IDs");
  if (new Set(value.today.map((task) => task.id)).size !== value.today.length) throw new AgentOutputError("Planner Agent returned duplicate task IDs");
  const minutes = value.today.reduce((sum, task) => sum + task.minutes, 0);
  if (minutes !== goal.dailyMinutes) throw new AgentOutputError(`Daily task budget must equal ${goal.dailyMinutes} minutes`);
  if (value.today.some((task) => task.completed)) throw new AgentOutputError("New tasks must be incomplete");
  if (value.stages.some((stage) => stage.startWeek < 1 || stage.endWeek < stage.startWeek || stage.endWeek > goal.durationWeeks)) {
    throw new AgentOutputError("Planner Agent returned invalid stage week ranges");
  }
}

export function createPlannerAgent(provider: ModelProvider) {
  return {
    async createPlan(goal: LearningGoal, now = new Date(), signal?: AbortSignal): Promise<LearningPlan> {
      if (!hasOnlyKeys(goal, ["subject", "currentLevel", "targetOutcome", "dailyMinutes", "durationWeeks"])) {
        throw new PublicHttpError(400, "学习目标格式无效");
      }
      const errors = validateGoal(goal);
      if (errors.length > 0) throw new PublicHttpError(400, errors.join("；"));

      const result = await provider.generateStructured<GeneratedPlan>({
        instructions: [
          "你是 AI Learning OS 的 Planner Agent。",
          "根据学习者起点、目标、每日时间和周期生成可执行计划。",
          "当天任务必须形成诊断、学习、实践、复盘闭环，总分钟数必须严格等于 dailyMinutes。",
          "只返回符合给定 JSON Schema 的数据，不添加说明文字。",
        ].join("\n"),
        input: JSON.stringify(goal),
        signal,
        schema: { name: "learning_plan", value: LEARNING_PLAN_SCHEMA },
      });

      assertGeneratedPlan(result.value, goal);
      return {
        id: planId(goal.subject, now),
        createdAt: now.toISOString(),
        goal: { ...goal },
        stages: result.value.stages,
        today: result.value.today.map((task) => ({ ...task, completed: false })),
      };
    },
  };
}
