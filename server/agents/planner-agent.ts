import { validateGoal } from "../../src/planner";
import type { DailyTask, LearningGoal, LearningPlan, LearningStage } from "../../src/types";
import type { JsonSchema, ModelProvider } from "../ai/model-provider";
import { AgentOutputError } from "./agent-errors";

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
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "outcome", "startWeek", "endWeek"],
        properties: {
          id: { type: "string" }, title: { type: "string" }, outcome: { type: "string" },
          startWeek: { type: "integer", minimum: 1 }, endWeek: { type: "integer", minimum: 1 },
        },
      },
    },
    today: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "title", "description", "minutes", "completed"],
        properties: {
          id: { type: "string" }, type: { type: "string", enum: ["diagnose", "learn", "practice", "reflect"] },
          title: { type: "string" }, description: { type: "string" }, minutes: { type: "integer", minimum: 1 },
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
  if (!Array.isArray(value.stages) || value.stages.length === 0) throw new AgentOutputError("Planner Agent returned no stages");
  if (!Array.isArray(value.today) || value.today.length === 0) throw new AgentOutputError("Planner Agent returned no daily tasks");
  const minutes = value.today.reduce((sum, task) => sum + task.minutes, 0);
  if (minutes !== goal.dailyMinutes) throw new AgentOutputError(`Daily task budget must equal ${goal.dailyMinutes} minutes`);
  if (value.today.some((task) => task.completed)) throw new AgentOutputError("New tasks must be incomplete");
  if (value.stages.some((stage) => stage.startWeek < 1 || stage.endWeek < stage.startWeek || stage.endWeek > goal.durationWeeks)) {
    throw new AgentOutputError("Planner Agent returned invalid stage week ranges");
  }
}

export function createPlannerAgent(provider: ModelProvider) {
  return {
    async createPlan(goal: LearningGoal, now = new Date()): Promise<LearningPlan> {
      const errors = validateGoal(goal);
      if (errors.length > 0) throw new TypeError(errors.join("；"));

      const result = await provider.generateStructured<GeneratedPlan>({
        instructions: [
          "你是 AI Learning OS 的 Planner Agent。",
          "根据学习者起点、目标、每日时间和周期生成可执行计划。",
          "当天任务必须形成诊断、学习、实践、复盘闭环，总分钟数必须严格等于 dailyMinutes。",
          "只返回符合给定 JSON Schema 的数据，不添加说明文字。",
        ].join("\n"),
        input: JSON.stringify(goal),
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
