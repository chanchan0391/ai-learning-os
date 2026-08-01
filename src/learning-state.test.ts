import { describe, expect, it } from "vitest";
import {
  appendStageNoteEvidence,
  completeTeachingTask,
  completeCurrentDay,
  completedDayCount,
  createStageNote,
  createLearningStateExport,
  detectLearningInterruption,
  dueReviewItems,
  generateStageNote,
  getCurrentRecord,
  initializeLearningState,
  learningStateExportFilename,
  learningStreak,
  parseLearningState,
  parseLearningStateExport,
  saveEvaluation,
  saveReviewPerformance,
  saveTeachingSession,
  saveUnderstandingResponse,
  serializeLearningStateExport,
  toggleCurrentTask,
  updateStageNote,
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
