import type {
  DailyFeedback,
  DailyLearningRecord,
  DailyTask,
  EvaluationResult,
  LearningPlan,
  LearningInterruption,
  LearningState,
  LearningStage,
  LearningTaskArtifact,
  ReviewRecall,
  ReviewAssessment,
  StageLearningNote,
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

export interface WeeklyLearningReview {
  completedDays: number;
  totalMinutes: number;
  evaluationCount: number;
  averageEvaluationScore: number | null;
  difficultDays: number;
  successfulReviews: number;
  headline: string;
  nextAction: string;
}

export interface LearningCalendarDay {
  date: string;
  dayOfMonth: number;
  status: "no-learning" | "active" | "completed";
  records: DailyLearningRecord[];
  completedDays: number;
  totalMinutes: number;
  averageEvaluationScore: number | null;
}

export interface LearningCalendarMonth {
  month: string;
  weeks: LearningCalendarDay[][];
}

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

export function isLearningPlan(value: unknown): value is LearningPlan {
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
  const notesValid = value.notes === undefined || (Array.isArray(value.notes)
    && value.notes.every((note) => isRecord(note)
      && isNonEmptyString(note.id)
      && isNonEmptyString(note.stageId)
      && stageIds.includes(note.stageId)
      && isNonEmptyString(note.title)
      && isNonEmptyString(note.content)
      && Array.isArray(note.sourceDays)
      && note.sourceDays.every((day) => Number.isInteger(day) && Number(day) > 0 && Number(day) <= Number(goal.durationWeeks) * 7)
      && new Set(note.sourceDays).size === note.sourceDays.length
      && isValidDate(note.updatedAt))
    && new Set(value.notes.map((note) => isRecord(note) ? note.id : undefined)).size === value.notes.length
    && new Set(value.notes.map((note) => isRecord(note) ? note.stageId : undefined)).size === value.notes.length);
  return stagesValid
    && Number((stages.at(-1) as Record<string, unknown>).endWeek) === Number(goal.durationWeeks)
    && new Set(stageIds).size === stageIds.length
    && new Set(taskIds).size === taskIds.length
    && notesValid
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
    && (value.evaluation === undefined || isEvaluationResult(value.evaluation))
    && (value.reviewPerformance === undefined || (isRecord(value.reviewPerformance)
      && ["forgot", "effortful", "easy"].includes(String(value.reviewPerformance.recall))
      && Array.isArray(value.reviewPerformance.sourceDays)
      && value.reviewPerformance.sourceDays.length > 0
      && value.reviewPerformance.sourceDays.every((day) => Number.isInteger(day) && Number(day) > 0)
      && new Set(value.reviewPerformance.sourceDays).size === value.reviewPerformance.sourceDays.length
      && (value.reviewPerformance.assessment === undefined || (isRecord(value.reviewPerformance.assessment)
        && isNonEmptyString(value.reviewPerformance.assessment.answer)
        && Number.isInteger(value.reviewPerformance.assessment.score)
        && Number(value.reviewPerformance.assessment.score) >= 0
        && Number(value.reviewPerformance.assessment.score) <= 4
        && value.reviewPerformance.assessment.recall === value.reviewPerformance.recall
        && isNonEmptyString(value.reviewPerformance.assessment.evidence)
        && isNonEmptyString(value.reviewPerformance.assessment.feedback)))));
}

export function isDailyRecord(value: unknown): value is DailyLearningRecord {
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
      && isLearningTaskArtifact(artifact)
      && (artifact.reviewPerformance === undefined
        || artifact.reviewPerformance.sourceDays.every((sourceDay) => sourceDay < Number(value.day))));
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

function safeFilenamePart(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[\u0000-\u001f\u007f<>:"：/\\|?*%]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return cleaned || "stage-note";
}

export function stageNoteMarkdownFilename(note: StageLearningNote, now = new Date()): string {
  return `${safeFilenamePart(note.title)}-${dateKey(now)}.md`;
}

export function serializeStageNoteMarkdown(plan: LearningPlan, noteId: string, now = new Date()): string {
  const note = (plan.notes ?? []).find((item) => item.id === noteId);
  if (!note) throw new Error("学习笔记不存在");
  const stage = plan.stages.find((item) => item.id === note.stageId);
  if (!stage) throw new Error("学习阶段不存在");
  const title = note.title.replace(/[\r\n]+/g, " ").trim();
  const sourceDays = note.sourceDays.length > 0 ? note.sourceDays.join("、") : "无";
  return [
    `# ${title}`,
    "",
    `> 学习目标：${plan.goal.subject}`,
    `> 阶段：${stage.title}（第 ${stage.startWeek}${stage.endWeek > stage.startWeek ? `–${stage.endWeek}` : ""} 周）`,
    `> 来源学习日：${sourceDays}`,
    `> 笔记更新时间：${note.updatedAt}`,
    `> 导出时间：${now.toISOString()}`,
    "",
    note.content.trim(),
    "",
  ].join("\n");
}

export function getCurrentRecord(state: LearningState): DailyLearningRecord {
  const current = state.days.find((day) => day.day === state.currentDay);
  if (!current) throw new Error("当前学习日不存在");
  return current;
}

export function weeklyLearningReview(state: LearningState): WeeklyLearningReview {
  const completed = state.days.filter((day) => day.status === "completed").slice(-7);
  const evaluations = completed.flatMap((day) => Object.values(day.artifacts)
    .flatMap((artifact) => artifact.evaluation ? [{ day: day.day, result: artifact.evaluation }] : []));
  const reviews = state.days.slice(-7).flatMap((day) => Object.values(day.artifacts)
    .flatMap((artifact) => artifact.reviewPerformance ? [artifact.reviewPerformance] : []));
  const totalScore = evaluations.reduce((sum, item) => sum + item.result.totalScore, 0);
  const averageEvaluationScore = evaluations.length > 0 ? Math.round((totalScore / evaluations.length) * 10) / 10 : null;
  const difficultDays = completed.filter((day) => day.feedback?.difficulty === "too-hard").length;
  const weakestEvaluation = [...evaluations].sort((left, right) => left.result.totalScore - right.result.totalScore || right.day - left.day)[0];
  const latestReflection = [...completed].reverse().find((day) => day.feedback?.reflection.trim())?.feedback?.reflection.trim();

  let headline = "完成第一天后，这里会形成你的周回顾。";
  if (completed.length > 0 && difficultDays >= 2) headline = "本周难度偏高，先缩小下一步。";
  else if (averageEvaluationScore !== null && averageEvaluationScore >= 13) headline = "本周成果证据显示掌握正在变稳。";
  else if (evaluations.length > 0) headline = "本周已经形成可用于调整计划的证据。";
  else if (completed.length > 0) headline = "本周节奏已启动，下一步补充成果证据。";

  return {
    completedDays: completed.length,
    totalMinutes: completed.reduce((sum, day) => sum + day.tasks.reduce((minutes, task) => minutes + task.minutes, 0), 0),
    evaluationCount: evaluations.length,
    averageEvaluationScore,
    difficultDays,
    successfulReviews: reviews.filter((review) => review.recall === "easy").length,
    headline,
    nextAction: weakestEvaluation?.result.nextAction
      ?? latestReflection
      ?? (completed.length > 0 ? "完成一次可验证的实践成果并获取评估。" : "完成今天的学习闭环。"),
  };
}

export function learningProgressMarkdownFilename(now = new Date()): string {
  return `ai-learning-os-progress-${dateKey(now)}.md`;
}

export function serializeLearningProgressMarkdown(state: LearningState, now = new Date()): string {
  const review = weeklyLearningReview(state);
  const stages = state.plan.stages.map((stage) => {
    const records = state.days.filter((record) => {
      const week = Math.ceil(record.day / 7);
      return week >= stage.startWeek && week <= stage.endWeek;
    });
    const completed = records.filter((record) => record.status === "completed");
    const evaluations = records.flatMap((record) => Object.values(record.artifacts)
      .flatMap((artifact) => artifact.evaluation ? [artifact.evaluation] : []));
    const average = evaluations.length > 0
      ? Math.round((evaluations.reduce((sum, result) => sum + result.totalScore, 0) / evaluations.length) * 10) / 10
      : null;
    const plannedDays = (stage.endWeek - stage.startWeek + 1) * 7;
    const note = (state.plan.notes ?? []).find((item) => item.stageId === stage.id);
    return [
      `### ${stage.title}`,
      "",
      `- 阶段目标：${stage.outcome}`,
      `- 已完成：${completed.length}/${plannedDays} 个学习日`,
      `- 成果评估：${evaluations.length} 次${average === null ? "" : `，平均 ${average}/16`}`,
      `- 阶段笔记：${note ? `${note.title}（${note.sourceDays.length} 个来源日）` : "尚未建立"}`,
    ].join("\n");
  });
  return [
    `# ${state.plan.goal.subject} 学习进展`,
    "",
    `> 学习目标：${state.plan.goal.targetOutcome}`,
    `> 导出时间：${now.toISOString()}`,
    "",
    "## 最近 7 个完成日",
    "",
    review.headline,
    "",
    `- 完成日：${review.completedDays}`,
    `- 投入时间：${review.totalMinutes} 分钟`,
    `- 成果评估：${review.evaluationCount} 次${review.averageEvaluationScore === null ? "" : `，平均 ${review.averageEvaluationScore}/16`}`,
    `- 偏难日：${review.difficultDays}`,
    `- 轻松回忆：${review.successfulReviews}`,
    `- 最小下一步：${review.nextAction}`,
    "",
    "## 阶段进展",
    "",
    stages.join("\n\n"),
    "",
  ].join("\n");
}

export function learningCalendarMonth(state: LearningState, month: string): LearningCalendarMonth {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("日历月份格式无效");
  const [year, monthNumber] = month.split("-").map(Number);
  const firstDay = new Date(Date.UTC(year, monthNumber - 1, 1));
  if (firstDay.getUTCFullYear() !== year || firstDay.getUTCMonth() !== monthNumber - 1) {
    throw new Error("日历月份格式无效");
  }
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const mondayOffset = (firstDay.getUTCDay() + 6) % 7;
  const recordsByDate = new Map<string, DailyLearningRecord[]>();
  for (const record of state.days) {
    const existing = recordsByDate.get(record.date) ?? [];
    existing.push(record);
    recordsByDate.set(record.date, existing);
  }

  const cells: LearningCalendarDay[] = [];
  const totalCells = Math.ceil((mondayOffset + daysInMonth) / 7) * 7;
  for (let index = 0; index < totalCells; index += 1) {
    const date = new Date(Date.UTC(year, monthNumber - 1, index - mondayOffset + 1));
    const dateString = dateKey(date);
    const inMonth = date.getUTCMonth() === monthNumber - 1;
    const records = inMonth ? recordsByDate.get(dateString) ?? [] : [];
    const completed = records.filter((record) => record.status === "completed");
    const evaluations = records.flatMap((record) => Object.values(record.artifacts)
      .flatMap((artifact) => artifact.evaluation ? [artifact.evaluation] : []));
    const totalScore = evaluations.reduce((sum, evaluation) => sum + evaluation.totalScore, 0);
    cells.push({
      date: inMonth ? dateString : "",
      dayOfMonth: inMonth ? date.getUTCDate() : 0,
      status: records.some((record) => record.status === "active") ? "active" : completed.length > 0 ? "completed" : "no-learning",
      records,
      completedDays: completed.length,
      totalMinutes: completed.reduce((sum, record) => sum + record.tasks.reduce((minutes, task) => minutes + task.minutes, 0), 0),
      averageEvaluationScore: evaluations.length > 0 ? Math.round((totalScore / evaluations.length) * 10) / 10 : null,
    });
  }

  return { month, weeks: Array.from({ length: totalCells / 7 }, (_, index) => cells.slice(index * 7, index * 7 + 7)) };
}

export function detectLearningInterruption(state: LearningState, now = new Date()): LearningInterruption | null {
  const current = getCurrentRecord(state);
  if (current.status === "completed") return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const lastActive = Date.parse(`${current.date}T00:00:00.000Z`);
  const daysSinceActivity = Math.max(0, Math.floor((today - lastActive) / 86_400_000));
  const inactiveDays = Math.max(0, daysSinceActivity - 1);
  const recentDifficultDays = [...state.days]
    .filter((day) => day.status === "completed")
    .reverse()
    .slice(0, 2)
    .filter((day) => day.feedback?.difficulty === "too-hard").length;
  const inactivity = inactiveDays >= 2;
  const repeatedDifficulty = recentDifficultDays >= 2;
  if (!inactivity && !repeatedDifficulty) return null;
  return {
    reason: inactivity && repeatedDifficulty ? "both" : inactivity ? "inactivity" : "repeated-difficulty",
    inactiveDays,
    recentDifficultDays,
    lastActiveDate: current.date,
  };
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

function noteTextForRecord(record: DailyLearningRecord): string[] {
  const lines: string[] = [];
  for (const artifact of Object.values(record.artifacts)) {
    if (artifact.teachingSession) {
      lines.push(`概念：${artifact.teachingSession.concept}`);
      lines.push(`要点：${artifact.teachingSession.explanation}`);
      lines.push(`示例：${artifact.teachingSession.workedExample}`);
    }
    const responses = Object.values(artifact.understandingResponses ?? {}).map((response) => response.trim()).filter(Boolean);
    if (responses.length > 0) lines.push(`我的理解：${responses.join("；")}`);
    if (artifact.submission?.trim()) lines.push(`实践证据：${artifact.submission.trim()}`);
    if (artifact.evaluation) {
      lines.push(`评估：${artifact.evaluation.masteryLevel}（${artifact.evaluation.totalScore}/16）`);
      if (artifact.evaluation.misconceptions.length > 0) lines.push(`待纠正：${artifact.evaluation.misconceptions.join("、")}`);
      lines.push(`下一步：${artifact.evaluation.nextAction}`);
    }
  }
  if (record.feedback?.reflection.trim()) lines.push(`复盘：${record.feedback.reflection.trim()}`);
  return lines;
}

function stageRecords(state: LearningState, stage: LearningStage): DailyLearningRecord[] {
  return state.days.filter((record) => {
    const week = Math.ceil(record.day / 7);
    return week >= stage.startWeek && week <= stage.endWeek;
  });
}

function noteEvidenceForRecords(records: DailyLearningRecord[]): { content: string; sourceDays: number[] } {
  const sections = records.flatMap((record) => {
    const lines = noteTextForRecord(record);
    return lines.length > 0 ? [{ day: record.day, content: `第 ${record.day} 天\n${lines.join("\n")}` }] : [];
  });
  return {
    content: sections.map((section) => section.content).join("\n\n"),
    sourceDays: sections.map((section) => section.day),
  };
}

export function generateStageNote(state: LearningState, stageId: string, now = new Date()): LearningState {
  const stage = state.plan.stages.find((item) => item.id === stageId);
  if (!stage) throw new Error("学习阶段不存在");
  if ((state.plan.notes ?? []).some((note) => note.stageId === stageId)) throw new Error("这个阶段已经有学习笔记");
  const evidence = noteEvidenceForRecords(stageRecords(state, stage));
  const note: StageLearningNote = {
    id: `note-${stage.id}`,
    stageId: stage.id,
    title: `${stage.title}学习笔记`,
    content: [
      `阶段目标：${stage.outcome}`,
      evidence.content || "尚无学习成果。完成教学、实践或复盘后，可在这里补充关键结论。",
    ].join("\n\n"),
    sourceDays: evidence.sourceDays,
    updatedAt: now.toISOString(),
  };
  return { ...state, plan: { ...state.plan, notes: [...(state.plan.notes ?? []), note] } };
}

export function createStageNote(
  state: LearningState,
  stageId: string,
  draft: Pick<StageLearningNote, "title" | "content">,
  now = new Date(),
): LearningState {
  const stage = state.plan.stages.find((item) => item.id === stageId);
  if (!stage) throw new Error("学习阶段不存在");
  if ((state.plan.notes ?? []).some((note) => note.stageId === stageId)) throw new Error("这个阶段已经有学习笔记");
  const title = draft.title.trim();
  const content = draft.content.trim();
  if (!title || !content) throw new Error("笔记标题和内容不能为空");
  const note: StageLearningNote = {
    id: `note-${stage.id}`,
    stageId: stage.id,
    title,
    content,
    sourceDays: [],
    updatedAt: now.toISOString(),
  };
  return { ...state, plan: { ...state.plan, notes: [...(state.plan.notes ?? []), note] } };
}

export function appendStageNoteEvidence(state: LearningState, noteId: string, now = new Date()): LearningState {
  const note = (state.plan.notes ?? []).find((item) => item.id === noteId);
  if (!note) throw new Error("学习笔记不存在");
  const stage = state.plan.stages.find((item) => item.id === note.stageId);
  if (!stage) throw new Error("学习阶段不存在");
  const evidence = noteEvidenceForRecords(stageRecords(state, stage).filter((record) => !note.sourceDays.includes(record.day)));
  if (!evidence.content) throw new Error("当前没有可追加的新学习证据");
  return {
    ...state,
    plan: {
      ...state.plan,
      notes: (state.plan.notes ?? []).map((item) => item.id === noteId ? {
        ...item,
        content: `${item.content.trim()}\n\n新增学习证据\n${evidence.content}`,
        sourceDays: [...item.sourceDays, ...evidence.sourceDays].sort((a, b) => a - b),
        updatedAt: now.toISOString(),
      } : item),
    },
  };
}

export function updateStageNote(
  state: LearningState,
  noteId: string,
  changes: Pick<StageLearningNote, "title" | "content">,
  now = new Date(),
): LearningState {
  const title = changes.title.trim();
  const content = changes.content.trim();
  if (!title || !content) throw new Error("笔记标题和内容不能为空");
  if (!(state.plan.notes ?? []).some((note) => note.id === noteId)) throw new Error("学习笔记不存在");
  return {
    ...state,
    plan: {
      ...state.plan,
      notes: (state.plan.notes ?? []).map((note) => note.id === noteId ? { ...note, title, content, updatedAt: now.toISOString() } : note),
    },
  };
}

export function deleteStageNote(state: LearningState, noteId: string): LearningState {
  if (!(state.plan.notes ?? []).some((note) => note.id === noteId)) throw new Error("学习笔记不存在");
  return {
    ...state,
    plan: {
      ...state.plan,
      notes: (state.plan.notes ?? []).filter((note) => note.id !== noteId),
    },
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

export interface DueReviewItem {
  sourceDay: number;
  nextAction: string;
  misconceptions: string[];
}

export interface ScheduledReviewItem extends DueReviewItem {
  dueDay: number;
}

export function dueReviewItems(state: LearningState, targetDay = state.currentDay + 1): DueReviewItem[] {
  return state.days.flatMap((record) => {
    const evaluation = Object.values(record.artifacts)
      .flatMap((artifact) => artifact.evaluation ? [artifact.evaluation] : [])
      .filter((result) => result.masteryLevel !== "ready" || result.misconceptions.length > 0)
      .sort((a, b) => a.totalScore - b.totalScore)[0];
    if (!evaluation) return [];
    const attempts = state.days.flatMap((laterRecord) => Object.values(laterRecord.artifacts)
      .flatMap((artifact) => artifact.reviewPerformance?.sourceDays.includes(record.day)
        ? [{ day: laterRecord.day, recall: artifact.reviewPerformance.recall }]
        : [])).sort((a, b) => a.day - b.day);
    const lastAttempt = attempts.at(-1);
    let dueDay = record.day + 1;
    if (lastAttempt) {
      const previousNonEasyIndex = lastAttempt.recall === "easy"
        ? [...attempts].reverse().findIndex((attempt) => attempt.recall !== "easy")
        : 0;
      const consecutiveEasy = previousNonEasyIndex === -1 ? attempts.length : previousNonEasyIndex;
      const interval = lastAttempt.recall === "forgot"
        ? 1
        : lastAttempt.recall === "effortful"
          ? 3
          : Math.min(14, 7 * (2 ** Math.max(0, consecutiveEasy - 1)));
      dueDay = lastAttempt.day + interval;
    }
    if (targetDay !== dueDay) return [];
    return [{
      sourceDay: record.day,
      nextAction: evaluation.nextAction,
      misconceptions: evaluation.misconceptions,
    }];
  }).sort((a, b) => b.sourceDay - a.sourceDay);
}

export function scheduledReviewItems(state: LearningState, horizonDays = 14): ScheduledReviewItem[] {
  if (!Number.isInteger(horizonDays) || horizonDays < 0) throw new Error("复习预览天数必须是非负整数");
  const finalDay = Math.min(state.plan.goal.durationWeeks * 7, state.currentDay + horizonDays);
  const schedule: ScheduledReviewItem[] = [];
  for (let dueDay = state.currentDay; dueDay <= finalDay; dueDay += 1) {
    schedule.push(...dueReviewItems(state, dueDay).map((item) => ({ ...item, dueDay })));
  }
  return schedule;
}

export function saveReviewPerformance(state: LearningState, taskId: string, recall: ReviewRecall): LearningState {
  const record = getCurrentRecord(state);
  const task = record.tasks.find((item) => item.id === taskId);
  const sourceDays = dueReviewItems(state, state.currentDay).map((item) => item.sourceDay);
  if (!task || task.type !== "diagnose" || sourceDays.length === 0) throw new Error("当前任务不是待完成的间隔复习");
  return updateCurrentRecord(state, (current) => ({
    ...current,
    tasks: current.tasks.map((item) => item.id === taskId ? { ...item, completed: true } : item),
    artifacts: {
      ...current.artifacts,
      [taskId]: { ...current.artifacts[taskId], reviewPerformance: { sourceDays, recall } },
    },
  }));
}

export function saveReviewAssessment(state: LearningState, taskId: string, assessment: ReviewAssessment): LearningState {
  if (!assessment.answer.trim() || !Number.isInteger(assessment.score) || assessment.score < 0 || assessment.score > 4
    || !assessment.evidence.trim() || !assessment.feedback.trim()) throw new Error("复习判分结果无效");
  const expectedRecall: ReviewRecall = assessment.score <= 1 ? "forgot" : assessment.score <= 3 ? "effortful" : "easy";
  if (assessment.recall !== expectedRecall) throw new Error("复习分数与回忆表现不一致");
  const next = saveReviewPerformance(state, taskId, assessment.recall);
  return updateCurrentRecord(next, (record) => ({
    ...record,
    artifacts: {
      ...record.artifacts,
      [taskId]: {
        ...record.artifacts[taskId],
        reviewPerformance: { ...record.artifacts[taskId].reviewPerformance!, assessment: { ...assessment, answer: assessment.answer.trim() } },
      },
    },
  }));
}

function reviewPrompt(items: DueReviewItem[]): string {
  return items.map((item) => {
    const misconception = item.misconceptions.length > 0
      ? `先解释并纠正“${item.misconceptions.join("、")}”`
      : "先复述当时最薄弱的部分";
    return `第 ${item.sourceDay} 天：${misconception}，再说明如何完成“${item.nextAction}”`;
  }).join("；");
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
  const reviews = dueReviewItems(state, day);
  const retrievalPrompt = reviews.length > 0
    ? `${reviewPrompt(reviews)}。最后不查资料复述昨天最重要的结论，并回答：${feedback.reflection.trim() || "还有什么没有真正掌握？"}`
    : `不查资料，复述昨天最重要的结论，并回答：${feedback.reflection.trim() || "还有什么没有真正掌握？"}`;

  return [
    {
      id: `day-${day}-diagnose`, type: "diagnose", title: reviews.length > 0 ? "间隔复习与主动检索" : "检索昨天的关键知识",
      description: retrievalPrompt,
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
