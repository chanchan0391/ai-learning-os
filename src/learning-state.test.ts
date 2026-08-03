import { describe, expect, it } from "vitest";
import {
  activeGoalOverview,
  activeGoalPortfolioOverview,
  archivedLearningStateExportFilename,
  portfolioBudgetStatus,
  portfolioDailyAgenda,
  addStageMasteryTask,
  addCrossStageReviewTask,
  appendStageNoteEvidence,
  completeTeachingTask,
  completeCurrentDay,
  completedDayCount,
  createStageNote,
  createLearningStateExport,
  createPortfolioLearningStateExport,
  crossStageMisconceptionInsights,
  crossGoalWeeklyReview,
  crossGoalWeeklyReviewMarkdownFilename,
  crossStageReviewTaskId,
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
  learningStreak,
  learningCalendarMonth,
  parseLearningState,
  parseLearningStateExport,
  parsePortfolioLearningStateExport,
  portfolioLearningStateExportFilename,
  portfolioPreRestoreBackupFilename,
  saveEvaluation,
  saveCrossStageReviewAssessment,
  saveReviewPerformance,
  saveReviewAssessment,
  saveTeachingSession,
  saveUnderstandingResponse,
  scheduledReviewItems,
  stageMasteryReport,
  stageMasteryTaskId,
  startStageMasteryFollowUp,
  serializeLearningStateExport,
  serializePortfolioLearningStateExport,
  serializeGoalCompletionMarkdown,
  serializeCrossGoalWeeklyReviewMarkdown,
  serializeLearningProgressMarkdown,
  serializeStageNoteMarkdown,
  stageNoteMarkdownFilename,
  toggleCurrentTask,
  updateStageNote,
  updateStageRetrospective,
  weeklyLearningReview,
  weeklyLearningTrend,
} from "./learning-state";
import { generateLearningPlan } from "./planner";

const goal = {
  subject: "AI Agent 工程",
  currentLevel: "Java 高级工程师",
  targetOutcome: "独立交付企业级 Agent 应用",
  dailyMinutes: 60,
  durationWeeks: 12,
};

function completedState() {
  const plan = generateLearningPlan(goal, new Date("2026-07-30T10:00:00.000Z"));
  let state = initializeLearningState(plan, new Date("2026-07-30T10:00:00.000Z"));
  for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
  return state;
}

describe("multi-day learning state", () => {
  it("summarizes today's work, learning risk, and recent evidence for a cross-goal home", () => {
    let state = completedState();
    state = saveEvaluation(state, getCurrentRecord(state).tasks.find((task) => task.type === "practice")!.id, "成果", {
      rubric: [
        { dimension: "understanding", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "application", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "evidence", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "reflection", score: 2, evidence: "证据", feedback: "反馈" },
      ],
      totalScore: 8, masteryLevel: "developing", misconceptions: [], nextAction: "补充边界测试",
    });
    state = completeCurrentDay(state, { difficulty: "too-hard", reflection: "需要缩小范围" }, new Date("2026-07-30T18:00:00.000Z"));
    state = toggleCurrentTask(state, getCurrentRecord(state).tasks[0].id);

    expect(activeGoalOverview(state, new Date("2026-07-31T10:00:00.000Z"))).toEqual({
      completedTasks: 1,
      totalTasks: 4,
      scheduledMinutes: 60,
      remainingMinutes: 54,
      riskLevel: "review",
      riskLabel: "1 项薄弱点复习到期",
      recentProgress: "最近完成第 1 天 · 成果 8/16",
    });
  });

  it("aggregates cross-goal workload and attention signals", () => {
    const steady = initializeLearningState(generateLearningPlan(goal), new Date("2026-07-31T10:00:00.000Z"));
    const interrupted = initializeLearningState(
      generateLearningPlan({ ...goal, subject: "分布式系统", dailyMinutes: 30 }),
      new Date("2026-07-27T10:00:00.000Z"),
    );

    expect(activeGoalPortfolioOverview([steady, interrupted], new Date("2026-08-01T10:00:00.000Z"))).toEqual({
      activeGoals: 2,
      completedTasks: 0,
      totalTasks: 8,
      scheduledMinutes: 90,
      remainingMinutes: 90,
      goalsNeedingAttention: 1,
    });
  });

  it("flags a portfolio that exceeds its daily time budget", () => {
    const overview = activeGoalPortfolioOverview([
      initializeLearningState(generateLearningPlan(goal)),
      initializeLearningState(generateLearningPlan({ ...goal, subject: "分布式系统", dailyMinutes: 45 })),
    ]);

    expect(portfolioBudgetStatus(overview, 90)).toEqual({
      budgetMinutes: 90,
      scheduledMinutes: 105,
      overloadedBy: 15,
      availableMinutes: 0,
      status: "over-budget",
    });
    expect(portfolioBudgetStatus(overview, 120)).toMatchObject({
      overloadedBy: 0,
      availableMinutes: 15,
      status: "within-budget",
    });
  });

  it("builds a budgeted cross-goal agenda that prioritizes risk and keeps tasks atomic", () => {
    const steady = initializeLearningState(generateLearningPlan(goal), new Date("2026-08-01T10:00:00.000Z"));
    const interrupted = initializeLearningState(
      generateLearningPlan({ ...goal, subject: "分布式系统", dailyMinutes: 30 }, new Date("2026-07-28T10:00:00.000Z")),
      new Date("2026-07-28T10:00:00.000Z"),
    );

    const agenda = portfolioDailyAgenda([steady, interrupted], 45, new Date("2026-08-02T10:00:00.000Z"));

    expect(agenda).toMatchObject({ budgetMinutes: 45, scheduledMinutes: 90, plannedMinutes: 41, deferredMinutes: 49 });
    expect(agenda.items.map((item) => [item.subject, item.minutes, item.riskLevel])).toEqual([
      ["分布式系统", 4, "attention"],
      ["AI Agent 工程", 7, "steady"],
      ["分布式系统", 10, "attention"],
      ["AI Agent 工程", 20, "steady"],
    ]);
    expect(agenda.items.every((item) => item.minutes > 0)).toBe(true);
    expect(portfolioDailyAgenda([steady], null).plannedMinutes).toBe(60);
    expect(() => portfolioDailyAgenda([steady], -1)).toThrow("跨目标每日预算必须是非负整数");
  });

  it("compares weekly allocation, outcomes, and risk across active goals", () => {
    const completeOn = (subject: string, dates: string[], difficulties: ("just-right" | "too-hard")[], scores: number[]) => {
      let state = initializeLearningState(generateLearningPlan({ ...goal, subject }), new Date(`${dates[0]}T08:00:00.000Z`));
      dates.forEach((date, index) => {
        for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
        const practice = getCurrentRecord(state).tasks.find((task) => task.type === "practice")!;
        if (scores[index] !== undefined) {
          const base = Math.floor(scores[index] / 4);
          const remainder = scores[index] % 4;
          const dimensionScores = [0, 1, 2, 3].map((dimension) => base + (dimension < remainder ? 1 : 0));
          state = saveEvaluation(state, practice.id, "成果", {
            rubric: [
              { dimension: "understanding", score: dimensionScores[0], evidence: "证据", feedback: "反馈" },
              { dimension: "application", score: dimensionScores[1], evidence: "证据", feedback: "反馈" },
              { dimension: "evidence", score: dimensionScores[2], evidence: "证据", feedback: "反馈" },
              { dimension: "reflection", score: dimensionScores[3], evidence: "证据", feedback: "反馈" },
            ],
            totalScore: scores[index], masteryLevel: "developing", misconceptions: [], nextAction: "补充证据",
          });
        }
        state = completeCurrentDay(state, { difficulty: difficulties[index], reflection: "复盘" }, new Date(`${date}T18:00:00.000Z`));
      });
      return state;
    };
    const agent = completeOn("AI Agent 工程", ["2026-07-24", "2026-08-01"], ["just-right", "too-hard"], [10, 8]);
    const systems = completeOn("分布式系统", ["2026-07-25", "2026-08-02"], ["too-hard", "just-right"], [8, 12]);

    const review = crossGoalWeeklyReview([agent, systems], new Date("2026-08-02T20:00:00.000Z"));

    expect(review).toMatchObject({
      windowStart: "2026-07-27",
      windowEnd: "2026-08-02",
      totalMinutes: 120,
      completedDays: 2,
      evaluationCount: 2,
      headline: "本周有目标的学习风险上升。",
      focusPlanId: agent.plan.id,
    });
    expect(review.goals).toEqual([
      expect.objectContaining({ subject: "AI Agent 工程", totalMinutes: 60, allocationPercent: 50, averageEvaluationScore: 8, evaluationScoreDelta: -2, difficultDaysDelta: 1, riskTrend: "needs-attention" }),
      expect.objectContaining({ subject: "分布式系统", totalMinutes: 60, allocationPercent: 50, averageEvaluationScore: 12, evaluationScoreDelta: 4, difficultDaysDelta: -1, riskTrend: "improving" }),
    ]);
    expect(review.focusReason).toContain("偏难日比前一周增加");

    const markdown = serializeCrossGoalWeeklyReviewMarkdown([agent, systems], new Date("2026-08-02T20:00:00.000Z"));
    expect(crossGoalWeeklyReviewMarkdownFilename(new Date("2026-08-02T20:00:00.000Z"))).toBe("ai-learning-os-cross-goal-weekly-review-2026-08-02.md");
    expect(markdown).toContain("> 回顾周期：2026-07-27 至 2026-08-02");
    expect(markdown).toContain("- 总投入：120 分钟");
    expect(markdown).toContain("### AI Agent 工程");
    expect(markdown).toContain("- 成果：8/16（较前一周 -2）");
    expect(markdown).toContain("- 风险：1 个偏难日（较前一周 +1）；");
    expect(markdown).toContain(review.focusReason);
  });

  it("detects missed learning days without treating a one-day gap as an interruption", () => {
    const plan = generateLearningPlan(goal);
    const state = initializeLearningState(plan, new Date("2026-07-28T10:00:00.000Z"));

    expect(detectLearningInterruption(state, new Date("2026-07-30T10:00:00.000Z"))).toBeNull();
    expect(detectLearningInterruption(state, new Date("2026-08-01T10:00:00.000Z"))).toEqual({
      reason: "inactivity",
      inactiveDays: 3,
      recentDifficultDays: 0,
      lastActiveDate: "2026-07-28",
    });
  });

  it("detects two consecutive difficult days even without an inactivity gap", () => {
    let state = completedState();
    state = completeCurrentDay(state, { difficulty: "too-hard", reflection: "卡住" }, new Date("2026-07-30T18:00:00.000Z"));
    for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
    state = completeCurrentDay(state, { difficulty: "too-hard", reflection: "仍然卡住" }, new Date("2026-07-31T18:00:00.000Z"));

    expect(detectLearningInterruption(state, new Date("2026-08-01T10:00:00.000Z"))).toEqual({
      reason: "repeated-difficulty",
      inactiveDays: 0,
      recentDifficultDays: 2,
      lastActiveDate: "2026-07-31",
    });
  });

  it("migrates a valid v1 plan into versioned state", () => {
    const plan = generateLearningPlan(goal, new Date("2026-07-30T10:00:00.000Z"));
    const result = parseLearningState(JSON.stringify(plan), new Date("2026-07-31T08:00:00.000Z"));

    expect(result.status).toBe("migrated");
    expect(result.state).toMatchObject({ version: 3, currentDay: 1 });
    expect(result.state?.days[0].tasks).toHaveLength(4);
    expect(result.state?.days[0].artifacts).toEqual({});
  });

  it("migrates version 2 learning history without losing completed days", () => {
    const state = completeCurrentDay(completedState(), { difficulty: "just-right", reflection: "保留我" });
    const legacy = { ...state, version: 2, days: state.days.map(({ artifacts: _artifacts, ...day }) => day) };
    const result = parseLearningState(JSON.stringify(legacy));

    expect(result.status).toBe("migrated");
    expect(result.state).toMatchObject({ version: 3, currentDay: 2 });
    expect(result.state?.days[0].feedback?.reflection).toBe("保留我");
    expect(result.state?.days.every((day) => Object.keys(day.artifacts).length === 0)).toBe(true);
  });

  it("rejects corrupt saved data instead of trusting a partial object", () => {
    expect(parseLearningState("{broken").status).toBe("recovered");
    expect(parseLearningState(JSON.stringify({ version: 2, days: [] })).state).toBeNull();
    const state = initializeLearningState(generateLearningPlan(goal));
    state.days[0].artifacts[state.days[0].tasks[0].id] = { evaluation: { totalScore: 99 } } as never;
    expect(parseLearningState(JSON.stringify(state)).status).toBe("recovered");

    const invalidReview = completedState();
    invalidReview.days[0].artifacts[invalidReview.days[0].tasks[0].id] = {
      reviewPerformance: { sourceDays: [1], recall: "easy" },
    };
    expect(parseLearningState(JSON.stringify(invalidReview)).status).toBe("recovered");
  });

  it("creates a versioned, portable export without changing learning data", () => {
    const state = completedState();
    const exportedAt = new Date("2026-07-31T14:30:00.000Z");
    const payload = createLearningStateExport(state, exportedAt);

    expect(payload).toEqual({
      format: "ai-learning-os-learning-data",
      exportVersion: 1,
      exportedAt: "2026-07-31T14:30:00.000Z",
      state,
    });
    expect(JSON.parse(serializeLearningStateExport(state, exportedAt))).toEqual(payload);
    expect(learningStateExportFilename(exportedAt)).toBe("ai-learning-os-learning-data-2026-07-31.json");
    expect(archivedLearningStateExportFilename(state, exportedAt)).toBe("AI-Agent-工程-learning-data-2026-07-31.json");
  });

  it("exports the weekly review and every stage progress summary as Markdown", () => {
    let state = completedState();
    state = completeCurrentDay(state, { difficulty: "too-hard", reflection: "缩小范围" }, new Date("2026-08-01T10:00:00.000Z"));
    state.plan.notes = [{ id: "note-stage-1", stageId: "stage-1", title: "基础笔记", content: "证据", sourceDays: [1], updatedAt: "2026-08-01T12:00:00.000Z" }];
    const now = new Date("2026-08-01T14:00:00.000Z");
    const markdown = serializeLearningProgressMarkdown(state, now);

    expect(learningProgressMarkdownFilename(now)).toBe("ai-learning-os-progress-2026-08-01.md");
    expect(markdown).toContain("# AI Agent 工程 学习进展");
    expect(markdown).toContain("## 最近 7 个完成日");
    expect(markdown).toContain("- 最小下一步：缩小范围");
    expect(markdown).toContain("## 等长周期趋势");
    expect(markdown).toContain("- 对比状态：证据不足");
    expect(markdown).toContain("## 阶段进展");
    expect(markdown).toContain("- 已完成：1/21 个学习日");
    expect(markdown).toContain("基础笔记（1 个来源日）");
    expect(markdown.match(/^### /gm)).toHaveLength(state.plan.stages.length);
  });

  it("validates a portable export before allowing it to be restored", () => {
    const state = completedState();
    const serialized = serializeLearningStateExport(state, new Date("2026-07-31T14:30:00.000Z"));

    expect(parseLearningStateExport(serialized)).toEqual({
      status: "valid",
      data: JSON.parse(serialized),
    });
  });

  it("rejects malformed, unsupported, and tampered learning exports", () => {
    const valid = createLearningStateExport(completedState());

    expect(parseLearningStateExport("{broken")).toMatchObject({ status: "invalid" });
    expect(parseLearningStateExport(JSON.stringify({ ...valid, exportVersion: 99 }))).toMatchObject({ status: "invalid" });
    expect(parseLearningStateExport(JSON.stringify({ ...valid, state: { ...valid.state, currentDay: 99 } }))).toMatchObject({ status: "invalid" });
    expect(parseLearningStateExport(JSON.stringify({
      ...valid,
      state: { ...valid.state, plan: { ...valid.state.plan, stages: [{ anything: "passes" }] } },
    }))).toMatchObject({ status: "invalid" });
  });

  it("round-trips a validated portfolio backup with active goals, archives, and budget", () => {
    const active = completedState();
    let archived = initializeLearningState(generateLearningPlan({ ...goal, subject: "系统设计", durationWeeks: 1 }));
    for (let day = 0; day < 7; day += 1) {
      for (const task of getCurrentRecord(archived).tasks) archived = toggleCurrentTask(archived, task.id);
      archived = completeCurrentDay(archived, { difficulty: "just-right", reflection: "完成" });
    }
    const now = new Date("2026-08-03T14:30:00.000Z");
    const payload = createPortfolioLearningStateExport(
      [active], [{ archivedAt: "2026-08-03T12:00:00.000Z", state: archived }], active.plan.id, 90, now,
    );
    const serialized = serializePortfolioLearningStateExport(
      payload.activeStates, payload.archivedStates, payload.selectedPlanId, payload.dailyBudgetMinutes, now,
    );

    expect(parsePortfolioLearningStateExport(serialized)).toEqual({ status: "valid", data: payload });
    expect(portfolioLearningStateExportFilename(now)).toBe("ai-learning-os-all-learning-data-2026-08-03.json");
    expect(portfolioPreRestoreBackupFilename(now)).toBe("ai-learning-os-before-restore-2026-08-03.json");
    expect(parsePortfolioLearningStateExport(JSON.stringify({ ...payload, activeStates: [active, active] })))
      .toMatchObject({ status: "invalid", error: "全部学习数据包含重复目标。" });
    expect(parsePortfolioLearningStateExport(JSON.stringify({ ...payload, dailyBudgetMinutes: 1 })))
      .toMatchObject({ status: "invalid" });
    expect(parsePortfolioLearningStateExport(JSON.stringify({ ...payload, selectedPlanId: "missing" })))
      .toMatchObject({ status: "invalid" });
  });

  it("requires every task before closing the day", () => {
    const plan = generateLearningPlan(goal);
    const state = initializeLearningState(plan);
    expect(() => completeCurrentDay(state, { difficulty: "just-right", reflection: "" })).toThrow("请先完成今天的全部任务");
  });

  it("records feedback and creates an adaptive next-day loop", () => {
    const state = completeCurrentDay(
      completedState(),
      { difficulty: "too-hard", reflection: "工具调用失败后如何恢复？" },
      new Date("2026-07-31T10:00:00.000Z"),
    );

    expect(state.currentDay).toBe(2);
    expect(state.days[0]).toMatchObject({ status: "completed", feedback: { difficulty: "too-hard" } });
    expect(state.days[1].tasks.map((task) => task.type)).toEqual(["diagnose", "learn", "practice", "reflect"]);
    expect(state.days[1].tasks.reduce((sum, task) => sum + task.minutes, 0)).toBe(60);
    expect(state.days[1].tasks[1].description).toContain("先缩小范围");
    expect(completedDayCount(state)).toBe(1);
    expect(learningStreak(state)).toBe(1);
  });

  it("derives a seven-day learning review from effort, evaluation, and recall evidence", () => {
    let state = completedState();
    const practice = getCurrentRecord(state).tasks.find((task) => task.type === "practice")!;
    state = saveEvaluation(state, practice.id, "第一份成果", {
      rubric: [
        { dimension: "understanding", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "application", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "evidence", score: 1, evidence: "证据", feedback: "反馈" },
        { dimension: "reflection", score: 2, evidence: "证据", feedback: "反馈" },
      ],
      totalScore: 7,
      masteryLevel: "needs-support",
      misconceptions: ["执行边界不清"],
      nextAction: "补充失败案例并解释执行边界",
    });
    state = completeCurrentDay(state, { difficulty: "too-hard", reflection: "需要缩小范围" });

    expect(weeklyLearningReview(state)).toEqual({
      completedDays: 1,
      totalMinutes: 60,
      evaluationCount: 1,
      averageEvaluationScore: 7,
      difficultDays: 1,
      successfulReviews: 0,
      headline: "本周已经形成可用于调整计划的证据。",
      nextAction: "补充失败案例并解释执行边界",
    });
  });

  it("gives a useful weekly-review prompt before evaluation evidence exists", () => {
    expect(weeklyLearningReview(initializeLearningState(generateLearningPlan(goal)))).toMatchObject({
      completedDays: 0,
      totalMinutes: 0,
      averageEvaluationScore: null,
      headline: "完成第一天后，这里会形成你的周回顾。",
      nextAction: "完成今天的学习闭环。",
    });
  });

  it("compares equal completed-day windows without persisting a second analytics state", () => {
    let state = initializeLearningState(generateLearningPlan(goal));
    const scores = [8, 8, 12, 12];
    for (const [index, score] of scores.entries()) {
      const practice = getCurrentRecord(state).tasks.find((task) => task.type === "practice")!;
      const dimensionScore = score / 4;
      state = saveEvaluation(state, practice.id, `成果 ${index + 1}`, {
        rubric: ["understanding", "application", "evidence", "reflection"].map((dimension) => ({
          dimension: dimension as "understanding" | "application" | "evidence" | "reflection",
          score: dimensionScore,
          evidence: "可见证据",
          feedback: "继续验证",
        })),
        totalScore: score,
        masteryLevel: score <= 7 ? "needs-support" : score <= 12 ? "developing" : "ready",
        misconceptions: [],
        nextAction: "增加边界案例",
      });
      for (const task of getCurrentRecord(state).tasks.filter((task) => !task.completed)) {
        state = toggleCurrentTask(state, task.id);
      }
      state = completeCurrentDay(
        state,
        { difficulty: index < 2 ? "too-hard" : "just-right", reflection: `复盘 ${index + 1}` },
        new Date(`2026-08-0${index + 2}T10:00:00.000Z`),
      );
    }

    expect(weeklyLearningTrend(state)).toEqual({
      status: "improving",
      windowSize: 2,
      evaluationScoreDelta: 4,
      difficultDaysDelta: -2,
      successfulReviewsDelta: 0,
      summary: "近期证据比上一阶段更稳，继续保持当前节奏。",
    });
    expect(state).not.toHaveProperty("weeklyTrend");
  });

  it("waits for two equal two-day windows before claiming a trend", () => {
    expect(weeklyLearningTrend(initializeLearningState(generateLearningPlan(goal)))).toEqual({
      status: "insufficient-data",
      windowSize: 0,
      evaluationScoreDelta: null,
      difficultDaysDelta: 0,
      successfulReviewsDelta: 0,
      summary: "完成至少 4 个学习日后，这里会显示等长周期趋势。",
    });
  });

  it("groups complete learning evidence into a Monday-first calendar month", () => {
    let state = initializeLearningState(generateLearningPlan(goal), new Date("2026-07-31T10:00:00.000Z"));
    for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
    state = completeCurrentDay(state, { difficulty: "too-hard", reflection: "保留失败证据" }, new Date("2026-08-01T10:00:00.000Z"));

    const july = learningCalendarMonth(state, "2026-07");
    const july31 = july.weeks.flat().find((day) => day.date === "2026-07-31")!;
    expect(july.weeks.every((week) => week.length === 7)).toBe(true);
    expect(july.weeks[0][0].date).toBe("");
    expect(july31).toMatchObject({ status: "completed", completedDays: 1, totalMinutes: 60, averageEvaluationScore: null });
    expect(july31.records[0].feedback?.reflection).toBe("保留失败证据");

    const august1 = learningCalendarMonth(state, "2026-08").weeks.flat().find((day) => day.date === "2026-08-01")!;
    expect(august1).toMatchObject({ status: "active", completedDays: 0, totalMinutes: 0 });
    expect(() => learningCalendarMonth(state, "2026-13")).toThrow("日历月份格式无效");
  });

  it("persists teaching checks before completing a learn task", () => {
    let state = initializeLearningState(generateLearningPlan(goal));
    const task = getCurrentRecord(state).tasks.find((item) => item.type === "learn")!;
    const session = {
      concept: "工具调用", explanation: "解释", workedExample: "示例", practicePrompt: "练习",
      understandingChecks: [
        { id: "recall", prompt: "解释机制", expectedSignals: ["机制"] },
        { id: "apply", prompt: "迁移应用", expectedSignals: ["步骤"] },
      ],
      completionSignals: ["可解释"],
    };
    state = saveTeachingSession(state, task.id, session);
    state = saveUnderstandingResponse(state, task.id, "recall", "我的解释");
    expect(() => completeTeachingTask(state, task.id)).toThrow("请先回答全部理解检查");
    state = saveUnderstandingResponse(state, task.id, "apply", "我的应用步骤");
    state = completeTeachingTask(state, task.id);

    expect(getCurrentRecord(state).tasks.find((item) => item.id === task.id)?.completed).toBe(true);
    expect(getCurrentRecord(state).artifacts[task.id].understandingResponses).toEqual({ recall: "我的解释", apply: "我的应用步骤" });
  });

  it("generates an editable stage note from learning evidence", () => {
    let state = initializeLearningState(generateLearningPlan(goal));
    const task = getCurrentRecord(state).tasks.find((item) => item.type === "learn")!;
    state = saveTeachingSession(state, task.id, {
      concept: "工具调用", explanation: "模型选择工具，宿主执行工具。", workedExample: "先校验参数再调用。", practicePrompt: "练习",
      understandingChecks: [
        { id: "recall", prompt: "解释机制", expectedSignals: ["机制"] },
        { id: "apply", prompt: "迁移应用", expectedSignals: ["步骤"] },
      ],
      completionSignals: ["可解释"],
    });
    state = saveUnderstandingResponse(state, task.id, "recall", "工具由宿主执行");
    state = generateStageNote(state, "stage-1", new Date("2026-08-01T12:00:00.000Z"));

    expect(state.plan.notes).toHaveLength(1);
    expect(state.plan.notes?.[0]).toMatchObject({ stageId: "stage-1", sourceDays: [1] });
    expect(state.plan.notes?.[0].content).toContain("模型选择工具");
    expect(() => generateStageNote(state, "stage-1")).toThrow("已经有学习笔记");

    state = updateStageNote(state, "note-stage-1", { title: "工具调用速查", content: "参数校验是执行边界。" }, new Date("2026-08-01T13:00:00.000Z"));
    expect(state.plan.notes?.[0]).toMatchObject({ title: "工具调用速查", content: "参数校验是执行边界。", updatedAt: "2026-08-01T13:00:00.000Z" });
    expect(parseLearningState(JSON.stringify(state))).toMatchObject({ status: "valid" });
  });

  it("creates a manual stage note and appends only new evidence without replacing its prose", () => {
    let state = initializeLearningState(generateLearningPlan(goal));
    const task = getCurrentRecord(state).tasks.find((item) => item.type === "learn")!;
    state = saveTeachingSession(state, task.id, {
      concept: "工具边界", explanation: "宿主校验并执行工具。", workedExample: "拒绝缺少参数的调用。", practicePrompt: "练习",
      understandingChecks: [
        { id: "recall", prompt: "解释机制", expectedSignals: ["机制"] },
        { id: "apply", prompt: "迁移应用", expectedSignals: ["步骤"] },
      ],
      completionSignals: ["可解释"],
    });
    state = createStageNote(state, "stage-1", { title: "我的工具笔记", content: "人工结论：先定义执行边界。" }, new Date("2026-08-01T12:00:00.000Z"));
    state = appendStageNoteEvidence(state, "note-stage-1", new Date("2026-08-01T13:00:00.000Z"));

    expect(state.plan.notes?.[0]).toMatchObject({ title: "我的工具笔记", sourceDays: [1], updatedAt: "2026-08-01T13:00:00.000Z" });
    expect(state.plan.notes?.[0].content).toContain("人工结论：先定义执行边界。");
    expect(state.plan.notes?.[0].content).toContain("宿主校验并执行工具。");
    expect(() => appendStageNoteEvidence(state, "note-stage-1")).toThrow("没有可追加的新学习证据");
    expect(parseLearningState(JSON.stringify(state))).toMatchObject({ status: "valid" });
  });

  it("exports a stage note as Markdown and deletes only the selected note", () => {
    let state = initializeLearningState(generateLearningPlan(goal));
    state = createStageNote(state, "stage-1", { title: "工具/调用：速查", content: "人工结论：先定义执行边界。" }, new Date("2026-08-01T12:00:00.000Z"));
    const note = state.plan.notes![0];

    expect(stageNoteMarkdownFilename(note, new Date("2026-08-02T10:00:00.000Z"))).toBe("工具-调用-速查-2026-08-02.md");
    const markdown = serializeStageNoteMarkdown(state.plan, note.id, new Date("2026-08-02T10:00:00.000Z"));
    expect(markdown).toContain("# 工具/调用：速查");
    expect(markdown).toContain("> 学习目标：AI Agent 工程");
    expect(markdown).toContain("> 阶段：建立基础（第 1–3 周）");
    expect(markdown).toContain("> 来源学习日：无");
    expect(markdown).toContain("人工结论：先定义执行边界。");

    state = deleteStageNote(state, note.id);
    expect(state.plan.notes).toEqual([]);
    expect(state.days).toHaveLength(1);
    expect(() => deleteStageNote(state, note.id)).toThrow("学习笔记不存在");
  });

  it("generates an editable retrospective only after the stage is complete", () => {
    const shortGoal = { ...goal, durationWeeks: 1 };
    let state = initializeLearningState(generateLearningPlan(shortGoal));
    expect(() => generateStageRetrospective(state, "stage-1")).toThrow("完成这个阶段后");

    for (let day = 1; day <= 7; day += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      if (day === 3) {
        const practice = getCurrentRecord(state).tasks.find((task) => task.type === "practice")!;
        state = saveEvaluation(state, practice.id, "完成了带超时与恢复测试的 Agent 工具调用", {
          rubric: [
            { dimension: "understanding", score: 4, evidence: "能解释模型与宿主的执行边界", feedback: "继续" },
            { dimension: "application", score: 4, evidence: "能把超时策略应用到真实工具", feedback: "继续" },
            { dimension: "evidence", score: 3, evidence: "保留了失败恢复测试结果", feedback: "增加并发案例" },
            { dimension: "reflection", score: 2, evidence: "复盘较短", feedback: "补充取舍" },
          ],
          totalScore: 13, masteryLevel: "ready", misconceptions: [], nextAction: "把恢复策略迁移到下一阶段项目",
        });
      }
      state = completeCurrentDay(state, { difficulty: "just-right", reflection: day === 7 ? "继续验证迁移效果" : "" });
    }

    expect(stageMasteryReport(state, "stage-1")).toMatchObject({
      status: "developing", completedDays: 7, evaluationCount: 1, averageTotalScore: 13,
      nextAction: "把恢复策略迁移到下一阶段项目",
      dimensions: [
        { dimension: "understanding", averageScore: 4, status: "demonstrated" },
        { dimension: "application", averageScore: 4, status: "demonstrated" },
        { dimension: "evidence", averageScore: 3, status: "demonstrated" },
        { dimension: "reflection", averageScore: 2, status: "developing" },
      ],
    });
    const readyState = structuredClone(state);
    const readyEvaluation = Object.values(readyState.days[2].artifacts).find((artifact) => artifact.evaluation)?.evaluation!;
    readyEvaluation.rubric.find((score) => score.dimension === "reflection")!.score = 3;
    readyEvaluation.totalScore = 14;
    expect(stageMasteryReport(readyState, "stage-1")).toMatchObject({
      status: "ready", averageTotalScore: 14, headline: "现有成果证据支持进入下一阶段。",
    });
    expect(() => addStageMasteryTask(readyState, "stage-1")).toThrow("已经达到进入下一阶段");
    state = generateStageRetrospective(state, "stage-1", new Date("2026-08-01T12:00:00.000Z"));
    expect(state.plan.retrospectives?.[0]).toMatchObject({
      id: "retrospective-stage-1", stageId: "stage-1", sourceDays: [1, 2, 3, 4, 5, 6, 7],
      representativeArtifact: expect.stringContaining("带超时与恢复测试"),
      transferableSkills: expect.stringContaining("执行边界"),
      nextApplication: "把恢复策略迁移到下一阶段项目",
    });
    expect(() => generateStageRetrospective(state, "stage-1")).toThrow("已经有阶段回顾");

    state = updateStageRetrospective(state, "retrospective-stage-1", {
      goalReflection: "我已能独立完成阶段目标。",
      representativeArtifact: "工具调用演示与自动化测试。",
      transferableSkills: "定义边界、验证失败路径。",
      nextApplication: "用于下一阶段的 RAG 工具链。",
    }, new Date("2026-08-01T13:00:00.000Z"));
    expect(state.plan.retrospectives?.[0]).toMatchObject({ goalReflection: "我已能独立完成阶段目标。", updatedAt: "2026-08-01T13:00:00.000Z" });
    expect(parseLearningState(JSON.stringify(state)).status).toBe("valid");
    expect(serializeLearningProgressMarkdown(state)).toContain("- 可迁移能力：定义边界、验证失败路径。");
    expect(serializeLearningProgressMarkdown(state)).toContain("- 阶段掌握度：阶段已完成，但掌握证据仍需加强。 平均成果 13/16");
  });

  it("requires complete, four-dimensional evidence before marking a stage ready", () => {
    let state = initializeLearningState(generateLearningPlan({ ...goal, durationWeeks: 1 }));
    expect(() => stageMasteryReport(state, "stage-1")).toThrow("完成这个阶段后");
    for (let day = 1; day <= 7; day += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      state = completeCurrentDay(state, { difficulty: "just-right", reflection: "稳定推进" });
    }
    expect(stageMasteryReport(state, "stage-1")).toMatchObject({
      status: "insufficient-evidence", evaluationCount: 0, averageTotalScore: null,
      nextAction: "补充一份可验证的实践成果并获取四维评估。",
    });
    expect(() => addStageMasteryTask(state, "stage-1")).toThrow("请先创建新的学习日");
  });

  it("turns a non-ready stage checkpoint into one evaluated practice task", () => {
    let state = initializeLearningState(generateLearningPlan({ ...goal, durationWeeks: 2 }));
    for (let day = 1; day <= 7; day += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      if (day === 3) {
        const practice = getCurrentRecord(state).tasks.find((task) => task.type === "practice")!;
        state = saveEvaluation(state, practice.id, "恢复演练", {
          rubric: [
            { dimension: "understanding", score: 3, evidence: "解释了边界", feedback: "继续" },
            { dimension: "application", score: 2, evidence: "仅覆盖成功路径", feedback: "补失败路径" },
            { dimension: "evidence", score: 2, evidence: "缺少失败日志", feedback: "保留结果" },
            { dimension: "reflection", score: 2, evidence: "复盘较短", feedback: "补充取舍" },
          ],
          totalScore: 9, masteryLevel: "developing", misconceptions: [], nextAction: "验证失败恢复路径",
        });
      }
      state = completeCurrentDay(state, { difficulty: "just-right", reflection: "" });
    }

    state = addStageMasteryTask(state, "stage-1");
    const taskId = stageMasteryTaskId(8, "stage-1");
    expect(getCurrentRecord(state).tasks.at(-1)).toMatchObject({
      id: taskId,
      type: "practice",
      title: "阶段补强实践：建立基础",
      description: expect.stringContaining("验证失败恢复路径"),
      minutes: 12,
      completed: false,
    });
    expect(getCurrentRecord(state).tasks.reduce((sum, task) => sum + task.minutes, 0)).toBe(60);
    expect(getCurrentRecord(state).artifacts[taskId].stageMasteryRemediation).toEqual({
      stageId: "stage-1",
      sourceDay: 3,
      sourceTaskId: "day-3-practice",
      sourceNextAction: "验证失败恢复路径",
    });
    expect(addStageMasteryTask(state, "stage-1")).toEqual(state);

    state = saveEvaluation(state, taskId, "补充了失败恢复测试、日志和复盘", {
      rubric: [
        { dimension: "understanding", score: 4, evidence: "解释失败边界", feedback: "继续" },
        { dimension: "application", score: 4, evidence: "覆盖失败恢复", feedback: "继续" },
        { dimension: "evidence", score: 4, evidence: "保留日志", feedback: "继续" },
        { dimension: "reflection", score: 4, evidence: "说明取舍", feedback: "继续" },
      ],
      totalScore: 16, masteryLevel: "ready", misconceptions: [], nextAction: "迁移到下一阶段",
    });
    expect(stageMasteryReport(state, "stage-1")).toMatchObject({
      status: "ready",
      evaluationCount: 2,
      averageTotalScore: 12.5,
      latestRemediation: {
        taskId,
        remediationDay: 8,
        sourceDay: 3,
        sourceTaskId: "day-3-practice",
        sourceNextAction: "验证失败恢复路径",
        statusBefore: "developing",
        statusAfter: "ready",
        averageTotalScoreBefore: 9,
        averageTotalScoreAfter: 12.5,
      },
    });
    expect(parseLearningState(JSON.stringify(state)).status).toBe("valid");
    expect(serializeLearningProgressMarkdown(state)).toContain("- 最近补强来源：第 3 天 · 验证失败恢复路径");
    expect(serializeLearningProgressMarkdown(state)).toContain("- 补强后变化：平均成果 9 → 12.5/16");
    const invalidSource = structuredClone(state);
    invalidSource.days[7].artifacts[taskId].stageMasteryRemediation!.stageId = "missing-stage";
    expect(parseLearningState(JSON.stringify(invalidSource)).status).not.toBe("valid");
  });

  it("opens a validated follow-up day when the final stage still needs evidence", () => {
    let state = initializeLearningState(generateLearningPlan({ ...goal, durationWeeks: 1 }));
    for (let day = 1; day <= 7; day += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      if (day === 3) {
        const practice = getCurrentRecord(state).tasks.find((task) => task.type === "practice")!;
        state = saveEvaluation(state, practice.id, "只验证了成功路径", {
          rubric: [
            { dimension: "understanding", score: 3, evidence: "解释边界", feedback: "继续" },
            { dimension: "application", score: 2, evidence: "只有成功路径", feedback: "补失败路径" },
            { dimension: "evidence", score: 2, evidence: "缺少日志", feedback: "保留结果" },
            { dimension: "reflection", score: 2, evidence: "复盘较短", feedback: "补充取舍" },
          ],
          totalScore: 9, masteryLevel: "developing", misconceptions: [], nextAction: "验证最终阶段的失败恢复路径",
        });
      }
      state = completeCurrentDay(state, { difficulty: "just-right", reflection: "" });
    }

    expect(isLearningPlanComplete(state)).toBe(true);
    state = startStageMasteryFollowUp(state, "stage-1", new Date("2026-08-10T10:00:00.000Z"));
    expect(state.currentDay).toBe(8);
    expect(isLearningPlanComplete(state)).toBe(false);
    expect(getCurrentRecord(state).date).toBe("2026-08-10");
    expect(getCurrentRecord(state).tasks).toContainEqual(expect.objectContaining({
      id: "day-8-stage-mastery-stage-1",
      title: "阶段补强实践：建立基础",
      description: expect.stringContaining("验证最终阶段的失败恢复路径"),
    }));
    expect(parseLearningState(JSON.stringify(state))).toMatchObject({ status: "valid", state: { currentDay: 8 } });

    state = saveEvaluation(state, "day-8-stage-mastery-stage-1", "补充了失败路径但证据仍不完整", {
      rubric: [
        { dimension: "understanding", score: 3, evidence: "解释失败边界", feedback: "继续" },
        { dimension: "application", score: 3, evidence: "覆盖失败路径", feedback: "继续" },
        { dimension: "evidence", score: 2, evidence: "日志不完整", feedback: "补充日志" },
        { dimension: "reflection", score: 2, evidence: "取舍不完整", feedback: "补充取舍" },
      ],
      totalScore: 10, masteryLevel: "developing", misconceptions: [], nextAction: "补全失败日志和取舍",
    });
    for (const task of getCurrentRecord(state).tasks.filter((task) => !task.completed)) state = toggleCurrentTask(state, task.id);
    state = completeCurrentDay(state, { difficulty: "just-right", reflection: "补强完成" });
    expect(isLearningPlanComplete(state)).toBe(true);
    expect(parseLearningState(JSON.stringify(state))).toMatchObject({ status: "valid", state: { currentDay: 8 } });

    state = startStageMasteryFollowUp(state, "stage-1", new Date("2026-08-11T10:00:00.000Z"));
    expect(state.days[8].artifacts["day-9-stage-mastery-stage-1"].stageMasteryRemediation).toMatchObject({
      sourceDay: 8,
      sourceTaskId: "day-8-stage-mastery-stage-1",
      sourceNextAction: "补全失败日志和取舍",
    });
    expect(parseLearningState(JSON.stringify(state))).toMatchObject({ status: "valid", state: { currentDay: 9 } });

    const invalid = structuredClone(state);
    delete invalid.days[8].artifacts["day-9-stage-mastery-stage-1"].stageMasteryRemediation;
    expect(parseLearningState(JSON.stringify(invalid)).status).toBe("recovered");
  });

  it("separates schedule completion from goal-level mastery and prioritizes missing evidence", () => {
    let state = initializeLearningState(generateLearningPlan({ ...goal, durationWeeks: 2 }));
    for (let day = 1; day <= 14; day += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      if (day === 10) {
        const practice = getCurrentRecord(state).tasks.find((task) => task.type === "practice")!;
        state = saveEvaluation(state, practice.id, "完整的迁移成果", {
          rubric: [
            { dimension: "understanding", score: 4, evidence: "解释完整", feedback: "继续" },
            { dimension: "application", score: 4, evidence: "应用完整", feedback: "继续" },
            { dimension: "evidence", score: 4, evidence: "证据完整", feedback: "继续" },
            { dimension: "reflection", score: 4, evidence: "复盘完整", feedback: "继续" },
          ],
          totalScore: 16, masteryLevel: "ready", misconceptions: [], nextAction: "继续迁移",
        });
      }
      state = completeCurrentDay(state, { difficulty: "just-right", reflection: "" });
    }

    expect(isLearningPlanComplete(state)).toBe(true);
    expect(goalMasteryReport(state)).toEqual({
      status: "insufficient-evidence",
      totalStages: 2,
      completedStages: 2,
      readyStages: 1,
      headline: "计划日程已完成，但至少一个阶段仍缺少经过评估的成果证据。",
      priorityStageId: "stage-1",
      priorityStageTitle: "建立基础",
      nextAction: "补充一份可验证的实践成果并获取四维评估。",
    });
    const markdown = serializeLearningProgressMarkdown(state);
    expect(markdown).toContain("## 目标掌握度");
    expect(markdown).toContain("- 已达标阶段：1/2");
    expect(markdown).toContain("- 优先阶段：建立基础");
  });

  it("exports a completed goal evidence report with stage-level audit details", () => {
    let state = initializeLearningState(generateLearningPlan({ ...goal, durationWeeks: 1 }));
    for (let day = 1; day <= 7; day += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      if (day === 3) {
        const practice = getCurrentRecord(state).tasks.find((task) => task.type === "practice")!;
        state = saveEvaluation(state, practice.id, "可验证成果", {
          rubric: [
            { dimension: "understanding", score: 3, evidence: "解释完整", feedback: "继续" },
            { dimension: "application", score: 3, evidence: "完成应用", feedback: "继续" },
            { dimension: "evidence", score: 3, evidence: "保留结果", feedback: "继续" },
            { dimension: "reflection", score: 3, evidence: "说明取舍", feedback: "继续" },
          ],
          totalScore: 12, masteryLevel: "developing", misconceptions: [], nextAction: "增加一个边界案例",
        });
      }
      state = completeCurrentDay(state, { difficulty: "just-right", reflection: "完成" });
    }
    state.plan.retrospectives = [{
      id: "retro-stage-1",
      stageId: "stage-1",
      goalReflection: "完成了基础闭环",
      representativeArtifact: "可验证成果",
      transferableSkills: "拆解与验证",
      nextApplication: "迁移到真实项目",
      sourceDays: [3],
      updatedAt: "2026-08-03T12:00:00.000Z",
    }];
    const now = new Date("2026-08-03T15:00:00.000Z");
    const markdown = serializeGoalCompletionMarkdown(state, now);

    expect(goalCompletionMarkdownFilename(state, now)).toBe("AI-Agent-工程-goal-evidence-2026-08-03.md");
    expect(markdown).toContain("# AI Agent 工程 目标证据报告");
    expect(markdown).toContain("计划完成，全部阶段证据达标");
    expect(markdown).toContain("- 四维证据：理解 3/4（1 份）；应用 3/4（1 份）；证据 3/4（1 份）；反思 3/4（1 份）");
    expect(markdown).toContain("- 代表成果：可验证成果");
    expect(markdown).toContain("- 可迁移能力：拆解与验证");
    expect(markdown).toContain("### 成果证据明细");
    expect(markdown).toContain("#### 第 3 天 · 完成递进实践");
    expect(markdown).toContain("- 成果提交：可验证成果");
    expect(markdown).toContain("- 理解 3/4：证据“解释完整”；反馈“继续”");
    expect(markdown).toContain("- 最小下一步：增加一个边界案例");
  });

  it("attributes remediation evidence to its source stage exactly once", () => {
    let state = initializeLearningState(generateLearningPlan({ ...goal, durationWeeks: 2 }));
    for (let day = 1; day <= 14; day += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      if (day === 3 || day === 10) {
        const practice = getCurrentRecord(state).tasks.find((task) => task.type === "practice")!;
        state = saveEvaluation(state, practice.id, `第 ${day} 天成果`, {
          rubric: [
            { dimension: "understanding", score: day === 3 ? 2 : 4, evidence: "理解证据", feedback: "继续" },
            { dimension: "application", score: day === 3 ? 2 : 4, evidence: "应用证据", feedback: "继续" },
            { dimension: "evidence", score: day === 3 ? 2 : 4, evidence: "结果证据", feedback: "继续" },
            { dimension: "reflection", score: day === 3 ? 2 : 4, evidence: "反思证据", feedback: "继续" },
          ],
          totalScore: day === 3 ? 8 : 16,
          masteryLevel: day === 3 ? "developing" : "ready",
          misconceptions: [],
          nextAction: day === 3 ? "补强第一阶段" : "继续迁移",
        });
      }
      state = completeCurrentDay(state, { difficulty: "just-right", reflection: "完成" });
    }
    state = startStageMasteryFollowUp(state, "stage-1");
    const remediation = getCurrentRecord(state).tasks.find((task) => task.id === stageMasteryTaskId(15, "stage-1"))!;
    state = saveEvaluation(state, remediation.id, "第一阶段补强成果", {
      rubric: [
        { dimension: "understanding", score: 4, evidence: "补强理解", feedback: "继续" },
        { dimension: "application", score: 4, evidence: "补强应用", feedback: "继续" },
        { dimension: "evidence", score: 4, evidence: "补强结果", feedback: "继续" },
        { dimension: "reflection", score: 4, evidence: "补强反思", feedback: "继续" },
      ],
      totalScore: 16, masteryLevel: "ready", misconceptions: [], nextAction: "第一阶段已补强",
    });

    expect(stageMasteryReport(state, "stage-1")).toMatchObject({ evaluationCount: 2, averageTotalScore: 12 });
    expect(stageMasteryReport(state, "stage-2")).toMatchObject({ evaluationCount: 1, averageTotalScore: 16 });
    for (const task of getCurrentRecord(state).tasks.filter((task) => !task.completed)) state = toggleCurrentTask(state, task.id);
    state = completeCurrentDay(state, { difficulty: "just-right", reflection: "补强完成" });
    const markdown = serializeGoalCompletionMarkdown(state);
    expect(markdown.match(/成果提交：第一阶段补强成果/g)).toHaveLength(1);
  });

  it("does not create a completion report before the planned schedule is complete", () => {
    const state = initializeLearningState(generateLearningPlan(goal));
    expect(() => serializeGoalCompletionMarkdown(state)).toThrow("学习计划尚未完成");
  });

  it("uses persisted evaluation feedback to focus the next day", () => {
    let state = completedState();
    const task = getCurrentRecord(state).tasks.find((item) => item.type === "practice")!;
    state = saveEvaluation(state, task.id, "可复查的学习成果", {
      rubric: [
        { dimension: "understanding", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "application", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "evidence", score: 1, evidence: "证据", feedback: "反馈" },
        { dimension: "reflection", score: 2, evidence: "证据", feedback: "反馈" },
      ],
      totalScore: 7,
      masteryLevel: "needs-support",
      misconceptions: ["忽略超时"],
      nextAction: "补充失败恢复测试",
    });
    state = completeCurrentDay(state, { difficulty: "too-hard", reflection: "" });

    expect(state.days[1].tasks[1].description).toContain("补充失败恢复测试");
    expect(state.days[1].tasks[1].description).toContain("忽略超时");
  });

  it("schedules the first weak evaluator review for the next day", () => {
    let state = completedState();
    const task = getCurrentRecord(state).tasks.find((item) => item.type === "practice")!;
    state = saveEvaluation(state, task.id, "可复查的学习成果", {
      rubric: [
        { dimension: "understanding", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "application", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "evidence", score: 1, evidence: "证据", feedback: "反馈" },
        { dimension: "reflection", score: 2, evidence: "证据", feedback: "反馈" },
      ],
      totalScore: 7,
      masteryLevel: "needs-support",
      misconceptions: ["忽略超时"],
      nextAction: "补充失败恢复测试",
    });

    expect(dueReviewItems(state, 2)).toEqual([{
      sourceDay: 1,
      misconceptions: ["忽略超时"],
      nextAction: "补充失败恢复测试",
    }]);
    expect(dueReviewItems(state, 3)).toEqual([]);
    expect(dueReviewItems(state, 4)).toEqual([]);
    expect(dueReviewItems(state, 8)).toEqual([]);
    expect(dueReviewItems(state, 9)).toEqual([]);

    state = completeCurrentDay(state, { difficulty: "too-hard", reflection: "继续检查恢复路径" });
    const reviewTask = getCurrentRecord(state).tasks.find((item) => item.type === "diagnose")!;
    expect(reviewTask.title).toBe("间隔复习与主动检索");
    expect(reviewTask.description).toContain("第 1 天");
    expect(reviewTask.description).toContain("忽略超时");
    expect(reviewTask.description).toContain("补充失败恢复测试");
  });

  it("does not schedule review for strong evaluations without misconceptions", () => {
    let state = completedState();
    const task = getCurrentRecord(state).tasks.find((item) => item.type === "practice")!;
    state = saveEvaluation(state, task.id, "完整成果", {
      rubric: [
        { dimension: "understanding", score: 4, evidence: "证据", feedback: "反馈" },
        { dimension: "application", score: 4, evidence: "证据", feedback: "反馈" },
        { dimension: "evidence", score: 4, evidence: "证据", feedback: "反馈" },
        { dimension: "reflection", score: 4, evidence: "证据", feedback: "反馈" },
      ],
      totalScore: 16,
      masteryLevel: "ready",
      misconceptions: [],
      nextAction: "进入下一项挑战",
    });

    expect(dueReviewItems(state, 2)).toEqual([]);
  });

  it("adapts the next review interval to recorded recall performance", () => {
    let state = completedState();
    const task = getCurrentRecord(state).tasks.find((item) => item.type === "practice")!;
    state = saveEvaluation(state, task.id, "成果", {
      rubric: [
        { dimension: "understanding", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "application", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "evidence", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "reflection", score: 2, evidence: "证据", feedback: "反馈" },
      ],
      totalScore: 8,
      masteryLevel: "developing",
      misconceptions: [],
      nextAction: "解释失败恢复机制",
    });
    state = completeCurrentDay(state, { difficulty: "just-right", reflection: "" });
    const reviewTask = getCurrentRecord(state).tasks.find((item) => item.type === "diagnose")!;

    state = saveReviewPerformance(state, reviewTask.id, "effortful");

    expect(getCurrentRecord(state).artifacts[reviewTask.id].reviewPerformance).toEqual({ sourceDays: [1], recall: "effortful" });
    expect(dueReviewItems(state, 3)).toEqual([]);
    expect(dueReviewItems(state, 4)).toEqual([]);
    expect(dueReviewItems(state, 5)).toHaveLength(1);
  });

  it("persists an automatic active-recall assessment and uses it for scheduling", () => {
    let state = completedState();
    const task = getCurrentRecord(state).tasks.find((item) => item.type === "practice")!;
    state = saveEvaluation(state, task.id, "成果", {
      rubric: [
        { dimension: "understanding", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "application", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "evidence", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "reflection", score: 2, evidence: "证据", feedback: "反馈" },
      ],
      totalScore: 8, masteryLevel: "developing", misconceptions: ["混淆重试与恢复"], nextAction: "画出恢复路径",
    });
    state = completeCurrentDay(state, { difficulty: "just-right", reflection: "" });
    const reviewTask = getCurrentRecord(state).tasks.find((item) => item.type === "diagnose")!;
    state = saveReviewAssessment(state, reviewTask.id, {
      answer: "  重试再次执行，恢复从检查点继续。  ", score: 3, recall: "effortful",
      evidence: "区分了重试与恢复", feedback: "补充恢复失败分支。",
    });

    expect(getCurrentRecord(state).artifacts[reviewTask.id].reviewPerformance).toEqual({
      sourceDays: [1], recall: "effortful",
      assessment: { answer: "重试再次执行，恢复从检查点继续。", score: 3, recall: "effortful", evidence: "区分了重试与恢复", feedback: "补充恢复失败分支。" },
    });
    expect(parseLearningState(JSON.stringify(state)).status).toBe("valid");
    expect(dueReviewItems(state, 5)).toHaveLength(1);
    expect(() => saveReviewAssessment(state, reviewTask.id, { answer: "回答", score: 4, recall: "forgot", evidence: "证据", feedback: "反馈" })).toThrow("分数与回忆表现不一致");
  });

  it("retries forgotten reviews tomorrow and expands repeated easy recall up to 14 days", () => {
    let state = completedState();
    const task = getCurrentRecord(state).tasks.find((item) => item.type === "practice")!;
    state = saveEvaluation(state, task.id, "成果", {
      rubric: [
        { dimension: "understanding", score: 1, evidence: "证据", feedback: "反馈" },
        { dimension: "application", score: 1, evidence: "证据", feedback: "反馈" },
        { dimension: "evidence", score: 1, evidence: "证据", feedback: "反馈" },
        { dimension: "reflection", score: 1, evidence: "证据", feedback: "反馈" },
      ],
      totalScore: 4,
      masteryLevel: "needs-support",
      misconceptions: ["混淆重试与恢复"],
      nextAction: "画出恢复路径",
    });
    state = completeCurrentDay(state, { difficulty: "too-hard", reflection: "" });
    let reviewTask = getCurrentRecord(state).tasks.find((item) => item.type === "diagnose")!;
    state = saveReviewPerformance(state, reviewTask.id, "forgot");
    expect(dueReviewItems(state, 3)).toHaveLength(1);

    state = { ...state, currentDay: 3, days: [...state.days, {
      day: 3, date: "2026-08-01", status: "active", artifacts: {},
      tasks: state.days[1].tasks.map((item) => ({ ...item, id: item.id.replace("day-2", "day-3"), completed: false })),
    }] };
    reviewTask = getCurrentRecord(state).tasks.find((item) => item.type === "diagnose")!;
    state = saveReviewPerformance(state, reviewTask.id, "easy");
    expect(dueReviewItems(state, 10)).toHaveLength(1);
    expect(dueReviewItems(state, 4)).toEqual([]);

    state = { ...state, currentDay: 10, days: [...state.days, {
      day: 10, date: "2026-08-08", status: "active", artifacts: {},
      tasks: state.days[1].tasks.map((item) => ({ ...item, id: item.id.replace("day-2", "day-10"), completed: false })),
    }] };
    reviewTask = getCurrentRecord(state).tasks.find((item) => item.type === "diagnose")!;
    state = saveReviewPerformance(state, reviewTask.id, "easy");
    expect(dueReviewItems(state, 24)).toHaveLength(1);
  });

  it("previews due and upcoming reviews without extending beyond the plan", () => {
    let state = completedState();
    const task = getCurrentRecord(state).tasks.find((item) => item.type === "practice")!;
    state = saveEvaluation(state, task.id, "成果", {
      rubric: [
        { dimension: "understanding", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "application", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "evidence", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "reflection", score: 2, evidence: "证据", feedback: "反馈" },
      ],
      totalScore: 8,
      masteryLevel: "developing",
      misconceptions: ["混淆重试与恢复"],
      nextAction: "画出恢复路径",
    });
    state = completeCurrentDay(state, { difficulty: "just-right", reflection: "" });

    expect(scheduledReviewItems(state)).toEqual([{
      sourceDay: 1,
      dueDay: 2,
      misconceptions: ["混淆重试与恢复"],
      nextAction: "画出恢复路径",
    }]);

    const reviewTask = getCurrentRecord(state).tasks.find((item) => item.type === "diagnose")!;
    state = saveReviewPerformance(state, reviewTask.id, "easy");
    expect(scheduledReviewItems(state)).toEqual([{
      sourceDay: 1,
      dueDay: 9,
      misconceptions: ["混淆重试与恢复"],
      nextAction: "画出恢复路径",
    }]);
    expect(() => scheduledReviewItems(state, -1)).toThrow("复习预览天数必须是非负整数");
  });

  it("links a normalized misconception only after it recurs across distinct stages", () => {
    let state = initializeLearningState(generateLearningPlan({ ...goal, durationWeeks: 2 }));
    for (let day = 1; day <= 8; day += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      if (day === 1 || day === 8) {
        const practice = getCurrentRecord(state).tasks.find((task) => task.type === "practice")!;
        state = saveEvaluation(state, practice.id, `第 ${day} 天成果`, {
          rubric: [
            { dimension: "understanding", score: 2, evidence: "证据", feedback: "反馈" },
            { dimension: "application", score: 2, evidence: "证据", feedback: "反馈" },
            { dimension: "evidence", score: 2, evidence: "证据", feedback: "反馈" },
            { dimension: "reflection", score: 2, evidence: "证据", feedback: "反馈" },
          ],
          totalScore: 8,
          masteryLevel: "developing",
          misconceptions: [day === 1 ? "混淆重试与恢复" : " 混淆重试与恢复。 "],
          nextAction: day === 1 ? "画出失败路径" : "验证恢复检查点",
        });
      }
      state = completeCurrentDay(state, { difficulty: "just-right", reflection: "" });
    }

    expect(crossStageMisconceptionInsights(state)).toEqual([{
      misconception: "混淆重试与恢复",
      occurrences: [
        { stageId: "stage-1", stageTitle: "建立基础", sourceDays: [1], nextActions: ["画出失败路径"] },
        { stageId: "stage-2", stageTitle: "构建知识增强应用", sourceDays: [8], nextActions: ["验证恢复检查点"] },
      ],
      reviewPrompt: "不查资料，比较「建立基础」、「构建知识增强应用」中的相关案例：解释“混淆重试与恢复”为什么不成立，并分别给出正确判断与一个可验证例子。",
    }]);
    expect(serializeLearningProgressMarkdown(state)).toContain("## 跨阶段重复误解");
    expect(serializeLearningProgressMarkdown(state)).toContain("建立基础（第 1 天）；构建知识增强应用（第 8 天）");

    state = addCrossStageReviewTask(state, " 混淆重试与恢复。 ");
    const taskId = crossStageReviewTaskId(9, "混淆重试与恢复");
    expect(getCurrentRecord(state).tasks.at(-1)).toMatchObject({
      id: taskId,
      type: "diagnose",
      completed: false,
      title: "跨阶段主动回忆：混淆重试与恢复",
    });
    expect(addCrossStageReviewTask(state, "混淆重试与恢复")).toEqual(state);

    state = saveCrossStageReviewAssessment(state, taskId, "混淆重试与恢复", {
      answer: "  重试再次执行，恢复从检查点继续。  ",
      score: 4,
      recall: "easy",
      evidence: "比较了两个阶段的恢复路径",
      feedback: "再验证一个失败分支",
    });
    expect(getCurrentRecord(state).artifacts[taskId].reviewPerformance).toEqual({
      sourceDays: [1, 8],
      recall: "easy",
      assessment: {
        answer: "重试再次执行，恢复从检查点继续。",
        score: 4,
        recall: "easy",
        evidence: "比较了两个阶段的恢复路径",
        feedback: "再验证一个失败分支",
      },
    });
  });

  it("preserves prior history while advancing consecutive days", () => {
    let state = completeCurrentDay(completedState(), { difficulty: "just-right", reflection: "" });
    for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
    state = completeCurrentDay(state, { difficulty: "too-easy", reflection: "增加真实约束" });

    expect(state.currentDay).toBe(3);
    expect(completedDayCount(state)).toBe(2);
    expect(learningStreak(state)).toBe(2);
    expect(state.days.map((day) => day.day)).toEqual([1, 2, 3]);
  });

  it("does not reopen a completed final day", () => {
    const plan = generateLearningPlan({ ...goal, durationWeeks: 1 });
    let state = initializeLearningState(plan);
    state = { ...state, currentDay: 7, days: [{ ...state.days[0], day: 7, tasks: state.days[0].tasks.map((task) => ({ ...task, completed: true })) }] };
    state = completeCurrentDay(state, { difficulty: "just-right", reflection: "完成" });

    expect(state.currentDay).toBe(7);
    expect(getCurrentRecord(state).status).toBe("completed");
    expect(toggleCurrentTask(state, getCurrentRecord(state).tasks[0].id)).toBe(state);
  });
});
