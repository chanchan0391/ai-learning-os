import type {
  DailyFeedback,
  DailyLearningRecord,
  DailyTask,
  LearningPlan,
  LearningState,
  LearningStage,
} from "./types";

export const LEARNING_STATE_VERSION = 2 as const;

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDailyTask(value: unknown): value is DailyTask {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && ["diagnose", "learn", "practice", "reflect"].includes(String(value.type))
    && typeof value.title === "string"
    && typeof value.description === "string"
    && Number.isInteger(value.minutes)
    && Number(value.minutes) > 0
    && typeof value.completed === "boolean";
}

function isLearningPlan(value: unknown): value is LearningPlan {
  if (!isRecord(value) || !isRecord(value.goal)) return false;
  const goal = value.goal;
  return typeof value.id === "string"
    && typeof value.createdAt === "string"
    && typeof goal.subject === "string"
    && typeof goal.currentLevel === "string"
    && typeof goal.targetOutcome === "string"
    && Number.isInteger(goal.dailyMinutes)
    && Number.isInteger(goal.durationWeeks)
    && Array.isArray(value.stages)
    && Array.isArray(value.today)
    && value.today.length > 0
    && value.today.every(isDailyTask);
}

function isDailyRecord(value: unknown): value is DailyLearningRecord {
  if (!isRecord(value)) return false;
  const hasValidFeedback = value.feedback === undefined || (
    isRecord(value.feedback)
    && ["too-easy", "just-right", "too-hard"].includes(String(value.feedback.difficulty))
    && typeof value.feedback.reflection === "string"
  );
  const validCompletion = value.status === "active" || (
    typeof value.completedAt === "string"
    && hasValidFeedback
    && isRecord(value.feedback)
  );
  return Number.isInteger(value.day)
    && Number(value.day) > 0
    && typeof value.date === "string"
    && (value.status === "active" || value.status === "completed")
    && Array.isArray(value.tasks)
    && value.tasks.length > 0
    && value.tasks.every(isDailyTask)
    && validCompletion;
}

function isLearningState(value: unknown): value is LearningState {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.days)) return false;
  const days = value.days;
  return value.version === LEARNING_STATE_VERSION
    && isLearningPlan(value.plan)
    && Number.isInteger(value.currentDay)
    && value.days.length > 0
    && days.every(isDailyRecord)
    && days.every((day, index) => isRecord(day) && day.day === index + 1)
    && isRecord(days.at(-1))
    && days.at(-1)?.day === value.currentDay
    && days.slice(0, -1).every((day) => isRecord(day) && day.status === "completed");
}

export function initializeLearningState(plan: LearningPlan, now = new Date()): LearningState {
  return {
    version: LEARNING_STATE_VERSION,
    plan,
    currentDay: 1,
    days: [{ day: 1, date: dateKey(now), tasks: plan.today, status: "active" }],
  };
}

export interface ParsedLearningState {
  state: LearningState | null;
  status: "empty" | "valid" | "migrated" | "recovered";
}

export function parseLearningState(raw: string | null, now = new Date()): ParsedLearningState {
  if (!raw) return { state: null, status: "empty" };
  try {
    const value: unknown = JSON.parse(raw);
    if (isLearningState(value)) return { state: value, status: "valid" };
    if (isLearningPlan(value)) return { state: initializeLearningState(value, now), status: "migrated" };
    return { state: null, status: "recovered" };
  } catch {
    return { state: null, status: "recovered" };
  }
}

export function getCurrentRecord(state: LearningState): DailyLearningRecord {
  const current = state.days.find((day) => day.day === state.currentDay);
  if (!current) throw new Error("当前学习日不存在");
  return current;
}

export function toggleCurrentTask(state: LearningState, taskId: string): LearningState {
  if (getCurrentRecord(state).status === "completed") return state;
  return {
    ...state,
    days: state.days.map((day) => day.day !== state.currentDay ? day : {
      ...day,
      tasks: day.tasks.map((task) => task.id === taskId ? { ...task, completed: !task.completed } : task),
    }),
  };
}

function stageForDay(stages: LearningStage[], day: number): LearningStage {
  const week = Math.ceil(day / 7);
  return stages.find((stage) => week >= stage.startWeek && week <= stage.endWeek) ?? stages.at(-1)!;
}

function allocateMinutes(total: number): [number, number, number, number] {
  const diagnose = Math.max(3, Math.round(total * 0.1));
  const learn = Math.max(5, Math.round(total * 0.3));
  const reflect = Math.max(3, Math.round(total * 0.15));
  return [diagnose, learn, total - diagnose - learn - reflect, reflect];
}

export function buildNextDayTasks(state: LearningState, feedback: DailyFeedback): DailyTask[] {
  const day = state.currentDay + 1;
  const { goal, stages } = state.plan;
  const stage = stageForDay(stages, day);
  const [diagnose, learn, practice, reflect] = allocateMinutes(goal.dailyMinutes);
  const adjustment = feedback.difficulty === "too-hard"
    ? "先缩小范围，用一个具体例子拆解昨天的难点"
    : feedback.difficulty === "too-easy"
      ? "提高约束，尝试独立完成更接近真实场景的挑战"
      : "保持当前节奏，把昨天的薄弱点再推进一步";

  return [
    {
      id: `day-${day}-diagnose`, type: "diagnose", title: "检索昨天的关键知识",
      description: `不查资料，复述昨天最重要的结论，并回答：${feedback.reflection.trim() || "还有什么没有真正掌握？"}`,
      minutes: diagnose, completed: false,
    },
    {
      id: `day-${day}-learn`, type: "learn", title: `推进：${stage.title}`,
      description: `${adjustment}。围绕“${stage.outcome}”补充一个关键概念和一个反例。`,
      minutes: learn, completed: false,
    },
    {
      id: `day-${day}-practice`, type: "practice", title: "完成递进实践",
      description: `为“${goal.targetOutcome}”增加一个可验证的小成果，并记录判断成功的证据。`,
      minutes: practice, completed: false,
    },
    {
      id: `day-${day}-reflect`, type: "reflect", title: "反馈与明日线索",
      description: "记录今天改变的一项理解、仍会犯的一个错误，以及下一步最小行动。",
      minutes: reflect, completed: false,
    },
  ];
}

export function completeCurrentDay(state: LearningState, feedback: DailyFeedback, now = new Date()): LearningState {
  const current = getCurrentRecord(state);
  if (current.tasks.some((task) => !task.completed)) throw new Error("请先完成今天的全部任务");
  if (!feedback.difficulty) throw new Error("请选择今天的任务难度");

  const completedAt = now.toISOString();
  const completedDays = state.days.map((day) => day.day === state.currentDay
    ? { ...day, status: "completed" as const, completedAt, feedback: { ...feedback, reflection: feedback.reflection.trim() } }
    : day);
  const maxDays = state.plan.goal.durationWeeks * 7;
  if (state.currentDay >= maxDays) return { ...state, days: completedDays };

  const nextDay = state.currentDay + 1;
  return {
    ...state,
    currentDay: nextDay,
    days: [...completedDays, {
      day: nextDay,
      date: dateKey(now),
      tasks: buildNextDayTasks(state, feedback),
      status: "active",
    }],
  };
}

export function completedDayCount(state: LearningState): number {
  return state.days.filter((day) => day.status === "completed").length;
}

export function learningStreak(state: LearningState): number {
  const completed = [...state.days].filter((day) => day.status === "completed").sort((a, b) => b.day - a.day);
  if (completed.length === 0) return 0;
  let streak = 1;
  for (let index = 1; index < completed.length; index += 1) {
    if (completed[index - 1].day - completed[index].day !== 1) break;
    streak += 1;
  }
  return streak;
}
