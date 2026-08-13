import type { DailyTask, LearningGoal, LearningPlan, LearningStage } from "./types";

const AI_TOPICS = [
  ["建立基础", "理解 LLM、Prompt 与 AI 应用的核心概念"],
  ["构建知识增强应用", "完成一个带检索与引用的 RAG 应用"],
  ["设计 Agent 工作流", "掌握工具调用、状态管理与评估方法"],
  ["交付企业级项目", "完成可演示、可测试的 AI Agent 项目"],
] as const;

const GENERIC_TOPICS = [
  ["建立基础", "形成清晰的知识地图并掌握关键概念"],
  ["核心训练", "通过刻意练习掌握核心方法"],
  ["真实应用", "在真实场景中独立应用所学能力"],
  ["综合交付", "完成可以展示和复盘的成果"],
] as const;

export const LEARNING_GOAL_LIMITS = {
  subjectCharacters: 200,
  currentLevelCharacters: 2_000,
  targetOutcomeCharacters: 2_000,
} as const;

export function validateGoal(goal: LearningGoal): string[] {
  const errors: string[] = [];
  const value = goal as Partial<LearningGoal> | null | undefined;
  if (typeof value?.subject !== "string" || value.subject.trim().length < 2) errors.push("请填写要学习的主题");
  else if (value.subject.length > LEARNING_GOAL_LIMITS.subjectCharacters) errors.push(`学习主题不能超过 ${LEARNING_GOAL_LIMITS.subjectCharacters} 个字符`);
  if (typeof value?.currentLevel !== "string" || value.currentLevel.trim().length < 2) errors.push("请描述当前基础");
  else if (value.currentLevel.length > LEARNING_GOAL_LIMITS.currentLevelCharacters) errors.push(`当前基础不能超过 ${LEARNING_GOAL_LIMITS.currentLevelCharacters} 个字符`);
  if (typeof value?.targetOutcome !== "string" || value.targetOutcome.trim().length < 4) errors.push("请描述希望达成的结果");
  else if (value.targetOutcome.length > LEARNING_GOAL_LIMITS.targetOutcomeCharacters) errors.push(`目标成果不能超过 ${LEARNING_GOAL_LIMITS.targetOutcomeCharacters} 个字符`);
  const dailyMinutes = value?.dailyMinutes;
  if (typeof dailyMinutes !== "number" || !Number.isInteger(dailyMinutes) || dailyMinutes < 15 || dailyMinutes > 240) errors.push("每日时间应在 15–240 分钟之间");
  const durationWeeks = value?.durationWeeks;
  if (typeof durationWeeks !== "number" || !Number.isInteger(durationWeeks) || durationWeeks < 1 || durationWeeks > 52) errors.push("学习周期应在 1–52 周之间");
  return errors;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "") || "learning-goal";
}

function buildStages(goal: LearningGoal): LearningStage[] {
  const isAiGoal = /\b(ai|llm|agent|rag|人工智能|大模型|智能体)\b/i.test(goal.subject);
  const topics = isAiGoal ? AI_TOPICS : GENERIC_TOPICS;
  const stageCount = Math.min(topics.length, goal.durationWeeks);

  return topics.slice(0, stageCount).map(([title, outcome], index) => {
    const startWeek = Math.floor((index * goal.durationWeeks) / stageCount) + 1;
    const endWeek = Math.floor(((index + 1) * goal.durationWeeks) / stageCount);
    return {
      id: `stage-${index + 1}`,
      title,
      outcome: index === stageCount - 1 ? `${outcome}：${goal.targetOutcome}` : outcome,
      startWeek,
      endWeek,
    };
  });
}

function allocateMinutes(total: number): [number, number, number, number] {
  const diagnose = Math.max(3, Math.round(total * 0.12));
  const learn = Math.max(5, Math.round(total * 0.33));
  const reflect = Math.max(3, Math.round(total * 0.12));
  const practice = total - diagnose - learn - reflect;
  return [diagnose, learn, practice, reflect];
}

function buildToday(goal: LearningGoal): DailyTask[] {
  const [diagnose, learn, practice, reflect] = allocateMinutes(goal.dailyMinutes);
  return [
    {
      id: "day-1-diagnose",
      type: "diagnose",
      title: "快速基线评估",
      description: `不查资料，写下你对“${goal.subject}”的理解、已有经验和三个疑问。`,
      minutes: diagnose,
      completed: false,
    },
    {
      id: "day-1-learn",
      type: "learn",
      title: "建立第一张知识地图",
      description: `找出 ${goal.subject} 的五个核心概念，并用自己的话说明它们之间的关系。`,
      minutes: learn,
      completed: false,
    },
    {
      id: "day-1-practice",
      type: "practice",
      title: "完成最小实践",
      description: `围绕“${goal.targetOutcome}”做一个最小可验证练习，保留过程和结果。`,
      minutes: practice,
      completed: false,
    },
    {
      id: "day-1-reflect",
      type: "reflect",
      title: "复盘与明日准备",
      description: "记录一个掌握点、一个薄弱点，以及明天最需要解决的问题。",
      minutes: reflect,
      completed: false,
    },
  ];
}

export function generateLearningPlan(goal: LearningGoal, now = new Date()): LearningPlan {
  const errors = validateGoal(goal);
  if (errors.length > 0) throw new Error(errors.join("；"));

  return {
    id: `${slug(goal.subject)}-${now.toISOString().slice(0, 10)}`,
    createdAt: now.toISOString(),
    goal: { ...goal, subject: goal.subject.trim(), currentLevel: goal.currentLevel.trim(), targetOutcome: goal.targetOutcome.trim() },
    stages: buildStages(goal),
    today: buildToday(goal),
    notes: [],
  };
}

export function completionRate(tasks: DailyTask[]): number {
  if (tasks.length === 0) return 0;
  return Math.round((tasks.filter((task) => task.completed).length / tasks.length) * 100);
}
