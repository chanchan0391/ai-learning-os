import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  activeGoalOverview,
  activeGoalPortfolioOverview,
  archivedLearningStateExportFilename,
  crossGoalWeeklyReview,
  crossGoalWeeklyReviewMarkdownFilename,
  portfolioDailyAgenda,
  portfolioBudgetStatus,
  addCrossStageReviewTask,
  appendStageNoteEvidence,
  completeTeachingTask,
  completeCurrentDay,
  completedDayCount,
  crossStageMisconceptionInsights,
  crossStageReviewItems,
  crossStageReviewTaskId,
  createStageNote,
  deleteStageNote,
  detectLearningInterruption,
  dueReviewItems,
  generateStageRetrospective,
  generateStageNote,
  getCurrentRecord,
  goalMasteryReport,
  goalCompletionMarkdownFilename,
  initializeLearningState,
  isLearningPlanComplete,
  learningStateExportFilename,
  learningProgressMarkdownFilename,
  learningCalendarMonth,
  learningStreak,
  parsePortfolioLearningStateExport,
  parseLearningStateExport,
  portfolioLearningStateExportFilename,
  saveEvaluation,
  saveCrossStageReviewAssessment,
  saveReviewAssessment,
  saveTeachingSession,
  saveUnderstandingResponse,
  scheduledReviewItems,
  serializeLearningStateExport,
  serializePortfolioLearningStateExport,
  serializeGoalCompletionMarkdown,
  serializeCrossGoalWeeklyReviewMarkdown,
  serializeLearningProgressMarkdown,
  serializeStageNoteMarkdown,
  stageMasteryReport,
  stageMasteryTaskId,
  startStageMasteryFollowUp,
  stageNoteMarkdownFilename,
  toggleCurrentTask,
  updateStageNote,
  updateStageRetrospective,
  weeklyLearningReview,
  weeklyLearningTrend,
} from "./learning-state";
import { BrowserLearningStateRepository, type ArchivedLearningState } from "./learning-storage";
import { completionRate, validateGoal } from "./planner";
import { BrowserSyncClient, SyncConflictError, type ActiveDevice, type AuthState, type SyncConflictPreview } from "./sync-client";
import { AutoSyncQueue, type AutoSyncStatus } from "./sync-queue";
import type { LearningStateExport, PortfolioLearningStateExport } from "./learning-state";
import type { DailyTask, EvaluationResult, LearningGoal, LearningPlan, LearningState, RecoveryPlan, ReviewAssessment, StageLearningNote, StageRetrospective, TaskDifficulty, TeachingSession } from "./types";

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const learningStateRepository = new BrowserLearningStateRepository(localStorage);
const syncClient = new BrowserSyncClient(localStorage);

function shiftCalendarMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatCalendarDate(date: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00.000Z`));
}

function formatSyncStatus(status: AutoSyncStatus): string {
  if (status.phase === "offline") return "离线 · 更改已排队";
  if (status.phase === "pending") return "等待自动同步";
  if (status.phase === "syncing") return "正在同步";
  if (status.phase === "error") return "同步失败 · 将自动重试";
  if (status.phase === "blocked") return "同步冲突 · 需要选择";
  if (status.lastSyncedAt) {
    return `上次同步 ${new Date(status.lastSyncedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }
  return "自动同步已开启";
}

const INITIAL_GOAL: LearningGoal = {
  subject: "AI Agent 工程",
  currentLevel: "Java 高级工程师，了解基础 Python",
  targetOutcome: "独立设计并交付一个企业级 AI Agent 应用",
  dailyMinutes: 60,
  durationWeeks: 12,
};

function StageMasterySummary({
  report,
  canAddTask,
  taskAdded,
  startsFollowUpDay,
  onAddTask,
}: {
  report: ReturnType<typeof stageMasteryReport>;
  canAddTask: boolean;
  taskAdded: boolean;
  startsFollowUpDay: boolean;
  onAddTask: () => void;
}) {
  const statusLabel = report.status === "ready" ? "可以进入下一阶段" : report.status === "developing" ? "需要加强证据" : "证据不足";
  return (
    <div className={`stage-mastery ${report.status}`} role="status" aria-label="阶段掌握度">
      <div><strong>{statusLabel}</strong><span>{report.headline}</span></div>
      <ul>{report.dimensions.map((item) => <li className={item.status} key={item.dimension}>{item.label} {item.averageScore === null ? "—" : `${item.averageScore}/4`}</li>)}</ul>
      {report.latestRemediation && (
        <div className="mastery-comparison">
          <strong>补强后变化 · 来源第 {report.latestRemediation.sourceDay} 天</strong>
          <span>平均成果 {report.latestRemediation.averageTotalScoreBefore ?? "—"} → {report.latestRemediation.averageTotalScoreAfter ?? "—"}/16</span>
          <small>{report.latestRemediation.dimensionChanges.map((item) => `${item.label} ${item.before ?? "—"}→${item.after ?? "—"}`).join(" · ")}</small>
          <small>补强来源：{report.latestRemediation.sourceNextAction}</small>
        </div>
      )}
      <p><b>最小下一步</b>{report.nextAction}</p>
      {report.status !== "ready" && canAddTask && (
        <button className="secondary-action mastery-action" disabled={taskAdded} onClick={onAddTask}>
          {taskAdded ? "已加入今日任务" : startsFollowUpDay ? "开始补强学习日" : "加入今天的补强实践"}
        </button>
      )}
    </div>
  );
}

export function App() {
  const [initialLoad] = useState(() => learningStateRepository.load());
  const [learningState, setLearningState] = useState<LearningState | null>(initialLoad.state);
  const [activeGoals, setActiveGoals] = useState<LearningState[]>(() => learningStateRepository.loadActive());
  const [dailyBudgetMinutes, setDailyBudgetMinutes] = useState<number | null>(() => learningStateRepository.loadDailyBudget());
  const [dailyBudgetDraft, setDailyBudgetDraft] = useState(() => String(learningStateRepository.loadDailyBudget() ?? ""));
  const [archivedGoals, setArchivedGoals] = useState<ArchivedLearningState[]>(() => learningStateRepository.loadArchived());
  const [goal, setGoal] = useState<LearningGoal>(INITIAL_GOAL);
  const [errors, setErrors] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [difficulty, setDifficulty] = useState<TaskDifficulty | "">("");
  const [reflection, setReflection] = useState("");
  const [agentError, setAgentError] = useState("");
  const [busyTaskId, setBusyTaskId] = useState("");
  const [recoveryPlan, setRecoveryPlan] = useState<RecoveryPlan | null>(null);
  const [isGeneratingRecovery, setIsGeneratingRecovery] = useState(false);
  const [coachDismissed, setCoachDismissed] = useState(false);
  const [submissionDrafts, setSubmissionDrafts] = useState<Record<string, string>>({});
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, string>>({});
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [archiveConfirmationOpen, setArchiveConfirmationOpen] = useState(false);
  const [accountDeleteConfirmationOpen, setAccountDeleteConfirmationOpen] = useState(false);
  const [logoutAllConfirmationOpen, setLogoutAllConfirmationOpen] = useState(false);
  const [deviceDialogOpen, setDeviceDialogOpen] = useState(false);
  const [activeDevices, setActiveDevices] = useState<ActiveDevice[]>([]);
  const [busyDeviceId, setBusyDeviceId] = useState("");
  const [pendingImport, setPendingImport] = useState<
    { kind: "state"; data: LearningStateExport } | { kind: "portfolio"; data: PortfolioLearningStateExport } | null
  >(null);
  const [storageNotice, setStorageNotice] = useState(initialLoad.status === "recovered" ? "本地进度无法读取，已安全重置。" : "");
  const [storageNoticeIsError, setStorageNoticeIsError] = useState(initialLoad.status === "recovered");
  const [authState, setAuthState] = useState<AuthState>({ status: "checking" });
  const [isSyncing, setIsSyncing] = useState(false);
  const [autoSyncStatus, setAutoSyncStatus] = useState<AutoSyncStatus>({ phase: "idle" });
  const [pendingSyncConflict, setPendingSyncConflict] = useState<SyncConflictPreview | null>(null);
  const [noteQuery, setNoteQuery] = useState("");
  const [editingNoteId, setEditingNoteId] = useState("");
  const [creatingStageNote, setCreatingStageNote] = useState(false);
  const [pendingDeleteNote, setPendingDeleteNote] = useState<StageLearningNote | null>(null);
  const [noteDraft, setNoteDraft] = useState({ title: "", content: "" });
  const [editingRetrospectiveId, setEditingRetrospectiveId] = useState("");
  const [retrospectiveDraft, setRetrospectiveDraft] = useState<Pick<StageRetrospective, "goalReflection" | "representativeArtifact" | "transferableSkills" | "nextApplication">>({
    goalReflection: "", representativeArtifact: "", transferableSkills: "", nextApplication: "",
  });
  const initialCalendarDate = initialLoad.state?.days.at(-1)?.date ?? new Date().toISOString().slice(0, 10);
  const [calendarMonth, setCalendarMonth] = useState(initialCalendarDate.slice(0, 7));
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(initialCalendarDate);
  const importInput = useRef<HTMLInputElement>(null);
  const learningStateRef = useRef<LearningState | null>(initialLoad.state);
  const archivedGoalsRef = useRef<ArchivedLearningState[]>(learningStateRepository.loadArchived());
  const authStateRef = useRef<AuthState>({ status: "checking" });
  const performSyncRef = useRef<() => Promise<void>>(async () => undefined);
  const [autoSyncQueue] = useState(() => new AutoSyncQueue(
    localStorage,
    () => performSyncRef.current(),
    (status) => {
      setAutoSyncStatus(status);
      setIsSyncing(status.phase === "syncing");
    },
    { shouldRetry: (error) => !(error instanceof SyncConflictError) },
  ));
  const plan = learningState?.plan ?? null;
  const activePortfolio = useMemo(() => activeGoalPortfolioOverview(activeGoals), [activeGoals]);
  const portfolioWeeklyReview = useMemo(() => crossGoalWeeklyReview(activeGoals), [activeGoals]);
  const budgetStatus = useMemo(() => dailyBudgetMinutes === null ? null : portfolioBudgetStatus(activePortfolio, dailyBudgetMinutes), [activePortfolio, dailyBudgetMinutes]);
  const dailyAgenda = useMemo(() => portfolioDailyAgenda(activeGoals, dailyBudgetMinutes), [activeGoals, dailyBudgetMinutes]);
  const currentRecord = learningState ? getCurrentRecord(learningState) : null;
  const progress = useMemo(() => completionRate(currentRecord?.tasks ?? []), [currentRecord]);
  const interruption = useMemo(() => learningState ? detectLearningInterruption(learningState) : null, [learningState]);
  const reviewSchedule = useMemo(() => learningState ? scheduledReviewItems(learningState) : [], [learningState]);
  const repeatedMisconceptions = useMemo(() => learningState ? crossStageMisconceptionInsights(learningState) : [], [learningState]);
  const weeklyReview = useMemo(() => learningState ? weeklyLearningReview(learningState) : null, [learningState]);
  const weeklyTrend = useMemo(() => learningState ? weeklyLearningTrend(learningState) : null, [learningState]);
  const calendar = useMemo(() => learningState ? learningCalendarMonth(learningState, calendarMonth) : null, [calendarMonth, learningState]);
  const selectedCalendarDay = calendar?.weeks.flat().find((day) => day.date === selectedCalendarDate);
  const firstCalendarMonth = learningState?.days[0]?.date.slice(0, 7) ?? calendarMonth;
  const lastCalendarMonth = learningState?.days.at(-1)?.date.slice(0, 7) ?? calendarMonth;
  const currentStage = plan?.stages.find((stage) => {
    const week = Math.ceil((learningState?.currentDay ?? 1) / 7);
    return week >= stage.startWeek && week <= stage.endWeek;
  }) ?? plan?.stages.at(-1);
  const visibleNotes = useMemo(() => {
    const query = noteQuery.trim().toLocaleLowerCase("zh-CN");
    const notes = plan?.notes ?? [];
    if (!query) return notes;
    return notes.filter((note) => `${note.title}\n${note.content}`.toLocaleLowerCase("zh-CN").includes(query));
  }, [noteQuery, plan]);
  const retrospectiveStages = plan?.stages.filter((stage) =>
    learningState?.days.some((record) => record.day === stage.endWeek * 7 && record.status === "completed")
    || plan.retrospectives?.some((item) => item.stageId === stage.id)) ?? [];
  const goalMastery = useMemo(() => learningState ? goalMasteryReport(learningState) : null, [learningState]);

  useEffect(() => {
    let active = true;
    void syncClient.getAuthState().then((state) => {
      if (!active) return;
      authStateRef.current = state;
      setAuthState(state);
      if (state.status === "signed-in") {
        autoSyncQueue.start();
        autoSyncQueue.enqueue();
      }
    });
    return () => {
      active = false;
      autoSyncQueue.stop();
    };
  }, [autoSyncQueue]);

  useEffect(() => {
    const latestDate = learningState?.days.at(-1)?.date;
    if (!latestDate) return;
    setCalendarMonth(latestDate.slice(0, 7));
    setSelectedCalendarDate(latestDate);
  }, [learningState?.plan.id, learningState?.currentDay]);

  function saveState(next: LearningState | null, enqueueSync = true) {
    learningStateRef.current = next;
    setLearningState(next);
    if (next) learningStateRepository.save(next);
    else {
      learningStateRepository.clear();
      setDailyBudgetMinutes(null);
      setDailyBudgetDraft("");
    }
    setActiveGoals(learningStateRepository.loadActive());
    if (enqueueSync && next && authStateRef.current.status === "signed-in") autoSyncQueue.enqueue();
  }

  function updateState(update: (current: LearningState) => LearningState) {
    setLearningState((current) => {
      if (!current) return current;
      const next = update(current);
      learningStateRef.current = next;
      learningStateRepository.save(next);
      setActiveGoals(learningStateRepository.loadActive());
      if (authStateRef.current.status === "signed-in") autoSyncQueue.enqueue();
      return next;
    });
  }

  function resetGoalWorkspace(next: LearningState | null) {
    learningStateRef.current = next;
    setLearningState(next);
    setGoal(next?.plan.goal ?? INITIAL_GOAL);
    setSubmissionDrafts({});
    setReviewDrafts({});
    setDifficulty("");
    setReflection("");
    setAgentError("");
    setErrors([]);
  }

  function switchActiveGoal(planId: string) {
    try {
      const selected = learningStateRepository.selectActive(planId);
      resetGoalWorkspace(selected);
      setActiveGoals(learningStateRepository.loadActive());
      setStorageNotice(`已切换到“${selected.plan.goal.subject}”。`);
      setStorageNoticeIsError(false);
    } catch (error) {
      setStorageNotice(error instanceof Error ? error.message : "无法切换学习目标");
      setStorageNoticeIsError(true);
    }
  }

  function beginParallelGoal() {
    learningStateRepository.deselectActive();
    resetGoalWorkspace(null);
    setStorageNotice("现有目标已安全保留。创建后可在多个目标之间切换。");
    setStorageNoticeIsError(false);
  }

  function saveDailyBudget(event: FormEvent) {
    event.preventDefault();
    const minutes = Number(dailyBudgetDraft);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) {
      setStorageNotice("每日总时间预算请输入 15–1440 分钟的整数。");
      setStorageNoticeIsError(true);
      return;
    }
    learningStateRepository.saveDailyBudget(minutes);
    setDailyBudgetMinutes(minutes);
    setDailyBudgetDraft(String(minutes));
    setStorageNotice(`跨目标每日总时间预算已设为 ${minutes} 分钟。`);
    setStorageNoticeIsError(false);
  }

  function clearDailyBudget() {
    learningStateRepository.saveDailyBudget(null);
    setDailyBudgetMinutes(null);
    setDailyBudgetDraft("");
    setStorageNotice("已清除跨目标每日总时间预算。");
    setStorageNoticeIsError(false);
  }

  async function createPlan(event: FormEvent) {
    event.preventDefault();
    const nextErrors = validateGoal(goal);
    setErrors(nextErrors);
    if (nextErrors.length > 0) return;
    setIsGenerating(true);
    try {
      const response = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(goal),
      });
      const body = await response.json() as LearningPlan | { error: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "学习计划生成失败");
      saveState(initializeLearningState(body as LearningPlan));
      setStorageNotice("");
    } catch (error) {
      setErrors([error instanceof Error ? error.message : "学习计划生成失败"]);
    } finally {
      setIsGenerating(false);
    }
  }

  function toggleTask(taskId: string) {
    if (!learningState) return;
    saveState(toggleCurrentTask(learningState, taskId));
  }

  async function startTeaching(task: DailyTask) {
    if (!learningState) return;
    setBusyTaskId(task.id);
    setAgentError("");
    try {
      const recentErrors = learningState.days.flatMap((day) => Object.values(day.artifacts)
        .flatMap((artifact) => artifact.evaluation?.misconceptions ?? [])).slice(-3);
      const response = await fetch("/api/teaching-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: plan?.goal, task, learnerContext: { knownConcepts: [plan?.goal.currentLevel ?? ""], recentErrors } }),
      });
      const body = await response.json() as TeachingSession | { error: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "教学会话生成失败");
      updateState((current) => saveTeachingSession(current, task.id, body as TeachingSession));
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "教学会话生成失败");
    } finally {
      setBusyTaskId("");
    }
  }

  function updateUnderstanding(taskId: string, checkId: string, response: string) {
    if (learningState) updateState((current) => saveUnderstandingResponse(current, taskId, checkId, response));
  }

  function finishTeaching(taskId: string) {
    if (!learningState) return;
    try {
      saveState(completeTeachingTask(learningState, taskId));
      setAgentError("");
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "无法完成理解检查");
    }
  }

  async function assessReview(task: DailyTask) {
    if (!learningState || !plan) return;
    const answer = reviewDrafts[task.id] ?? "";
    if (!answer.trim()) return setAgentError("请先写下闭卷主动回忆答案");
    const linkedInsight = repeatedMisconceptions.find((item) => crossStageReviewTaskId(learningState.currentDay, item.misconception) === task.id);
    const items = linkedInsight ? crossStageReviewItems(linkedInsight) : dueReviewItems(learningState, learningState.currentDay);
    setBusyTaskId(task.id);
    setAgentError("");
    try {
      const response = await fetch("/api/review-assessments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: plan.goal, items, answer }),
      });
      const body = await response.json() as ReviewAssessment | { error: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "主动回忆判分失败");
      saveState(linkedInsight
        ? saveCrossStageReviewAssessment(learningState, task.id, linkedInsight.misconception, body as ReviewAssessment)
        : saveReviewAssessment(learningState, task.id, body as ReviewAssessment));
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "主动回忆判分失败");
    } finally {
      setBusyTaskId("");
    }
  }

  async function evaluatePractice(task: DailyTask) {
    if (!learningState || !plan) return;
    const submission = submissionDrafts[task.id] ?? currentRecord?.artifacts[task.id]?.submission ?? "";
    if (!submission.trim()) return setAgentError("请先提交可评估的学习成果");
    setBusyTaskId(task.id);
    setAgentError("");
    try {
      const response = await fetch("/api/evaluations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: plan.goal, task, submission }),
      });
      const body = await response.json() as EvaluationResult | { error: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "学习成果评估失败");
      updateState((current) => saveEvaluation(current, task.id, submission, body as EvaluationResult));
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "学习成果评估失败");
    } finally {
      setBusyTaskId("");
    }
  }

  async function createRecoveryPlan() {
    if (!learningState || !currentRecord || !interruption) return;
    const currentTask = currentRecord.tasks.find((task) => !task.completed) ?? currentRecord.tasks[0];
    setIsGeneratingRecovery(true);
    setAgentError("");
    try {
      const response = await fetch("/api/recovery-plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: learningState.plan.goal, currentTask, interruption }),
      });
      const body = await response.json() as RecoveryPlan | { error: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "恢复计划生成失败");
      setRecoveryPlan(body as RecoveryPlan);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "恢复计划生成失败");
    } finally {
      setIsGeneratingRecovery(false);
    }
  }

  function startNextDay() {
    if (!learningState || !difficulty) return;
    try {
      saveState(completeCurrentDay(learningState, { difficulty, reflection }));
      setDifficulty("");
      setReflection("");
      setErrors([]);
    } catch (error) {
      setErrors([error instanceof Error ? error.message : "无法完成今日学习"]);
    }
  }

  function createCurrentStageNote() {
    if (!currentStage) return;
    try {
      updateState((current) => generateStageNote(current, currentStage.id));
      setStorageNotice(`已生成“${currentStage.title}”阶段笔记，可继续编辑。`);
      setStorageNoticeIsError(false);
    } catch (error) {
      setStorageNotice(error instanceof Error ? error.message : "无法生成阶段笔记");
      setStorageNoticeIsError(true);
    }
  }

  function beginEditingNote(note: StageLearningNote) {
    setCreatingStageNote(false);
    setEditingNoteId(note.id);
    setNoteDraft({ title: note.title, content: note.content });
  }

  function beginCreatingStageNote() {
    if (!currentStage) return;
    setEditingNoteId("");
    setCreatingStageNote(true);
    setNoteDraft({ title: `${currentStage.title}学习笔记`, content: "" });
  }

  function saveNewStageNote() {
    if (!currentStage) return;
    try {
      updateState((current) => createStageNote(current, currentStage.id, noteDraft));
      setCreatingStageNote(false);
      setStorageNotice("阶段笔记已新建；后续可按需追加学习证据。");
      setStorageNoticeIsError(false);
    } catch (error) {
      setStorageNotice(error instanceof Error ? error.message : "无法新建阶段笔记");
      setStorageNoticeIsError(true);
    }
  }

  function appendNewEvidence(note: StageLearningNote) {
    try {
      updateState((current) => appendStageNoteEvidence(current, note.id));
      setStorageNotice("已追加新学习证据，原有笔记内容保持不变。");
      setStorageNoticeIsError(false);
    } catch (error) {
      setStorageNotice(error instanceof Error ? error.message : "无法追加学习证据");
      setStorageNoticeIsError(true);
    }
  }

  function saveNoteDraft() {
    try {
      updateState((current) => updateStageNote(current, editingNoteId, noteDraft));
      setEditingNoteId("");
      setStorageNotice("阶段笔记已保存。");
      setStorageNoticeIsError(false);
    } catch (error) {
      setStorageNotice(error instanceof Error ? error.message : "无法保存阶段笔记");
      setStorageNoticeIsError(true);
    }
  }

  function exportStageNote(note: StageLearningNote) {
    if (!plan) return;
    const now = new Date();
    const blob = new Blob([serializeStageNoteMarkdown(plan, note.id, now)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = stageNoteMarkdownFilename(note, now);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStorageNotice(`已导出“${note.title}”Markdown 笔记。`);
    setStorageNoticeIsError(false);
  }

  function confirmDeleteStageNote() {
    if (!pendingDeleteNote) return;
    const title = pendingDeleteNote.title;
    updateState((current) => deleteStageNote(current, pendingDeleteNote.id));
    if (editingNoteId === pendingDeleteNote.id) setEditingNoteId("");
    setPendingDeleteNote(null);
    setStorageNotice(`已删除“${title}”阶段笔记。`);
    setStorageNoticeIsError(false);
  }

  function createRetrospective(stageId: string) {
    try {
      updateState((current) => generateStageRetrospective(current, stageId));
      setStorageNotice("阶段结束回顾已生成；请检查并补充你真正想迁移到下一阶段的能力。");
      setStorageNoticeIsError(false);
    } catch (error) {
      setStorageNotice(error instanceof Error ? error.message : "无法生成阶段回顾");
      setStorageNoticeIsError(true);
    }
  }

  function beginEditingRetrospective(retrospective: StageRetrospective) {
    setEditingRetrospectiveId(retrospective.id);
    setRetrospectiveDraft({
      goalReflection: retrospective.goalReflection,
      representativeArtifact: retrospective.representativeArtifact,
      transferableSkills: retrospective.transferableSkills,
      nextApplication: retrospective.nextApplication,
    });
  }

  function saveRetrospectiveDraft() {
    try {
      updateState((current) => updateStageRetrospective(current, editingRetrospectiveId, retrospectiveDraft));
      setEditingRetrospectiveId("");
      setStorageNotice("阶段回顾已保存。");
      setStorageNoticeIsError(false);
    } catch (error) {
      setStorageNotice(error instanceof Error ? error.message : "无法保存阶段回顾");
      setStorageNoticeIsError(true);
    }
  }

  function exportLearningData() {
    if (!learningState) return;
    const now = new Date();
    const blob = new Blob([serializeLearningStateExport(learningState, now)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = learningStateExportFilename(now);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function exportAllLearningData() {
    const now = new Date();
    const blob = new Blob([serializePortfolioLearningStateExport(
      activeGoals,
      archivedGoals,
      learningState?.plan.id ?? null,
      dailyBudgetMinutes,
      now,
    )], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = portfolioLearningStateExportFilename(now);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStorageNotice(`已导出 ${activeGoals.length} 个进行中目标和 ${archivedGoals.length} 个归档目标。`);
    setStorageNoticeIsError(false);
  }

  function exportLearningProgress() {
    if (!learningState) return;
    const now = new Date();
    const blob = new Blob([serializeLearningProgressMarkdown(learningState, now)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = learningProgressMarkdownFilename(now);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStorageNotice("已导出学习周回顾与阶段进展摘要。");
    setStorageNoticeIsError(false);
  }

  function exportGoalCompletionReport() {
    if (!learningState) return;
    const now = new Date();
    const blob = new Blob([serializeGoalCompletionMarkdown(learningState, now)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = goalCompletionMarkdownFilename(learningState, now);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStorageNotice("已导出目标证据报告 Markdown。");
    setStorageNoticeIsError(false);
  }

  function exportArchivedLearningData(entry: ArchivedLearningState) {
    const now = new Date();
    const blob = new Blob([serializeLearningStateExport(entry.state, now)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = archivedLearningStateExportFilename(entry.state, now);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStorageNotice(`已导出“${entry.state.plan.goal.subject}”学习记录。`);
    setStorageNoticeIsError(false);
  }

  function exportArchivedGoalCompletionReport(entry: ArchivedLearningState) {
    const now = new Date();
    const blob = new Blob([serializeGoalCompletionMarkdown(entry.state, now)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = goalCompletionMarkdownFilename(entry.state, now);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStorageNotice(`已导出“${entry.state.plan.goal.subject}”目标证据报告。`);
    setStorageNoticeIsError(false);
  }

  function exportCrossGoalWeeklyReview() {
    const now = new Date();
    const blob = new Blob([serializeCrossGoalWeeklyReviewMarkdown(activeGoals, now)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = crossGoalWeeklyReviewMarkdownFilename(now);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStorageNotice("已导出跨目标周回顾 Markdown。");
    setStorageNoticeIsError(false);
  }

  function openAgendaTask(planId: string, taskId: string) {
    if (plan?.id !== planId) switchActiveGoal(planId);
    window.setTimeout(() => {
      const target = document.getElementById(`task-${taskId}`);
      if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  async function selectImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setStorageNotice("");
    if (file.size > MAX_IMPORT_BYTES) {
      setStorageNotice("学习记录文件不能超过 5 MB。");
      setStorageNoticeIsError(true);
      return;
    }
    try {
      const raw = await file.text();
      const portfolio = parsePortfolioLearningStateExport(raw);
      if (portfolio.status === "valid") {
        setPendingImport({ kind: "portfolio", data: portfolio.data });
        return;
      }
      const state = parseLearningStateExport(raw);
      if (state.status === "valid") {
        setPendingImport({ kind: "state", data: state.data });
        return;
      }
      setStorageNotice(state.error === "这不是 AI Learning OS 学习记录文件。" ? portfolio.error : state.error);
      setStorageNoticeIsError(true);
    } catch {
      setStorageNotice("无法读取所选学习记录文件。");
      setStorageNoticeIsError(true);
    }
  }

  function importLearningData() {
    if (!pendingImport) return;
    if (pendingImport.kind === "portfolio") {
      const data = pendingImport.data;
      learningStateRepository.replacePortfolio(
        data.activeStates, data.archivedStates, data.selectedPlanId, data.dailyBudgetMinutes,
      );
      const selected = data.activeStates.find((state) => state.plan.id === data.selectedPlanId) ?? null;
      resetGoalWorkspace(selected);
      setActiveGoals(learningStateRepository.loadActive());
      archivedGoalsRef.current = learningStateRepository.loadArchived();
      setArchivedGoals(archivedGoalsRef.current);
      setDailyBudgetMinutes(data.dailyBudgetMinutes);
      setDailyBudgetDraft(String(data.dailyBudgetMinutes ?? ""));
      setPendingImport(null);
      setStorageNotice(`已恢复全部学习数据：${data.activeStates.length} 个进行中目标，${data.archivedStates.length} 个归档目标。`);
      setStorageNoticeIsError(false);
      if (authStateRef.current.status === "signed-in") autoSyncQueue.enqueue();
      return;
    }
    saveState(pendingImport.data.state);
    setGoal(pendingImport.data.state.plan.goal);
    setSubmissionDrafts({});
    setDifficulty("");
    setReflection("");
    setAgentError("");
    setErrors([]);
    setPendingImport(null);
    setStorageNotice(`已恢复“${pendingImport.data.state.plan.goal.subject}”的第 ${pendingImport.data.state.currentDay} 天进度。`);
    setStorageNoticeIsError(false);
  }

  function deleteLearningData() {
    saveState(null, false);
    archivedGoalsRef.current = [];
    setArchivedGoals([]);
    syncClient.clearMetadata();
    autoSyncQueue.clear();
    if (authStateRef.current.status === "signed-in") autoSyncQueue.start();
    setSubmissionDrafts({});
    setAgentError("");
    setErrors([]);
    setDeleteConfirmationOpen(false);
  }

  function archiveCompletedGoal() {
    if (!learningState) return;
    try {
      const archived = learningStateRepository.archiveCompleted(learningState);
      learningStateRef.current = null;
      archivedGoalsRef.current = archived;
      const next = learningStateRepository.load().state;
      resetGoalWorkspace(next);
      setActiveGoals(learningStateRepository.loadActive());
      setArchivedGoals(archived);
      if (authStateRef.current.status === "signed-in") autoSyncQueue.enqueue();
      setArchiveConfirmationOpen(false);
      setStorageNotice(next
        ? `“${learningState.plan.goal.subject}”已归档，已切换到“${next.plan.goal.subject}”。`
        : `“${learningState.plan.goal.subject}”已归档，可以创建下一个学习目标。`);
      setStorageNoticeIsError(false);
    } catch (error) {
      setStorageNotice(error instanceof Error ? error.message : "无法归档学习目标");
      setStorageNoticeIsError(true);
    }
  }

  function restoreArchivedGoal(planId: string) {
    try {
      const restored = learningStateRepository.restoreArchived(planId);
      learningStateRef.current = restored;
      setLearningState(restored);
      setGoal(restored.plan.goal);
      setActiveGoals(learningStateRepository.loadActive());
      const archived = learningStateRepository.loadArchived();
      archivedGoalsRef.current = archived;
      setArchivedGoals(archived);
      if (authStateRef.current.status === "signed-in") {
        syncClient.markArchiveRestored(planId);
        autoSyncQueue.enqueue();
      }
      setStorageNotice(`已恢复“${restored.plan.goal.subject}”的完整学习记录。`);
      setStorageNoticeIsError(false);
    } catch (error) {
      setStorageNotice(error instanceof Error ? error.message : "无法恢复已归档目标");
      setStorageNoticeIsError(true);
    }
  }

  async function performSync() {
    setStorageNotice("");
    try {
      let archivedUploaded = 0;
      let archivedDownloaded = 0;
      for (const entry of archivedGoalsRef.current) {
        const archivedResult = await syncClient.syncArchived(entry);
        archivedUploaded += archivedResult.uploaded;
        archivedDownloaded += archivedResult.downloaded;
      }
      const selectedPlanId = learningStateRef.current?.plan.id;
      const localActive = learningStateRepository.loadActive();
      localActive.sort((left, right) => left.plan.id === selectedPlanId ? -1 : right.plan.id === selectedPlanId ? 1 : 0);
      const result = await syncClient.syncActive(localActive);
      const syncedActive = learningStateRepository.replaceActive(result.states);
      setActiveGoals(syncedActive);
      const selected = selectedPlanId
        ? syncedActive.find((state) => state.plan.id === selectedPlanId)
        : localActive.length === 0 && syncedActive[0]
          ? learningStateRepository.selectActive(syncedActive[0].plan.id)
          : null;
      if (selected) {
        learningStateRef.current = selected;
        setLearningState(selected);
        setGoal(selected.plan.goal);
      }
      const remoteArchives = await syncClient.downloadArchived(
        [
          ...archivedGoalsRef.current.map((entry) => entry.state.plan.id),
          ...result.states.map((state) => state.plan.id),
        ],
      );
      if (remoteArchives.entries.length > 0) {
        const merged = learningStateRepository.mergeArchived(remoteArchives.entries);
        archivedGoalsRef.current = merged;
        setArchivedGoals(merged);
      }
      const changes = [
        result.uploaded + archivedUploaded > 0 ? `上传 ${result.uploaded + archivedUploaded} 项` : "",
        result.downloaded + archivedDownloaded + remoteArchives.downloaded > 0 ? `下载 ${result.downloaded + archivedDownloaded + remoteArchives.downloaded} 项` : "",
      ].filter(Boolean).join("，");
      setStorageNotice(changes ? `同步完成：${changes}。` : "本地与云端进度已一致。");
      setStorageNoticeIsError(false);
    } catch (error) {
      if (error instanceof SyncConflictError && error.preview) setPendingSyncConflict(error.preview);
      setStorageNotice(error instanceof Error ? error.message : "同步失败，请稍后重试。");
      setStorageNoticeIsError(true);
      throw error;
    }
  }

  performSyncRef.current = performSync;

  async function syncLearningData() {
    await autoSyncQueue.flushNow();
  }

  async function resolveSyncConflict(choice: "local" | "remote") {
    if (!pendingSyncConflict) return;
    setIsSyncing(true);
    setStorageNotice("");
    try {
      const result = await syncClient.resolveConflict(pendingSyncConflict, choice);
      if (result.state) {
        const currentPlanId = learningStateRef.current?.plan.id;
        const states = learningStateRepository.loadActive();
        const merged = [result.state, ...states.filter((state) => state.plan.id !== result.state?.plan.id)];
        learningStateRepository.replaceActive(merged);
        setActiveGoals(learningStateRepository.loadActive());
        if (result.state.plan.id === currentPlanId) {
          learningStateRef.current = result.state;
          setLearningState(result.state);
          setGoal(result.state.plan.goal);
        }
      }
      autoSyncQueue.completeExternalSync();
      setPendingSyncConflict(null);
      setStorageNotice(`已保留${choice === "local" ? "本地" : "云端"}冲突版本，并完成同步。`);
      setStorageNoticeIsError(false);
    } catch (error) {
      if (error instanceof SyncConflictError && error.preview) setPendingSyncConflict(error.preview);
      setStorageNotice(error instanceof Error ? error.message : "冲突处理失败，请重新同步。");
      setStorageNoticeIsError(true);
    } finally {
      setIsSyncing(false);
    }
  }

  async function logout() {
    try {
      await syncClient.logout();
      syncClient.clearMetadata();
      autoSyncQueue.clear();
      authStateRef.current = { status: "signed-out" };
      setAuthState(authStateRef.current);
      setStorageNotice("已退出账号，本地学习记录仍保留在此浏览器中。");
      setStorageNoticeIsError(false);
    } catch (error) {
      setStorageNotice(error instanceof Error ? error.message : "退出登录失败");
      setStorageNoticeIsError(true);
    }
  }

  async function logoutAll() {
    setIsSyncing(true);
    try {
      await syncClient.logoutAll();
      syncClient.clearMetadata();
      autoSyncQueue.clear();
      authStateRef.current = { status: "signed-out" };
      setAuthState(authStateRef.current);
      setLogoutAllConfirmationOpen(false);
      setStorageNotice("已退出所有设备，本地学习记录仍保留在此浏览器中。");
      setStorageNoticeIsError(false);
    } catch (error) {
      setStorageNotice(error instanceof Error ? error.message : "退出所有设备失败，请稍后重试");
      setStorageNoticeIsError(true);
    } finally {
      setIsSyncing(false);
    }
  }

  async function openDeviceManager() {
    setDeviceDialogOpen(true);
    setBusyDeviceId("loading");
    try {
      setActiveDevices(await syncClient.getActiveDevices());
    } catch (error) {
      setStorageNotice(error instanceof Error ? error.message : "无法读取登录设备");
      setStorageNoticeIsError(true);
      setDeviceDialogOpen(false);
    } finally {
      setBusyDeviceId("");
    }
  }

  async function revokeDevice(device: ActiveDevice) {
    setBusyDeviceId(device.id);
    try {
      await syncClient.revokeDevice(device.id);
      setActiveDevices((devices) => devices.filter((item) => item.id !== device.id));
      setStorageNotice(`已退出设备“${device.label}”。`);
      setStorageNoticeIsError(false);
    } catch (error) {
      setStorageNotice(error instanceof Error ? error.message : "设备退出失败，请稍后重试");
      setStorageNoticeIsError(true);
    } finally {
      setBusyDeviceId("");
    }
  }

  async function deleteAccountData() {
    setIsSyncing(true);
    try {
      await syncClient.deleteAccount();
      autoSyncQueue.stop();
      saveState(null, false);
      setArchivedGoals([]);
      syncClient.clearMetadata();
      autoSyncQueue.clear();
      authStateRef.current = { status: "signed-out" };
      setAuthState(authStateRef.current);
      setSubmissionDrafts({});
      setPendingSyncConflict(null);
      setAccountDeleteConfirmationOpen(false);
      setStorageNotice("账号、云端学习记录和当前浏览器中的学习记录已删除。");
      setStorageNoticeIsError(false);
    } catch (error) {
      setStorageNotice(error instanceof Error ? error.message : "账号数据删除失败，请稍后重试");
      setStorageNoticeIsError(true);
    } finally {
      setIsSyncing(false);
    }
  }

  const importControl = (
    <>
      <input ref={importInput} className="visually-hidden" type="file" accept="application/json,.json" aria-label="选择学习记录文件" onChange={selectImportFile} />
      <button className="text-button" disabled={activeGoals.length + archivedGoals.length === 0} onClick={exportAllLearningData}>导出全部数据</button>
      <button className="text-button" onClick={() => importInput.current?.click()}>导入学习记录</button>
    </>
  );

  const portfolioBudgetControl = (
    <div className={`portfolio-budget ${budgetStatus?.status ?? "unset"}`}>
      <form onSubmit={saveDailyBudget}>
        <label>每日总时间预算
          <span className="input-unit"><input aria-label="跨目标每日总时间预算" type="number" min="15" max="1440" step="5" placeholder="例如 90" value={dailyBudgetDraft} onChange={(event) => setDailyBudgetDraft(event.target.value)} /><span>分钟</span></span>
        </label>
        <button className="secondary-action" type="submit">保存预算</button>
        {dailyBudgetMinutes !== null && <button className="text-button" type="button" onClick={clearDailyBudget}>清除</button>}
      </form>
      {budgetStatus ? (
        <p role="status">{budgetStatus.status === "over-budget"
          ? `今日计划 ${budgetStatus.scheduledMinutes} 分钟，超出预算 ${budgetStatus.overloadedBy} 分钟。优先保留需关注目标和最小学习闭环。`
          : `今日计划 ${budgetStatus.scheduledMinutes} 分钟，预算内还可安排 ${budgetStatus.availableMinutes} 分钟。`}</p>
      ) : <p>设置所有进行中目标共享的每日上限，系统会按完整计划工作量提示超载。</p>}
    </div>
  );

  const portfolioWeeklyReviewPanel = activeGoals.length > 1 && (
    <div className="portfolio-weekly-review" role="region" aria-label="跨目标周回顾">
      <div className="portfolio-review-heading">
        <div><strong>跨目标周回顾</strong><span>{portfolioWeeklyReview.windowStart} 至 {portfolioWeeklyReview.windowEnd}</span></div>
        <div className="portfolio-review-summary"><p>{portfolioWeeklyReview.headline} 共投入 {portfolioWeeklyReview.totalMinutes} 分钟，完成 {portfolioWeeklyReview.completedDays} 个学习日。</p><button className="text-button" type="button" onClick={exportCrossGoalWeeklyReview}>导出跨目标周回顾</button></div>
      </div>
      <div className="portfolio-review-goals">
        {portfolioWeeklyReview.goals.map((item) => (
          <article className={item.planId === portfolioWeeklyReview.focusPlanId ? "focus" : ""} key={item.planId}>
            <div><strong>{item.subject}</strong><span>{item.totalMinutes} 分钟 · 占本周 {item.allocationPercent}% · {item.completedDays} 个完成日</span></div>
            <ul aria-label={`${item.subject}周度变化`}>
              <li>成果 {item.averageEvaluationScore === null ? "暂无评分" : `${item.averageEvaluationScore}/16${item.evaluationScoreDelta === null ? " · 基线" : ` · ${item.evaluationScoreDelta >= 0 ? "+" : ""}${item.evaluationScoreDelta}`}`}</li>
              <li className={`risk-${item.riskTrend}`}>风险 {item.difficultDaysDelta === null ? `${item.difficultDays} 个偏难日 · 基线` : `${item.difficultDaysDelta >= 0 ? "+" : ""}${item.difficultDaysDelta} 个偏难日`} · {item.currentRiskLabel}</li>
            </ul>
          </article>
        ))}
      </div>
      <div className="portfolio-review-focus"><p><strong>本周优先项</strong>{portfolioWeeklyReview.focusReason}</p>{portfolioWeeklyReview.focusPlanId && portfolioWeeklyReview.focusPlanId !== plan?.id && <button className="text-button" type="button" onClick={() => switchActiveGoal(portfolioWeeklyReview.focusPlanId!)}>打开本周优先目标</button>}</div>
    </div>
  );

  const portfolioDailyAgendaPanel = activeGoals.length > 1 && (
    <section className="portfolio-daily-agenda" aria-labelledby="portfolio-daily-agenda-title">
      <div>
        <strong id="portfolio-daily-agenda-title">今日跨目标清单</strong>
        <span>{dailyAgenda.budgetMinutes === null ? "尚未设置预算，展示全部剩余任务" : `按 ${dailyAgenda.budgetMinutes} 分钟预算安排`}</span>
      </div>
      <p>{dailyAgenda.plannedMinutes} 分钟已安排{dailyAgenda.deferredMinutes > 0 ? ` · ${dailyAgenda.deferredMinutes} 分钟留待后续` : " · 已覆盖全部剩余任务"}</p>
      {dailyAgenda.items.length > 0 ? (
        <ol>
          {dailyAgenda.items.map((item) => (
            <li key={`${item.planId}-${item.taskId}`}>
              <div><small>{item.subject} · {item.minutes} 分钟</small><strong>{item.title}</strong></div>
              <button className="text-button" type="button" onClick={() => openAgendaTask(item.planId, item.taskId)}>{item.planId === plan?.id ? "定位任务" : "打开任务"}</button>
            </li>
          ))}
        </ol>
      ) : <p>当前预算不足以容纳任一完整任务；请增加预算或直接打开一个目标完成最小步骤。</p>}
    </section>
  );

  const accountControls = authState.status === "signed-in" ? (
    <div className="account-controls" aria-label="账号与同步">
      <span className="sync-status">已登录</span>
      <span className={`sync-detail sync-${autoSyncStatus.phase}`}>{formatSyncStatus(autoSyncStatus)}</span>
      <button className="text-button sync-button" disabled={isSyncing} onClick={syncLearningData}>{isSyncing ? "正在同步…" : "立即同步"}</button>
      <button className="text-button" disabled={isSyncing} onClick={openDeviceManager}>管理设备</button>
      <button className="text-button" onClick={logout}>退出</button>
      <button className="text-button danger-text" disabled={isSyncing} onClick={() => setLogoutAllConfirmationOpen(true)}>退出所有设备</button>
      <button className="text-button danger-text" disabled={isSyncing} onClick={() => setAccountDeleteConfirmationOpen(true)}>删除账号</button>
    </div>
  ) : authState.status === "signed-out" ? (
    <a className="text-button account-link" href={`/api/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`}>登录并同步</a>
  ) : authState.status === "local-only" ? (
    <span className="sync-status">仅本地</span>
  ) : null;

  const importDialog = pendingImport && (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setPendingImport(null);
    }}>
      <section className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="import-dialog-title" aria-describedby="import-dialog-description">
        <p className="eyebrow">已验证学习记录</p>
        <h2 id="import-dialog-title">{pendingImport.kind === "portfolio"
          ? "恢复全部学习数据？"
          : `恢复“${pendingImport.data.state.plan.goal.subject}”？`}</h2>
        <p id="import-dialog-description">{pendingImport.kind === "portfolio"
          ? `将用文件中的 ${pendingImport.data.activeStates.length} 个进行中目标、${pendingImport.data.archivedStates.length} 个归档目标和时间预算替换当前浏览器的全部学习数据。导出时间：${new Date(pendingImport.data.exportedAt).toLocaleString("zh-CN")}。`
          : `将恢复到第 ${pendingImport.data.state.currentDay} 天；同一目标的本地版本会被替换，其他进行中目标会保留。导出时间：${new Date(pendingImport.data.exportedAt).toLocaleString("zh-CN")}。`}</p>
        <div className="dialog-actions">
          <button className="secondary-action" autoFocus onClick={() => setPendingImport(null)}>取消</button>
          <button className="primary-dialog-action" onClick={importLearningData}>确认恢复</button>
        </div>
      </section>
    </div>
  );

  const conflictDialog = pendingSyncConflict && (
    <div className="dialog-backdrop" role="presentation">
      <section className="confirmation-dialog conflict-dialog" role="alertdialog" aria-modal="true" aria-labelledby="conflict-dialog-title" aria-describedby="conflict-dialog-description">
        <p className="eyebrow">同步冲突 · 需要选择</p>
        <h2 id="conflict-dialog-title">比较本地与云端进度</h2>
        <p id="conflict-dialog-description">
          {pendingSyncConflict.kind === "different-plan" ? "两端是不同的学习计划。" : `两端都修改了${pendingSyncConflict.entityType === "learning-plan" ? "学习计划" : "同一天的学习记录"}。`}
          选择后将覆盖这一冲突版本；建议先导出本地记录留作备份。
        </p>
        <div className="conflict-versions">
          {(["local", "remote"] as const).map((source) => {
            const state = source === "local" ? pendingSyncConflict.localState : pendingSyncConflict.remoteState;
            return (
              <article key={source}>
                <span>{source === "local" ? "当前浏览器" : "云端版本"}</span>
                <strong>{state.plan.goal.subject}</strong>
                <small>第 {state.currentDay} 天 · 已完成 {completedDayCount(state)} 天</small>
                {source === "remote" && pendingSyncConflict.remoteUpdatedAt && <small>云端更新：{new Date(pendingSyncConflict.remoteUpdatedAt).toLocaleString("zh-CN")}</small>}
                <button className={source === "local" ? "secondary-action" : "primary-dialog-action"} disabled={isSyncing} onClick={() => resolveSyncConflict(source)}>
                  {source === "local" ? "保留本地版本" : "使用云端版本"}
                </button>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );

  const noteDeleteDialog = pendingDeleteNote && (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setPendingDeleteNote(null);
    }}>
      <section className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="note-delete-dialog-title" aria-describedby="note-delete-dialog-description">
        <p className="eyebrow">删除阶段笔记</p>
        <h2 id="note-delete-dialog-title">删除“{pendingDeleteNote.title}”？</h2>
        <p id="note-delete-dialog-description">这只会删除这份阶段笔记，不会删除学习计划、任务历史或原始学习证据。删除后可重新新建或从证据生成。</p>
        <div className="dialog-actions">
          <button className="secondary-action" autoFocus onClick={() => setPendingDeleteNote(null)}>取消</button>
          <button className="danger-action" onClick={confirmDeleteStageNote}>确认删除笔记</button>
        </div>
      </section>
    </div>
  );

  const accountDeleteDialog = accountDeleteConfirmationOpen && (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !isSyncing) setAccountDeleteConfirmationOpen(false);
    }}>
      <section className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="account-delete-dialog-title" aria-describedby="account-delete-dialog-description">
        <p className="eyebrow">账号与云端数据 · 不可撤销</p>
        <h2 id="account-delete-dialog-title">永久删除账号和全部学习数据？</h2>
        <p id="account-delete-dialog-description">这会删除所有设备上的云端计划、每日记录、教学回答、成果、评估、设备和登录身份，并清除当前浏览器数据。需要保留副本时，请先取消并导出学习记录。</p>
        <div className="dialog-actions">
          <button className="secondary-action" autoFocus disabled={isSyncing} onClick={() => setAccountDeleteConfirmationOpen(false)}>取消</button>
          <button className="danger-action" disabled={isSyncing} onClick={deleteAccountData}>{isSyncing ? "正在删除…" : "永久删除账号"}</button>
        </div>
      </section>
    </div>
  );

  const logoutAllDialog = logoutAllConfirmationOpen && (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !isSyncing) setLogoutAllConfirmationOpen(false);
    }}>
      <section className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="logout-all-dialog-title" aria-describedby="logout-all-dialog-description">
        <p className="eyebrow">账号安全 · 所有设备</p>
        <h2 id="logout-all-dialog-title">退出所有设备？</h2>
        <p id="logout-all-dialog-description">所有浏览器和设备上的登录会话会立即失效。云端与当前浏览器中的学习记录不会被删除；需要同步时可以重新登录。</p>
        <div className="dialog-actions">
          <button className="secondary-action" autoFocus disabled={isSyncing} onClick={() => setLogoutAllConfirmationOpen(false)}>取消</button>
          <button className="danger-action" disabled={isSyncing} onClick={logoutAll}>{isSyncing ? "正在退出…" : "确认退出所有设备"}</button>
        </div>
      </section>
    </div>
  );

  const deviceDialog = deviceDialogOpen && (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busyDeviceId) setDeviceDialogOpen(false);
    }}>
      <section className="confirmation-dialog device-dialog" role="dialog" aria-modal="true" aria-labelledby="device-dialog-title" aria-describedby="device-dialog-description">
        <p className="eyebrow">账号安全 · 登录设备</p>
        <h2 id="device-dialog-title">管理登录设备</h2>
        <p id="device-dialog-description">退出不再使用的设备会立即撤销它的登录会话，不会删除任何学习记录。</p>
        <div className="device-list">
          {busyDeviceId === "loading" ? <p role="status">正在读取设备…</p> : activeDevices.map((device) => (
            <article key={device.id}>
              <div>
                <strong>{device.label}</strong>
                <small>{device.current ? "当前设备" : `最近活动 ${new Date(device.lastSeenAt).toLocaleString("zh-CN")}`}</small>
              </div>
              {device.current ? <span>当前设备</span> : (
                <button className="danger-text device-revoke" disabled={Boolean(busyDeviceId)} onClick={() => revokeDevice(device)}>
                  {busyDeviceId === device.id ? "正在退出…" : "退出此设备"}
                </button>
              )}
            </article>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="secondary-action" autoFocus disabled={Boolean(busyDeviceId)} onClick={() => setDeviceDialogOpen(false)}>完成</button>
        </div>
      </section>
    </div>
  );

  const archivedGoalsPanel = archivedGoals.length > 0 && (
    <section className="panel archived-goals" aria-labelledby="archived-goals-title">
      <div><p className="eyebrow">本地学习档案</p><h2 id="archived-goals-title">已完成目标</h2></div>
      <div className="archived-goal-list">
        {archivedGoals.map((entry) => (
          <article key={entry.state.plan.id}>
            <div><strong>{entry.state.plan.goal.subject}</strong><span>{entry.state.plan.goal.targetOutcome}</span><small>{entry.state.days.length} 个完成日 · 归档于 {new Date(entry.archivedAt).toLocaleDateString("zh-CN")}</small></div>
            <div className="archived-goal-actions">
              <button className="text-button" onClick={() => exportArchivedLearningData(entry)}>导出学习记录</button>
              <button className="text-button" onClick={() => exportArchivedGoalCompletionReport(entry)}>导出证据报告</button>
              <button className="secondary-action" onClick={() => restoreArchivedGoal(entry.state.plan.id)}>恢复查看</button>
            </div>
          </article>
        ))}
      </div>
      <p className="archive-boundary">可直接导出归档备份与目标证据；登录账号后，归档会安全同步到其他设备，恢复归档会把它重新设为当前目标。</p>
    </section>
  );

  if (!plan || !learningState || !currentRecord) {
    return (
      <main className="shell onboarding">
        <header className="topbar"><div className="brand"><span className="brand-mark">A</span> AI Learning OS <span className="beta">PROTOTYPE</span></div><div className="data-actions">{accountControls}{importControl}</div></header>
        {storageNotice && <div className="storage-notice" role={storageNoticeIsError ? "alert" : "status"}>{storageNotice}</div>}
        {importDialog}
        {conflictDialog}
        {logoutAllDialog}
        {deviceDialog}
        {accountDeleteDialog}
        <section className="hero">
          <div>
            <p className="eyebrow">你的目标，不再停在愿望里</p>
            <h1>把想学的事，变成<br /><em>今天能完成的行动。</em></h1>
            <p className="lede">告诉我们起点、终点和可投入的时间。Planner Agent 会生成路线，并从第一天开始陪你完成闭环。</p>
            <div className="loop"><span>学习</span><i>→</i><span>实践</span><i>→</i><span>反馈</span><i>→</i><span>掌握</span></div>
          </div>
          <form className="goal-card" onSubmit={createPlan}>
            <div className="card-heading"><span>01</span><div><strong>创建学习目标</strong><small>约 2 分钟</small></div></div>
            <label>我想学习<input value={goal.subject} onChange={(event) => setGoal({ ...goal, subject: event.target.value })} /></label>
            <label>我现在的基础<textarea rows={2} value={goal.currentLevel} onChange={(event) => setGoal({ ...goal, currentLevel: event.target.value })} /></label>
            <label>我希望最终能够<textarea rows={2} value={goal.targetOutcome} onChange={(event) => setGoal({ ...goal, targetOutcome: event.target.value })} /></label>
            <div className="field-row">
              <label>每天投入<div className="input-unit"><input type="number" min="15" max="240" value={goal.dailyMinutes} onChange={(event) => setGoal({ ...goal, dailyMinutes: Number(event.target.value) })} /><span>分钟</span></div></label>
              <label>学习周期<div className="input-unit"><input type="number" min="1" max="52" value={goal.durationWeeks} onChange={(event) => setGoal({ ...goal, durationWeeks: Number(event.target.value) })} /><span>周</span></div></label>
            </div>
            {errors.length > 0 && <div className="errors">{errors.join(" · ")}</div>}
            <button type="submit" disabled={isGenerating}>{isGenerating ? "Planner Agent 正在规划…" : "生成我的学习路线"} <span>→</span></button>
            <p className="privacy">进度保存在当前浏览器；启用实时模型后，学习内容会发送给所选模型服务</p>
          </form>
        </section>
        {activeGoals.length > 0 && (
          <section className="panel active-goals" aria-labelledby="active-goals-title">
            <div>
              <p className="eyebrow">并行学习</p><h2 id="active-goals-title">进行中的目标</h2>
              <p className="goal-portfolio-summary">{activePortfolio.activeGoals} 个目标 · 今日 {activePortfolio.completedTasks}/{activePortfolio.totalTasks} 项 · 剩余 {activePortfolio.remainingMinutes} 分钟 · {activePortfolio.goalsNeedingAttention} 个需关注</p>
            </div>
            {portfolioBudgetControl}
            {portfolioDailyAgendaPanel}
            {portfolioWeeklyReviewPanel}
            <div className="active-goal-list">
              {activeGoals.map((state) => {
                const overview = activeGoalOverview(state);
                return <article key={state.plan.id}>
                  <div>
                    <strong>{state.plan.goal.subject}</strong>
                    <span>{state.plan.goal.targetOutcome}</span>
                    <div className="goal-overview" aria-label={`${state.plan.goal.subject}目标摘要`}>
                      <small><b>今日</b>{overview.completedTasks}/{overview.totalTasks} 项 · 剩余 {overview.remainingMinutes} 分钟</small>
                      <small className={`goal-risk ${overview.riskLevel}`}><b>风险</b>{overview.riskLabel}</small>
                      <small><b>进展</b>{overview.recentProgress}</small>
                    </div>
                  </div>
                  <button className="secondary-action" onClick={() => switchActiveGoal(state.plan.id)}>打开目标</button>
                </article>;
              })}
            </div>
          </section>
        )}
        {archivedGoalsPanel}
      </main>
    );
  }

  return (
    <main className="shell dashboard">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">A</span> AI Learning OS</div>
        <div className="data-actions" aria-label="学习数据控制">
          {accountControls}
          {importControl}
          <button className="text-button" onClick={exportLearningData}>导出学习记录</button>
          {isLearningPlanComplete(learningState) && (
            <button className="text-button" onClick={() => setArchiveConfirmationOpen(true)}>归档已完成目标</button>
          )}
          <button className="text-button danger-text" onClick={() => setDeleteConfirmationOpen(true)}>删除本地数据</button>
        </div>
      </header>
      {storageNotice && <div className="storage-notice dashboard-notice" role={storageNoticeIsError ? "alert" : "status"}>{storageNotice}</div>}
      {importDialog}
      {conflictDialog}
      {noteDeleteDialog}
      {logoutAllDialog}
      {deviceDialog}
      {accountDeleteDialog}
      {archiveConfirmationOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setArchiveConfirmationOpen(false);
        }}>
          <section className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="archive-dialog-title" aria-describedby="archive-dialog-description">
            <p className="eyebrow">完成目标 · 保留全部证据</p>
            <h2 id="archive-dialog-title">归档“{plan.goal.subject}”？</h2>
            <p id="archive-dialog-description">完整计划、每日记录、成果和评估会保存在归档中；登录账号时也会同步到其他设备。归档后可立即创建新目标，也可以稍后恢复查看。</p>
            <div className="dialog-actions">
              <button className="secondary-action" autoFocus onClick={() => setArchiveConfirmationOpen(false)}>取消</button>
              <button className="primary-dialog-action" onClick={archiveCompletedGoal}>确认归档</button>
            </div>
          </section>
        </div>
      )}
      {deleteConfirmationOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setDeleteConfirmationOpen(false);
        }}>
          <section className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-description">
            <p className="eyebrow">不可撤销操作</p>
            <h2 id="delete-dialog-title">删除当前浏览器中的学习数据？</h2>
            <p id="delete-dialog-description">全部进行中计划、已归档目标、任务历史、教学回答、成果和评估都会被永久删除。需要保留副本时，请先逐个导出学习记录。</p>
            <div className="dialog-actions">
              <button className="secondary-action" autoFocus onClick={() => setDeleteConfirmationOpen(false)}>取消</button>
              <button className="danger-action" onClick={deleteLearningData}>确认删除</button>
            </div>
          </section>
        </div>
      )}
      <section className="panel active-goals dashboard-goals" aria-labelledby="dashboard-goals-title">
        <div className="active-goals-heading">
          <div>
            <p className="eyebrow">并行学习</p><h2 id="dashboard-goals-title">进行中的目标</h2>
            <p className="goal-portfolio-summary">{activePortfolio.activeGoals} 个目标 · 今日 {activePortfolio.completedTasks}/{activePortfolio.totalTasks} 项 · 剩余 {activePortfolio.remainingMinutes} 分钟 · {activePortfolio.goalsNeedingAttention} 个需关注</p>
          </div>
          <button className="secondary-action" onClick={beginParallelGoal}>新建并行目标</button>
        </div>
        {portfolioBudgetControl}
        {portfolioDailyAgendaPanel}
        {portfolioWeeklyReviewPanel}
        <div className="active-goal-list">
          {activeGoals.map((state) => {
            const overview = activeGoalOverview(state);
            return <article className={state.plan.id === plan.id ? "selected" : ""} key={state.plan.id}>
              <div>
                <strong>{state.plan.goal.subject}</strong>
                <span>{state.plan.goal.targetOutcome}</span>
                <div className="goal-overview" aria-label={`${state.plan.goal.subject}目标摘要`}>
                  <small><b>今日</b>{overview.completedTasks}/{overview.totalTasks} 项 · 剩余 {overview.remainingMinutes} 分钟</small>
                  <small className={`goal-risk ${overview.riskLevel}`}><b>风险</b>{overview.riskLabel}</small>
                  <small><b>进展</b>{overview.recentProgress}</small>
                </div>
              </div>
              {state.plan.id === plan.id
                ? <span className="current-goal-label">当前目标</span>
                : <button className="secondary-action" onClick={() => switchActiveGoal(state.plan.id)}>切换</button>}
            </article>;
          })}
        </div>
        {authState.status === "signed-in" && activeGoals.length > 1 && <p className="archive-boundary">全部进行中目标都会自动同步；切换目标不会中断其他目标的云端更新。</p>}
      </section>
      {archivedGoalsPanel}
      <section className="welcome">
        <div><p className="eyebrow">DAY {learningState.currentDay} · 持续推进你的学习系统</p><h1>{plan.goal.subject}</h1><p>目标：{plan.goal.targetOutcome}</p></div>
        <div className="progress-ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><strong>{progress}%</strong><span>今日完成</span></div>
      </section>

      <section className="learning-stats" aria-label="学习进度摘要">
        <div><strong>{learningStreak(learningState)}</strong><span>连续学习日</span></div>
        <div><strong>{completedDayCount(learningState)}</strong><span>已完成天数</span></div>
        <div><strong>{plan.goal.durationWeeks * 7}</strong><span>计划学习日</span></div>
      </section>

      {weeklyReview && (
        <section className="panel weekly-review" aria-labelledby="weekly-review-title">
          <div className="weekly-review-heading">
            <div><span className="agent-label">最近 7 个完成日</span><h2 id="weekly-review-title">学习周回顾</h2></div>
            <p>{weeklyReview.headline}</p>
            <button className="text-button" onClick={exportLearningProgress}>导出进展 Markdown</button>
          </div>
          <div className="weekly-review-metrics">
            <div><strong>{weeklyReview.completedDays}</strong><span>完成日</span></div>
            <div><strong>{weeklyReview.totalMinutes}</strong><span>投入分钟</span></div>
            <div><strong>{weeklyReview.averageEvaluationScore === null ? "—" : `${weeklyReview.averageEvaluationScore}/16`}</strong><span>平均成果评分</span></div>
            <div><strong>{weeklyReview.difficultDays}</strong><span>偏难日</span></div>
            <div><strong>{weeklyReview.successfulReviews}</strong><span>轻松回忆</span></div>
          </div>
          {weeklyTrend && (
            <div className={`weekly-trend ${weeklyTrend.status}`}>
              <div>
                <strong>{weeklyTrend.status === "insufficient-data" ? "周期趋势正在形成" : `与前 ${weeklyTrend.windowSize} 个完成日相比`}</strong>
                <span>{weeklyTrend.summary}</span>
              </div>
              <ul aria-label="等长周期变化">
                {weeklyTrend.status === "insufficient-data" ? <li>尚无可比窗口</li> : (
                  <>
                    <li>成果评分 {weeklyTrend.evaluationScoreDelta === null ? "证据不足" : `${weeklyTrend.evaluationScoreDelta > 0 ? "+" : ""}${weeklyTrend.evaluationScoreDelta}`}</li>
                    <li>偏难日 {weeklyTrend.difficultDaysDelta > 0 ? "+" : ""}{weeklyTrend.difficultDaysDelta}</li>
                    <li>轻松回忆 {weeklyTrend.successfulReviewsDelta > 0 ? "+" : ""}{weeklyTrend.successfulReviewsDelta}</li>
                  </>
                )}
              </ul>
            </div>
          )}
          <p className="weekly-next-action"><strong>本周最小下一步</strong>{weeklyReview.nextAction}</p>
        </section>
      )}

      {calendar && (
        <section className="panel learning-calendar" aria-labelledby="learning-calendar-title">
          <div className="calendar-heading">
            <div><span className="agent-label">完整学习历史</span><h2 id="learning-calendar-title">学习日历</h2></div>
            <div className="calendar-navigation">
              <button aria-label="查看上个月" disabled={calendarMonth <= firstCalendarMonth} onClick={() => setCalendarMonth(shiftCalendarMonth(calendarMonth, -1))}>←</button>
              <strong>{new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${calendarMonth}-01T00:00:00.000Z`))}</strong>
              <button aria-label="查看下个月" disabled={calendarMonth >= lastCalendarMonth} onClick={() => setCalendarMonth(shiftCalendarMonth(calendarMonth, 1))}>→</button>
            </div>
          </div>
          <div className="calendar-grid" role="group" aria-label={`${calendarMonth} 学习记录`}>
            {['一', '二', '三', '四', '五', '六', '日'].map((weekday) => <span className="calendar-weekday" aria-hidden="true" key={weekday}>{weekday}</span>)}
            {calendar.weeks.flat().map((day, index) => day.date ? (
              <button
                className={`calendar-day ${day.status} ${day.date === selectedCalendarDate ? "selected" : ""}`}
                disabled={day.records.length === 0}
                aria-label={`${day.date}${day.records.length > 0 ? `，${day.completedDays} 个完成日${day.status === "active" ? "，当前学习日" : ""}` : "，无学习记录"}`}
                aria-pressed={day.date === selectedCalendarDate}
                onClick={() => setSelectedCalendarDate(day.date)}
                key={day.date}
              >
                <span>{day.dayOfMonth}</span>
                {day.records.length > 0 && <i aria-hidden="true">{day.status === "active" ? "进行中" : `${day.completedDays} 日`}</i>}
              </button>
            ) : <span className="calendar-day outside" aria-hidden="true" key={`outside-${index}`} />)}
          </div>
          {selectedCalendarDay && selectedCalendarDay.records.length > 0 && (
            <div className="calendar-detail" aria-live="polite">
              <div>
                <strong>{formatCalendarDate(selectedCalendarDay.date)}</strong>
                <span>{selectedCalendarDay.completedDays > 0 ? `投入 ${selectedCalendarDay.totalMinutes} 分钟` : "当前学习尚未完成"}{selectedCalendarDay.averageEvaluationScore === null ? "" : ` · 平均成果 ${selectedCalendarDay.averageEvaluationScore}/16`}</span>
              </div>
              <ol>
                {selectedCalendarDay.records.map((record) => (
                  <li key={record.day}>
                    <strong>DAY {record.day}</strong>
                    <span>{record.status === "active" ? "进行中" : record.feedback?.difficulty === "too-hard" ? "偏困难" : record.feedback?.difficulty === "too-easy" ? "偏简单" : "刚刚好"}</span>
                    {record.feedback?.reflection && <p>{record.feedback.reflection}</p>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}

      <section className="panel review-schedule" aria-labelledby="review-schedule-title">
        <div className="review-schedule-heading">
          <div><span className="agent-label">Review Agent · 未来 14 天</span><h2 id="review-schedule-title">即将复习的薄弱点</h2></div>
          <small>{reviewSchedule.length} 项待复习</small>
        </div>
        {reviewSchedule.length > 0 ? (
          <ol>
            {reviewSchedule.map((item) => (
              <li key={`${item.sourceDay}-${item.dueDay}`}>
                <span className={item.dueDay === learningState.currentDay ? "due-now" : ""}>
                  {item.dueDay === learningState.currentDay ? "今天" : `第 ${item.dueDay} 天`}
                </span>
                <div><strong>回顾第 {item.sourceDay} 天</strong><p>{item.misconceptions.length > 0 ? `纠正：${item.misconceptions.join("、")}；` : ""}{item.nextAction}</p></div>
              </li>
            ))}
          </ol>
        ) : <p className="empty-notes">未来 14 天暂无待复习薄弱点；新的评估反馈会自动进入这里。</p>}
      </section>

      {repeatedMisconceptions.length > 0 && (
        <section className="panel misconception-links" aria-labelledby="misconception-links-title">
          <div className="review-schedule-heading">
            <div><span className="agent-label">Evaluator × Review Agent</span><h2 id="misconception-links-title">跨阶段重复误解</h2></div>
            <small>{repeatedMisconceptions.length} 条关联</small>
          </div>
          <ol>
            {repeatedMisconceptions.map((item) => (
              <li key={item.misconception}>
                <div>
                  <strong>{item.misconception}</strong>
                  <p className="misconception-evidence">{item.occurrences.map((occurrence) => `${occurrence.stageTitle} · 第 ${occurrence.sourceDays.join("、")} 天`).join(" ↔ ")}</p>
                  <p>{item.reviewPrompt}</p>
                  <button
                    className="secondary-action misconception-action"
                    disabled={currentRecord.tasks.some((task) => task.id === crossStageReviewTaskId(learningState.currentDay, item.misconception))}
                    onClick={() => updateState((current) => addCrossStageReviewTask(current, item.misconception))}
                  >
                    {currentRecord.tasks.some((task) => task.id === crossStageReviewTaskId(learningState.currentDay, item.misconception))
                      ? "已加入今日任务"
                      : "加入今天的主动回忆"}
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="panel notes-panel" aria-labelledby="notes-title">
        <div className="notes-heading">
          <div><span className="agent-label">阶段知识库</span><h2 id="notes-title">可检索学习笔记</h2></div>
          {currentStage && !(plan.notes ?? []).some((note) => note.stageId === currentStage.id) && (
            <div className="note-actions">
              <button className="text-button sync-button" onClick={beginCreatingStageNote}>手动新建笔记</button>
              <button className="secondary-action" onClick={createCurrentStageNote}>从证据生成笔记</button>
            </div>
          )}
        </div>
        {creatingStageNote && (
          <div className="note-create-form">
            <label>新笔记标题<input value={noteDraft.title} onChange={(event) => setNoteDraft({ ...noteDraft, title: event.target.value })} /></label>
            <label>新笔记内容<textarea rows={6} value={noteDraft.content} onChange={(event) => setNoteDraft({ ...noteDraft, content: event.target.value })} placeholder="先写下自己的关键结论，之后可追加新的学习证据。" /></label>
            <div className="note-actions"><button className="secondary-action" onClick={() => setCreatingStageNote(false)}>取消新建</button><button className="primary-dialog-action" onClick={saveNewStageNote}>新建笔记</button></div>
          </div>
        )}
        {(plan.notes ?? []).length > 0 ? (
          <>
            <label className="note-search">搜索笔记<input type="search" value={noteQuery} onChange={(event) => setNoteQuery(event.target.value)} placeholder="搜索概念、误解或实践证据" /></label>
            <div className="note-list">
              {visibleNotes.map((note) => {
                const stage = plan.stages.find((item) => item.id === note.stageId);
                const editing = editingNoteId === note.id;
                return (
                  <article key={note.id}>
                    {editing ? (
                      <>
                        <label>笔记标题<input value={noteDraft.title} onChange={(event) => setNoteDraft({ ...noteDraft, title: event.target.value })} /></label>
                        <label>笔记内容<textarea rows={9} value={noteDraft.content} onChange={(event) => setNoteDraft({ ...noteDraft, content: event.target.value })} /></label>
                        <div className="note-actions"><button className="secondary-action" onClick={() => setEditingNoteId("")}>取消</button><button className="primary-dialog-action" onClick={saveNoteDraft}>保存笔记</button></div>
                      </>
                    ) : (
                      <>
                        <div className="note-title"><div><small>{stage?.title ?? "学习阶段"} · 来源第 {note.sourceDays.length > 0 ? note.sourceDays.join("、") : "—"} 天</small><h3>{note.title}</h3></div><div className="note-actions"><button className="text-button sync-button" onClick={() => appendNewEvidence(note)}>追加新证据</button><button className="text-button sync-button" onClick={() => exportStageNote(note)}>导出 Markdown</button><button className="text-button sync-button" onClick={() => beginEditingNote(note)}>编辑</button><button className="text-button danger-text" onClick={() => setPendingDeleteNote(note)}>删除</button></div></div>
                        <p>{note.content}</p>
                      </>
                    )}
                  </article>
                );
              })}
              {visibleNotes.length === 0 && <p className="empty-notes" role="status">没有匹配的笔记。</p>}
            </div>
          </>
        ) : <p className="empty-notes">从当前阶段的教学讲解、理解回答、实践成果与评估反馈生成一份可编辑笔记。</p>}
      </section>

      {retrospectiveStages.length > 0 && (
        <section className="panel retrospective-panel" aria-labelledby="retrospective-title">
          <div className="retrospective-heading">
            <div><span className="agent-label">阶段证据整合</span><h2 id="retrospective-title">阶段结束回顾</h2></div>
            <p>把阶段目标、代表成果与可迁移能力整理成下一阶段可继续使用的记录。</p>
          </div>
          {goalMastery && (
            <div className={`goal-mastery ${goalMastery.status}`} role="status" aria-label="目标掌握度">
              <div><strong>{goalMastery.status === "ready" ? "目标证据已达标" : goalMastery.status === "in-progress" ? "目标仍在推进" : "目标仍需补强"}</strong><span>{goalMastery.headline}</span></div>
              <p>阶段完成 {goalMastery.completedStages}/{goalMastery.totalStages} · 证据达标 {goalMastery.readyStages}/{goalMastery.totalStages}</p>
              {goalMastery.priorityStageTitle && <p><b>当前优先</b>{goalMastery.priorityStageTitle} · {goalMastery.nextAction}</p>}
              {isLearningPlanComplete(learningState) && <button className="text-button mastery-action" onClick={exportGoalCompletionReport}>导出目标证据报告</button>}
              {goalMastery.priorityStageId && (currentRecord.status === "active" || isLearningPlanComplete(learningState)) && (() => {
                const taskAdded = currentRecord.status === "active"
                  && currentRecord.tasks.some((task) => task.id === stageMasteryTaskId(learningState.currentDay, goalMastery.priorityStageId!));
                return (
                  <button
                    className="secondary-action mastery-action"
                    disabled={taskAdded}
                    onClick={() => updateState((current) => startStageMasteryFollowUp(current, goalMastery.priorityStageId!))}
                  >
                    {taskAdded ? "当前优先补强已加入" : currentRecord.status === "completed" ? "开始当前优先补强日" : "补强当前优先阶段"}
                  </button>
                );
              })()}
            </div>
          )}
          <div className="retrospective-list">
            {retrospectiveStages.map((stage) => {
              const retrospective = (plan.retrospectives ?? []).find((item) => item.stageId === stage.id);
              const mastery = stageMasteryReport(learningState, stage.id);
              if (!retrospective) return (
                <article className="retrospective-empty" key={stage.id}>
                  <div><small>已完成 · 第 {stage.startWeek}{stage.endWeek > stage.startWeek ? `–${stage.endWeek}` : ""} 周</small><h3>{stage.title}</h3><p>{stage.outcome}</p><StageMasterySummary report={mastery} canAddTask={currentRecord.status === "active" || isLearningPlanComplete(learningState)} taskAdded={currentRecord.status === "active" && currentRecord.tasks.some((task) => task.id === stageMasteryTaskId(learningState.currentDay, stage.id))} startsFollowUpDay={currentRecord.status === "completed"} onAddTask={() => updateState((current) => startStageMasteryFollowUp(current, stage.id))} /></div>
                  <button className="secondary-action" onClick={() => createRetrospective(stage.id)}>生成阶段回顾</button>
                </article>
              );
              const editing = editingRetrospectiveId === retrospective.id;
              return (
                <article key={stage.id}>
                  <div className="retrospective-title"><div><small>{stage.title} · 来源第 {retrospective.sourceDays.join("、")} 天</small><h3>{stage.title}阶段回顾</h3></div>{!editing && <button className="text-button sync-button" onClick={() => beginEditingRetrospective(retrospective)}>编辑回顾</button>}</div>
                  <StageMasterySummary report={mastery} canAddTask={currentRecord.status === "active" || isLearningPlanComplete(learningState)} taskAdded={currentRecord.status === "active" && currentRecord.tasks.some((task) => task.id === stageMasteryTaskId(learningState.currentDay, stage.id))} startsFollowUpDay={currentRecord.status === "completed"} onAddTask={() => updateState((current) => startStageMasteryFollowUp(current, stage.id))} />
                  {editing ? (
                    <div className="retrospective-form">
                      <label>阶段目标回顾<textarea rows={3} value={retrospectiveDraft.goalReflection} onChange={(event) => setRetrospectiveDraft({ ...retrospectiveDraft, goalReflection: event.target.value })} /></label>
                      <label>代表成果<textarea rows={3} value={retrospectiveDraft.representativeArtifact} onChange={(event) => setRetrospectiveDraft({ ...retrospectiveDraft, representativeArtifact: event.target.value })} /></label>
                      <label>可迁移能力<textarea rows={3} value={retrospectiveDraft.transferableSkills} onChange={(event) => setRetrospectiveDraft({ ...retrospectiveDraft, transferableSkills: event.target.value })} /></label>
                      <label>下一阶段应用<textarea rows={3} value={retrospectiveDraft.nextApplication} onChange={(event) => setRetrospectiveDraft({ ...retrospectiveDraft, nextApplication: event.target.value })} /></label>
                      <div className="note-actions"><button className="secondary-action" onClick={() => setEditingRetrospectiveId("")}>取消</button><button className="primary-dialog-action" onClick={saveRetrospectiveDraft}>保存阶段回顾</button></div>
                    </div>
                  ) : (
                    <dl>
                      <div><dt>阶段目标回顾</dt><dd>{retrospective.goalReflection}</dd></div>
                      <div><dt>代表成果</dt><dd>{retrospective.representativeArtifact}</dd></div>
                      <div><dt>可迁移能力</dt><dd>{retrospective.transferableSkills}</dd></div>
                      <div><dt>下一阶段应用</dt><dd>{retrospective.nextApplication}</dd></div>
                    </dl>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      <div className="dashboard-grid">
        <section className="panel today-panel">
          {interruption && !coachDismissed && (
            <section className="coach-card" aria-labelledby="coach-title">
              <div>
                <span className="agent-label">Coach Agent · 低压力恢复</span>
                <h2 id="coach-title">欢迎回来，今天不用追赶。</h2>
                <p>{interruption.reason === "repeated-difficulty"
                  ? "最近连续两天都觉得偏难。可以先缩小任务，找回可控感。"
                  : `距离上次学习已经有 ${interruption.inactiveDays} 个空档日。可以从一个很小的动作重新开始。`}</p>
              </div>
              {!recoveryPlan ? (
                <div className="coach-actions">
                  <button className="secondary-action" disabled={isGeneratingRecovery} onClick={createRecoveryPlan}>
                    {isGeneratingRecovery ? "Coach Agent 正在准备…" : "生成 10–20 分钟恢复计划"}
                  </button>
                  <button className="text-button" onClick={() => setCoachDismissed(true)}>按原计划继续</button>
                </div>
              ) : (
                <div className="recovery-plan" role="status">
                  <strong>{recoveryPlan.headline} · {recoveryPlan.totalMinutes} 分钟</strong>
                  <p>{recoveryPlan.acknowledgement}</p>
                  <ol>{recoveryPlan.steps.map((step) => (
                    <li key={step.id}><span>{step.minutes} 分钟</span><strong>{step.title}</strong><p>{step.description}</p></li>
                  ))}</ol>
                  <p className="coach-check-in">完成后：{recoveryPlan.nextCheckIn}</p>
                </div>
              )}
            </section>
          )}
          <div className="section-title"><div><span>第 {learningState.currentDay} 天任务</span><h2>{plan.goal.dailyMinutes} 分钟学习闭环</h2></div><small>{currentRecord.tasks.filter((task) => task.completed).length}/{currentRecord.tasks.length} 完成</small></div>
          <div className="task-list">
            {currentRecord.tasks.map((task, index) => {
              const artifact = currentRecord.artifacts[task.id];
              const linkedInsight = repeatedMisconceptions.find((item) => crossStageReviewTaskId(learningState.currentDay, item.misconception) === task.id);
              const reviewItems = linkedInsight
                ? crossStageReviewItems(linkedInsight)
                : task.id === `day-${learningState.currentDay}-diagnose`
                  ? dueReviewItems(learningState, learningState.currentDay)
                  : [];
              const isAdaptiveReview = reviewItems.length > 0;
              const agentGuided = task.type === "learn" || task.type === "practice" || isAdaptiveReview;
              const submission = submissionDrafts[task.id] ?? artifact?.submission ?? "";
              return (
                <article id={`task-${task.id}`} className={`task-block ${task.completed ? "done" : ""}`} key={task.id}>
                  <button className="task" onClick={() => toggleTask(task.id)} disabled={agentGuided && !task.completed}>
                    <span className="check">{task.completed ? "✓" : index + 1}</span>
                    <span className="task-copy"><strong>{task.title}</strong><small>{task.description}</small></span>
                    <span className="minutes">{task.minutes}<small>MIN</small></span>
                  </button>

                  {isAdaptiveReview && !task.completed && (
                    <div className="agent-workspace review-workspace">
                      <span className="agent-label">Review Agent · 主动回忆自动判分</span>
                      <p>不查资料回答上面的复习问题。系统只根据答案中可见的证据判分，并自动安排下一次复习。</p>
                      <label>闭卷主动回忆答案
                        <textarea rows={4} value={reviewDrafts[task.id] ?? ""} onChange={(event) => setReviewDrafts((drafts) => ({ ...drafts, [task.id]: event.target.value }))} />
                      </label>
                      <button className="primary-action" disabled={busyTaskId === task.id} onClick={() => assessReview(task)}>
                        {busyTaskId === task.id ? "Review Agent 正在判分…" : "提交答案并自动安排复习"} <span>→</span>
                      </button>
                    </div>
                  )}

                  {artifact?.reviewPerformance?.assessment && (
                    <div className="review-assessment" role="status">
                      <strong>主动回忆 {artifact.reviewPerformance.assessment.score}/4 · {artifact.reviewPerformance.recall === "easy" ? "轻松想起" : artifact.reviewPerformance.recall === "effortful" ? "费力想起" : "尚未想起"}</strong>
                      <p>{artifact.reviewPerformance.assessment.evidence}</p>
                      <small>下一步：{artifact.reviewPerformance.assessment.feedback}</small>
                    </div>
                  )}

                  {task.type === "learn" && !task.completed && (
                    <div className="agent-workspace">
                      {!artifact?.teachingSession ? (
                        <button className="secondary-action" disabled={busyTaskId === task.id} onClick={() => startTeaching(task)}>
                          {busyTaskId === task.id ? "Teacher Agent 正在准备…" : "开始短教学会话"}
                        </button>
                      ) : (
                        <>
                          <span className="agent-label">Teacher Agent · {artifact.teachingSession.concept}</span>
                          <p>{artifact.teachingSession.explanation}</p>
                          <div className="worked-example"><strong>示例</strong><p>{artifact.teachingSession.workedExample}</p></div>
                          {artifact.teachingSession.understandingChecks.map((check, checkIndex) => (
                            <label key={check.id}>理解检查 {checkIndex + 1}：{check.prompt}
                              <textarea rows={2} value={artifact.understandingResponses?.[check.id] ?? ""} onChange={(event) => updateUnderstanding(task.id, check.id, event.target.value)} />
                            </label>
                          ))}
                          <button className="primary-action" onClick={() => finishTeaching(task.id)}>提交理解检查并完成任务 <span>→</span></button>
                        </>
                      )}
                    </div>
                  )}

                  {task.type === "practice" && !task.completed && (
                    <div className="agent-workspace">
                      <span className="agent-label">Evaluator Agent · 成果提交</span>
                      <label>描述成果、关键步骤、验证证据和复盘
                        <textarea rows={5} value={submission} onChange={(event) => setSubmissionDrafts({ ...submissionDrafts, [task.id]: event.target.value })} placeholder="例如：我实现了……；运行结果是……；失败案例是……；下一次我会……" />
                      </label>
                      <button className="primary-action" disabled={!submission.trim() || busyTaskId === task.id} onClick={() => evaluatePractice(task)}>{busyTaskId === task.id ? "Evaluator Agent 正在评估…" : "提交成果并获取反馈"} <span>→</span></button>
                    </div>
                  )}

                  {artifact?.evaluation && (
                    <div className="evaluation-result" role="status">
                      <div><span className="agent-label">评估结果 · {artifact.evaluation.masteryLevel}</span><strong>{artifact.evaluation.totalScore}/16</strong></div>
                      <p>{artifact.evaluation.nextAction}</p>
                      <div className="rubric-grid">{artifact.evaluation.rubric.map((item) => <span key={item.dimension}>{item.dimension}<strong>{item.score}/4</strong></span>)}</div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          {agentError && <div className="errors agent-error" role="alert">{agentError}</div>}
          {progress === 100 && currentRecord.status === "active" && (
            <div className="day-feedback">
              <strong>今天的任务难度如何？</strong>
              <div className="difficulty-options" role="group" aria-label="任务难度">
                {([
                  ["too-easy", "偏简单"],
                  ["just-right", "刚刚好"],
                  ["too-hard", "偏困难"],
                ] as const).map(([value, label]) => (
                  <button key={value} className={difficulty === value ? "selected" : ""} onClick={() => setDifficulty(value)}>{label}</button>
                ))}
              </div>
              <label>明天最想解决的问题（选填）<textarea rows={2} value={reflection} onChange={(event) => setReflection(event.target.value)} placeholder="例如：还不理解工具调用失败时如何恢复" /></label>
              {errors.length > 0 && <div className="errors">{errors.join(" · ")}</div>}
              <button className="primary-action" disabled={!difficulty} onClick={startNextDay}>保存反馈并生成下一天 <span>→</span></button>
            </div>
          )}
          {currentRecord.status === "completed" && <div className="celebration">整个学习周期已完成。你的任务、反馈和学习历史已保存在当前浏览器中。</div>}
        </section>

        <aside className="panel roadmap-panel">
          <div className="section-title"><div><span>学习路线</span><h2>{plan.goal.durationWeeks} 周成长路径</h2></div></div>
          <div className="stages">
            {plan.stages.map((stage, index) => {
              const currentWeek = Math.ceil(learningState.currentDay / 7);
              return (
              <article className={currentWeek >= stage.startWeek && currentWeek <= stage.endWeek ? "active" : ""} key={stage.id}>
                <span className="stage-dot">{index + 1}</span>
                <div><small>第 {stage.startWeek}{stage.endWeek > stage.startWeek ? `–${stage.endWeek}` : ""} 周</small><h3>{stage.title}</h3><p>{stage.outcome}</p></div>
              </article>
            )})}
          </div>
          {learningState.days.some((day) => day.status === "completed") && (
            <div className="history">
              <h3>最近完成</h3>
              {[...learningState.days].filter((day) => day.status === "completed").reverse().slice(0, 4).map((day) => (
                <div key={day.day}><span>DAY {day.day}</span><small>{day.feedback?.difficulty === "too-hard" ? "偏困难" : day.feedback?.difficulty === "too-easy" ? "偏简单" : "刚刚好"} · {day.tasks.reduce((sum, task) => sum + task.minutes, 0)} 分钟</small></div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
