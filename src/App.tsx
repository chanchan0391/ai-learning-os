import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  completeTeachingTask,
  completeCurrentDay,
  completedDayCount,
  getCurrentRecord,
  initializeLearningState,
  learningStateExportFilename,
  learningStreak,
  parseLearningStateExport,
  saveEvaluation,
  saveTeachingSession,
  saveUnderstandingResponse,
  serializeLearningStateExport,
  toggleCurrentTask,
} from "./learning-state";
import { BrowserLearningStateRepository } from "./learning-storage";
import { completionRate, validateGoal } from "./planner";
import { BrowserSyncClient, SyncConflictError, type AuthState, type SyncConflictPreview } from "./sync-client";
import { AutoSyncQueue, type AutoSyncStatus } from "./sync-queue";
import type { LearningStateExport } from "./learning-state";
import type { DailyTask, EvaluationResult, LearningGoal, LearningPlan, LearningState, TaskDifficulty, TeachingSession } from "./types";

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const learningStateRepository = new BrowserLearningStateRepository(localStorage);
const syncClient = new BrowserSyncClient(localStorage);

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

export function App() {
  const [initialLoad] = useState(() => learningStateRepository.load());
  const [learningState, setLearningState] = useState<LearningState | null>(initialLoad.state);
  const [goal, setGoal] = useState<LearningGoal>(INITIAL_GOAL);
  const [errors, setErrors] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [difficulty, setDifficulty] = useState<TaskDifficulty | "">("");
  const [reflection, setReflection] = useState("");
  const [agentError, setAgentError] = useState("");
  const [busyTaskId, setBusyTaskId] = useState("");
  const [submissionDrafts, setSubmissionDrafts] = useState<Record<string, string>>({});
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [accountDeleteConfirmationOpen, setAccountDeleteConfirmationOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<LearningStateExport | null>(null);
  const [storageNotice, setStorageNotice] = useState(initialLoad.status === "recovered" ? "本地进度无法读取，已安全重置。" : "");
  const [storageNoticeIsError, setStorageNoticeIsError] = useState(initialLoad.status === "recovered");
  const [authState, setAuthState] = useState<AuthState>({ status: "checking" });
  const [isSyncing, setIsSyncing] = useState(false);
  const [autoSyncStatus, setAutoSyncStatus] = useState<AutoSyncStatus>({ phase: "idle" });
  const [pendingSyncConflict, setPendingSyncConflict] = useState<SyncConflictPreview | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const learningStateRef = useRef<LearningState | null>(initialLoad.state);
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
  const currentRecord = learningState ? getCurrentRecord(learningState) : null;
  const progress = useMemo(() => completionRate(currentRecord?.tasks ?? []), [currentRecord]);

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

  function saveState(next: LearningState | null, enqueueSync = true) {
    learningStateRef.current = next;
    setLearningState(next);
    if (next) learningStateRepository.save(next);
    else learningStateRepository.clear();
    if (enqueueSync && next && authStateRef.current.status === "signed-in") autoSyncQueue.enqueue();
  }

  function updateState(update: (current: LearningState) => LearningState) {
    setLearningState((current) => {
      if (!current) return current;
      const next = update(current);
      learningStateRef.current = next;
      learningStateRepository.save(next);
      if (authStateRef.current.status === "signed-in") autoSyncQueue.enqueue();
      return next;
    });
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
      const parsed = parseLearningStateExport(await file.text());
      if (parsed.status === "invalid") {
        setStorageNotice(parsed.error);
        setStorageNoticeIsError(true);
        return;
      }
      setPendingImport(parsed.data);
    } catch {
      setStorageNotice("无法读取所选学习记录文件。");
      setStorageNoticeIsError(true);
    }
  }

  function importLearningData() {
    if (!pendingImport) return;
    saveState(pendingImport.state);
    setGoal(pendingImport.state.plan.goal);
    setSubmissionDrafts({});
    setDifficulty("");
    setReflection("");
    setAgentError("");
    setErrors([]);
    setPendingImport(null);
    setStorageNotice(`已恢复“${pendingImport.state.plan.goal.subject}”的第 ${pendingImport.state.currentDay} 天进度。`);
    setStorageNoticeIsError(false);
  }

  function deleteLearningData() {
    saveState(null, false);
    syncClient.clearMetadata();
    autoSyncQueue.clear();
    if (authStateRef.current.status === "signed-in") autoSyncQueue.start();
    setSubmissionDrafts({});
    setAgentError("");
    setErrors([]);
    setDeleteConfirmationOpen(false);
  }

  async function performSync() {
    setStorageNotice("");
    try {
      const result = await syncClient.sync(learningStateRef.current);
      if (result.state) {
        saveState(result.state, false);
        setGoal(result.state.plan.goal);
      }
      const changes = [
        result.uploaded > 0 ? `上传 ${result.uploaded} 项` : "",
        result.downloaded > 0 ? `下载 ${result.downloaded} 项` : "",
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
        saveState(result.state, false);
        setGoal(result.state.plan.goal);
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

  async function deleteAccountData() {
    setIsSyncing(true);
    try {
      await syncClient.deleteAccount();
      autoSyncQueue.stop();
      saveState(null, false);
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
      <button className="text-button" onClick={() => importInput.current?.click()}>导入学习记录</button>
    </>
  );

  const accountControls = authState.status === "signed-in" ? (
    <div className="account-controls" aria-label="账号与同步">
      <span className="sync-status">已登录</span>
      <span className={`sync-detail sync-${autoSyncStatus.phase}`}>{formatSyncStatus(autoSyncStatus)}</span>
      <button className="text-button sync-button" disabled={isSyncing} onClick={syncLearningData}>{isSyncing ? "正在同步…" : "立即同步"}</button>
      <button className="text-button" onClick={logout}>退出</button>
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
        <h2 id="import-dialog-title">恢复“{pendingImport.state.plan.goal.subject}”？</h2>
        <p id="import-dialog-description">将恢复到第 {pendingImport.state.currentDay} 天，并替换当前浏览器中的学习进度。导出时间：{new Date(pendingImport.exportedAt).toLocaleString("zh-CN")}。</p>
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

  if (!plan || !learningState || !currentRecord) {
    return (
      <main className="shell onboarding">
        <header className="topbar"><div className="brand"><span className="brand-mark">A</span> AI Learning OS <span className="beta">PROTOTYPE</span></div><div className="data-actions">{accountControls}{importControl}</div></header>
        {storageNotice && <div className="storage-notice" role={storageNoticeIsError ? "alert" : "status"}>{storageNotice}</div>}
        {importDialog}
        {conflictDialog}
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
          <button className="text-button danger-text" onClick={() => setDeleteConfirmationOpen(true)}>删除本地数据</button>
        </div>
      </header>
      {storageNotice && <div className="storage-notice dashboard-notice" role={storageNoticeIsError ? "alert" : "status"}>{storageNotice}</div>}
      {importDialog}
      {conflictDialog}
      {accountDeleteDialog}
      {deleteConfirmationOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setDeleteConfirmationOpen(false);
        }}>
          <section className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-description">
            <p className="eyebrow">不可撤销操作</p>
            <h2 id="delete-dialog-title">删除当前浏览器中的学习数据？</h2>
            <p id="delete-dialog-description">学习计划、任务历史、教学回答、成果和评估都会被永久删除。需要保留副本时，请先导出学习记录。</p>
            <div className="dialog-actions">
              <button className="secondary-action" autoFocus onClick={() => setDeleteConfirmationOpen(false)}>取消</button>
              <button className="danger-action" onClick={deleteLearningData}>确认删除</button>
            </div>
          </section>
        </div>
      )}
      <section className="welcome">
        <div><p className="eyebrow">DAY {learningState.currentDay} · 持续推进你的学习系统</p><h1>{plan.goal.subject}</h1><p>目标：{plan.goal.targetOutcome}</p></div>
        <div className="progress-ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><strong>{progress}%</strong><span>今日完成</span></div>
      </section>

      <section className="learning-stats" aria-label="学习进度摘要">
        <div><strong>{learningStreak(learningState)}</strong><span>连续学习日</span></div>
        <div><strong>{completedDayCount(learningState)}</strong><span>已完成天数</span></div>
        <div><strong>{plan.goal.durationWeeks * 7}</strong><span>计划学习日</span></div>
      </section>

      <div className="dashboard-grid">
        <section className="panel today-panel">
          <div className="section-title"><div><span>第 {learningState.currentDay} 天任务</span><h2>{plan.goal.dailyMinutes} 分钟学习闭环</h2></div><small>{currentRecord.tasks.filter((task) => task.completed).length}/{currentRecord.tasks.length} 完成</small></div>
          <div className="task-list">
            {currentRecord.tasks.map((task, index) => {
              const artifact = currentRecord.artifacts[task.id];
              const agentGuided = task.type === "learn" || task.type === "practice";
              const submission = submissionDrafts[task.id] ?? artifact?.submission ?? "";
              return (
                <article className={`task-block ${task.completed ? "done" : ""}`} key={task.id}>
                  <button className="task" onClick={() => toggleTask(task.id)} disabled={agentGuided && !task.completed}>
                    <span className="check">{task.completed ? "✓" : index + 1}</span>
                    <span className="task-copy"><strong>{task.title}</strong><small>{task.description}</small></span>
                    <span className="minutes">{task.minutes}<small>MIN</small></span>
                  </button>

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
