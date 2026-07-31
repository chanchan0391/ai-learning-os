import { FormEvent, useMemo, useState } from "react";
import {
  completeTeachingTask,
  completeCurrentDay,
  completedDayCount,
  getCurrentRecord,
  initializeLearningState,
  learningStateExportFilename,
  learningStreak,
  parseLearningState,
  saveEvaluation,
  saveTeachingSession,
  saveUnderstandingResponse,
  serializeLearningStateExport,
  toggleCurrentTask,
} from "./learning-state";
import { completionRate, validateGoal } from "./planner";
import type { DailyTask, EvaluationResult, LearningGoal, LearningPlan, LearningState, TaskDifficulty, TeachingSession } from "./types";

const STORAGE_KEY = "ai-learning-os-state-v3";
const PREVIOUS_STORAGE_KEY = "ai-learning-os-state-v2";
const LEGACY_STORAGE_KEY = "ai-learning-os-plan-v1";

const INITIAL_GOAL: LearningGoal = {
  subject: "AI Agent 工程",
  currentLevel: "Java 高级工程师，了解基础 Python",
  targetOutcome: "独立设计并交付一个企业级 AI Agent 应用",
  dailyMinutes: 60,
  durationWeeks: 12,
};

function readState(): ReturnType<typeof parseLearningState> {
  const current = localStorage.getItem(STORAGE_KEY);
  const source = current ?? localStorage.getItem(PREVIOUS_STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
  const result = parseLearningState(source);
  if (result.state && result.status === "migrated") {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(result.state));
    localStorage.removeItem(PREVIOUS_STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } else if (result.status === "recovered") {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PREVIOUS_STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
  return result;
}

export function App() {
  const [initialLoad] = useState(readState);
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
  const [storageNotice, setStorageNotice] = useState(initialLoad.status === "recovered" ? "本地进度无法读取，已安全重置。" : "");
  const plan = learningState?.plan ?? null;
  const currentRecord = learningState ? getCurrentRecord(learningState) : null;
  const progress = useMemo(() => completionRate(currentRecord?.tasks ?? []), [currentRecord]);

  function saveState(next: LearningState | null) {
    setLearningState(next);
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(PREVIOUS_STORAGE_KEY);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  }

  function updateState(update: (current: LearningState) => LearningState) {
    setLearningState((current) => {
      if (!current) return current;
      const next = update(current);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
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

  function deleteLearningData() {
    saveState(null);
    setSubmissionDrafts({});
    setAgentError("");
    setErrors([]);
    setDeleteConfirmationOpen(false);
  }

  if (!plan || !learningState || !currentRecord) {
    return (
      <main className="shell onboarding">
        <header className="brand"><span className="brand-mark">A</span> AI Learning OS <span className="beta">PROTOTYPE</span></header>
        {storageNotice && <div className="storage-notice" role="status">{storageNotice}</div>}
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
          <button className="text-button" onClick={exportLearningData}>导出学习记录</button>
          <button className="text-button danger-text" onClick={() => setDeleteConfirmationOpen(true)}>删除本地数据</button>
        </div>
      </header>
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
