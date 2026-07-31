import { describe, expect, it } from "vitest";
import {
  completeTeachingTask,
  completeCurrentDay,
  completedDayCount,
  createLearningStateExport,
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
