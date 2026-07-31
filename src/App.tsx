import { FormEvent, useMemo, useState } from "react";
import { completionRate, validateGoal } from "./planner";
import type { LearningGoal, LearningPlan } from "./types";

const STORAGE_KEY = "ai-learning-os-plan-v1";

const INITIAL_GOAL: LearningGoal = {
  subject: "AI Agent 工程",
  currentLevel: "Java 高级工程师，了解基础 Python",
  targetOutcome: "独立设计并交付一个企业级 AI Agent 应用",
  dailyMinutes: 60,
  durationWeeks: 12,
};

function readPlan(): LearningPlan | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value ? (JSON.parse(value) as LearningPlan) : null;
  } catch {
    return null;
  }
}

export function App() {
  const [plan, setPlan] = useState<LearningPlan | null>(readPlan);
  const [goal, setGoal] = useState<LearningGoal>(INITIAL_GOAL);
  const [errors, setErrors] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const progress = useMemo(() => completionRate(plan?.today ?? []), [plan]);

  function savePlan(next: LearningPlan | null) {
    setPlan(next);
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
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
      savePlan(body as LearningPlan);
    } catch (error) {
      setErrors([error instanceof Error ? error.message : "学习计划生成失败"]);
    } finally {
      setIsGenerating(false);
    }
  }

  function toggleTask(taskId: string) {
    if (!plan) return;
    savePlan({
      ...plan,
      today: plan.today.map((task) => task.id === taskId ? { ...task, completed: !task.completed } : task),
    });
  }

  if (!plan) {
    return (
      <main className="shell onboarding">
        <header className="brand"><span className="brand-mark">A</span> AI Learning OS <span className="beta">PROTOTYPE</span></header>
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
            <p className="privacy">数据仅保存在当前浏览器中</p>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="shell dashboard">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">A</span> AI Learning OS</div>
        <button className="text-button" onClick={() => savePlan(null)}>重新设定目标</button>
      </header>
      <section className="welcome">
        <div><p className="eyebrow">DAY 1 · 开始建立你的学习系统</p><h1>{plan.goal.subject}</h1><p>目标：{plan.goal.targetOutcome}</p></div>
        <div className="progress-ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><strong>{progress}%</strong><span>今日完成</span></div>
      </section>

      <div className="dashboard-grid">
        <section className="panel today-panel">
          <div className="section-title"><div><span>今日任务</span><h2>{plan.goal.dailyMinutes} 分钟学习闭环</h2></div><small>{plan.today.filter((task) => task.completed).length}/{plan.today.length} 完成</small></div>
          <div className="task-list">
            {plan.today.map((task, index) => (
              <button className={`task ${task.completed ? "done" : ""}`} key={task.id} onClick={() => toggleTask(task.id)}>
                <span className="check">{task.completed ? "✓" : index + 1}</span>
                <span className="task-copy"><strong>{task.title}</strong><small>{task.description}</small></span>
                <span className="minutes">{task.minutes}<small>MIN</small></span>
              </button>
            ))}
          </div>
          {progress === 100 && <div className="celebration">今天的学习闭环已完成。真正的进步来自每一次完整反馈。</div>}
        </section>

        <aside className="panel roadmap-panel">
          <div className="section-title"><div><span>学习路线</span><h2>{plan.goal.durationWeeks} 周成长路径</h2></div></div>
          <div className="stages">
            {plan.stages.map((stage, index) => (
              <article className={index === 0 ? "active" : ""} key={stage.id}>
                <span className="stage-dot">{index + 1}</span>
                <div><small>第 {stage.startWeek}{stage.endWeek > stage.startWeek ? `–${stage.endWeek}` : ""} 周</small><h3>{stage.title}</h3><p>{stage.outcome}</p></div>
              </article>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}
