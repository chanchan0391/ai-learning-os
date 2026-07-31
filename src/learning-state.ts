import type {
  DailyFeedback,
  DailyLearningRecord,
  DailyTask,
  EvaluationResult,
  LearningPlan,
  LearningState,
  LearningStage,
  LearningTaskArtifact,
  TeachingSession,
} from "./types";

export const LEARNING_STATE_VERSION = 3 as const;
export const LEARNING_EXPORT_VERSION = 1 as const;

export interface LearningStateExport {
  format: "ai-learning-os-learning-data";
  exportVersion: typeof LEARNING_EXPORT_VERSION;
  exportedAt: string;
  state: LearningState;
}

export type ParsedLearningStateExport =
  | { status: "valid"; data: LearningStateExport }
  | { status: "invalid"; error: string };

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
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
  if (!isNonEmptyString(value.id)
    || !isValidDate(value.createdAt)
    || !isNonEmptyString(goal.subject)
    || !isNonEmptyString(goal.currentLevel)
    || !isNonEmptyString(goal.targetOutcome)
  ) return false;
  if (!Number.isInteger(goal.dailyMinutes) || Number(goal.dailyMinutes) < 15 || Number(goal.dailyMinutes) > 240
    || !Number.isInteger(goal.durationWeeks) || Number(goal.durationWeeks) < 1 || Number(goal.durationWeeks) > 52
    || !Array.isArray(value.stages) || value.stages.length === 0
    || !Array.isArray(value.today) || value.today.length === 0 || !value.today.every(isDailyTask)) return false;
  const stages: unknown[] = value.stages;
  const today: DailyTask[] = value.today;
  const stagesValid = stages.every((stage, index) => isRecord(stage)
    && isNonEmptyString(stage.id)
    && isNonEmptyString(stage.title)
    && isNonEmptyString(stage.outcome)
    && Number.isInteger(stage.startWeek)
    && Number.isInteger(stage.endWeek)
    && Number(stage.startWeek) === (index === 0 ? 1 : Number((stages[index - 1] as Record<string, unknown>).endWeek) + 1)
    && Number(stage.endWeek) >= Number(stage.startWeek)
    && Number(stage.endWeek) <= Number(goal.durationWeeks));
  const stageIds = stages.map((stage) => isRecord(stage) ? stage.id : undefined);
  const taskIds = today.map((task) => task.id);
  return stagesValid
    && Number((stages.at(-1) as Record<string, unknown>).endWeek) === Number(goal.durationWeeks)
    && new Set(stageIds).size === stageIds.length
    && new Set(taskIds).size === taskIds.length
    && today.reduce((sum, task) => sum + task.minutes, 0) === Number(goal.dailyMinutes);
}

function isTeachingSession(value: unknown): value is TeachingSession {
  return isRecord(value)
    && isNonEmptyString(value.concept)
    && isNonEmptyString(value.explanation)
    && isNonEmptyString(value.workedExample)
    && isNonEmptyString(value.practicePrompt)
    && Array.isArray(value.completionSignals)
    && value.completionSignals.length > 0
    && value.completionSignals.every(isNonEmptyString)
    && Array.isArray(value.understandingChecks)
    && value.understandingChecks.length >= 2
    && value.understandingChecks.length <= 3
    && value.understandingChecks.every((check) => isRecord(check)
      && isNonEmptyString(check.id)
      && isNonEmptyString(check.prompt)
      && Array.isArray(check.expectedSignals)
      && check.expectedSignals.length > 0
      && check.expectedSignals.every(isNonEmptyString))
    && new Set(value.understandingChecks.map((check) => isRecord(check) ? check.id : undefined)).size === value.understandingChecks.length;
}

function isEvaluationResult(value: unknown): value is EvaluationResult {
  const dimensions = ["understanding", "application", "evidence", "reflection"];
  if (!isRecord(value) || !Array.isArray(value.rubric) || value.rubric.length !== 4) return false;
  const rubricValid = value.rubric.every((item) => isRecord(item)
    && dimensions.includes(String(item.dimension))
    && Number.isInteger(item.score)
    && Number(item.score) >= 0
    && Number(item.score) <= 4
    && typeof item.evidence === "string"
    && typeof item.feedback === "string");
  const scores = value.rubric.map((item) => isRecord(item) ? Number(item.score) : 0);
  const rubricDimensions = value.rubric.map((item) => isRecord(item) ? String(item.dimension) : "");
  const total = scores.reduce((sum, score) => sum + score, 0);
  const expectedMastery = total <= 7 ? "needs-support" : total <= 12 ? "developing" : "ready";
  return rubricValid
    && new Set(rubricDimensions).size === 4
    && Number.isInteger(value.totalScore)
    && Number(value.totalScore) === total
    && value.masteryLevel === expectedMastery
    && Array.isArray(value.misconceptions)
    && value.misconceptions.every((item) => typeof item === "string")
    && typeof value.nextAction === "string";
}

function isLearningTaskArtifact(value: unknown): value is LearningTaskArtifact {
  if (!isRecord(value)) return false;
  const responsesValid = value.understandingResponses === undefined || (
    isRecord(value.understandingResponses) && Object.values(value.understandingResponses).every((response) => typeof response === "string")
  );
  return responsesValid
    && (value.teachingSession === undefined || isTeachingSession(value.teachingSession))
    && (value.submission === undefined || typeof value.submission === "string")
    && (value.evaluation === undefined || isEvaluationResult(value.evaluation));
}

function isDailyRecord(value: unknown): value is DailyLearningRecord {
  if (!isRecord(value)) return false;
  const hasValidFeedback = value.feedback === undefined || (
    isRecord(value.feedback)
    && ["too-easy", "just-right", "too-hard"].includes(String(value.feedback.difficulty))
    && typeof value.feedback.reflection === "string"
  );
  const validCompletion = value.status === "active" || (
    isValidDate(value.completedAt)
    && hasValidFeedback
    && isRecord(value.feedback)
  );
  const artifactsValid = isRecord(value.artifacts)
    && Object.entries(value.artifacts).every(([taskId, artifact]) => value.tasks instanceof Array
      && value.tasks.some((task) => isRecord(task) && task.id === taskId)
      && isLearningTaskArtifact(artifact));
  return Number.isInteger(value.day)
    && Number(value.day) > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(String(value.date))
    && (value.status === "active" || value.status === "completed")
    && Array.isArray(value.tasks)
    && value.tasks.length > 0
    && value.tasks.every(isDailyTask)
    && new Set(value.tasks.map((task) => task.id)).size === value.tasks.length
    && artifactsValid
    && hasValidFeedback
    && validCompletion;
}

function isLearningState(value: unknown): value is LearningState {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.days) || !isLearningPlan(value.plan)) return false;
  const days = value.days;
  const plan = value.plan;
  return value.version === LEARNING_STATE_VERSION
    && Number.isInteger(value.currentDay)
    && Number(value.currentDay) <= plan.goal.durationWeeks * 7
    && value.days.length > 0
    && days.every(isDailyRecord)
    && days.every((day) => isRecord(day) && Array.isArray(day.tasks)
      && day.tasks.reduce((sum, task) => sum + (isRecord(task) ? Number(task.minutes) : 0), 0) === plan.goal.dailyMinutes)
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
    days: [{ day: 1, date: dateKey(now), tasks: plan.today, status: "active", artifacts: {} }],
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
    if (isRecord(value) && value.version === 2 && Array.isArray(value.days)) {
      const migrated = {
        ...value,
        version: LEARNING_STATE_VERSION,
        days: value.days.map((day) => isRecord(day) ? { ...day, artifacts: {} } : day),
      };
      if (isLearningState(migrated)) return { state: migrated, status: "migrated" };
    }
    if (isLearningPlan(value)) return { state: initializeLearningState(value, now), status: "migrated" };
    return { state: null, status: "recovered" };
  } catch {
    return { state: null, status: "recovered" };
  }
}

export function createLearningStateExport(state: LearningState, now = new Date()): LearningStateExport {
  return {
    format: "ai-learning-os-learning-data",
    exportVersion: LEARNING_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    state,
  };
}

export function serializeLearningStateExport(state: LearningState, now = new Date()): string {
  return `${JSON.stringify(createLearningStateExport(state, now), null, 2)}\n`;
}

export function parseLearningStateExport(raw: string): ParsedLearningStateExport {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.format !== "ai-learning-os-learning-data") {
      return { status: "invalid", error: "这不是 AI Learning OS 学习记录文件。" };
    }
    if (value.exportVersion !== LEARNING_EXPORT_VERSION) {
      return { status: "invalid", error: "此学习记录版本暂不受支持。" };
    }
    if (typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt))) {
      return { status: "invalid", error: "学习记录缺少有效的导出时间。" };
    }
    if (!isLearningState(value.state)) {
      return { status: "invalid", error: "学习记录内容不完整或已损坏。" };
    }
    return { status: "valid", data: value as unknown as LearningStateExport };
  } catch {
    return { status: "invalid", error: "无法读取此 JSON 学习记录。" };
  }
}

export function learningStateExportFilename(now = new Date()): string {
  return `ai-learning-os-learning-data-${dateKey(now)}.json`;
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

function updateCurrentRecord(state: LearningState, update: (record: DailyLearningRecord) => DailyLearningRecord): LearningState {
  return { ...state, days: state.days.map((day) => day.day === state.currentDay ? update(day) : day) };
}

export function saveTeachingSession(state: LearningState, taskId: string, session: TeachingSession): LearningState {
  return updateCurrentRecord(state, (record) => ({
    ...record,
    artifacts: { ...record.artifacts, [taskId]: { ...record.artifacts[taskId], teachingSession: session } },
  }));
}

export function saveUnderstandingResponse(state: LearningState, taskId: string, checkId: string, response: string): LearningState {
  return updateCurrentRecord(state, (record) => ({
    ...record,
    artifacts: {
      ...record.artifacts,
      [taskId]: {
        ...record.artifacts[taskId],
        understandingResponses: { ...record.artifacts[taskId]?.understandingResponses, [checkId]: response },
      },
    },
  }));
}

export function completeTeachingTask(state: LearningState, taskId: string): LearningState {
  const record = getCurrentRecord(state);
  const artifact = record.artifacts[taskId];
  const checks = artifact?.teachingSession?.understandingChecks ?? [];
  if (checks.length === 0 || checks.some((check) => !artifact.understandingResponses?.[check.id]?.trim())) {
    throw new Error("请先回答全部理解检查");
  }
  return toggleCurrentTask(state, taskId);
}

export function saveEvaluation(state: LearningState, taskId: string, submission: string, evaluation: EvaluationResult): LearningState {
  return updateCurrentRecord(state, (record) => ({
    ...record,
    tasks: record.tasks.map((task) => task.id === taskId ? { ...task, completed: true } : task),
    artifacts: {
      ...record.artifacts,
      [taskId]: { ...record.artifacts[taskId], submission: submission.trim(), evaluation },
    },
  }));
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
  const evaluations = Object.values(getCurrentRecord(state).artifacts).flatMap((artifact) => artifact.evaluation ? [artifact.evaluation] : []);
  const evaluation = evaluations.sort((a, b) => a.totalScore - b.totalScore)[0];
  const evaluationFocus = evaluation
    ? `评估反馈：${evaluation.nextAction}${evaluation.misconceptions.length > 0 ? `；重点纠正：${evaluation.misconceptions.join("、")}` : ""}`
    : "根据昨天的自评继续推进";

  return [
    {
      id: `day-${day}-diagnose`, type: "diagnose", title: "检索昨天的关键知识",
      description: `不查资料，复述昨天最重要的结论，并回答：${feedback.reflection.trim() || "还有什么没有真正掌握？"}`,
      minutes: diagnose, completed: false,
    },
    {
      id: `day-${day}-learn`, type: "learn", title: `推进：${stage.title}`,
      description: `${adjustment}。${evaluationFocus}。围绕“${stage.outcome}”补充一个关键概念和一个反例。`,
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
      artifacts: {},
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
