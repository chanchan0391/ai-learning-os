import type { DailyTask } from "../../src/types";
export { AGENT_INPUT_LIMITS } from "../../src/agent-limits";
export { AGENT_OUTPUT_LIMITS } from "../../src/agent-limits";
import { AGENT_INPUT_LIMITS } from "../../src/agent-limits";

export function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

export function isValidAgentTask(value: unknown): value is DailyTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<DailyTask>;
  return isBoundedText(task.id, AGENT_INPUT_LIMITS.taskIdCharacters)
    && ["diagnose", "learn", "practice", "reflect"].includes(task.type ?? "")
    && isBoundedText(task.title, AGENT_INPUT_LIMITS.taskTitleCharacters)
    && isBoundedText(task.description, AGENT_INPUT_LIMITS.taskDescriptionCharacters)
    && Number.isInteger(task.minutes) && task.minutes! >= 1 && task.minutes! <= 240
    && typeof task.completed === "boolean";
}

export function isBoundedTextList(value: unknown, maximumItems: number, maximumCharacters: number): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems
    && value.every((item) => isBoundedText(item, maximumCharacters));
}
