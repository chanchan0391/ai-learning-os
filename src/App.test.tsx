// @vitest-environment jsdom

import axe from "axe-core";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  completeCurrentDay,
  getCurrentRecord,
  initializeLearningState,
  saveEvaluation,
  saveTeachingSession,
  serializeLearningStateExport,
  toggleCurrentTask,
} from "./learning-state";
import { generateLearningPlan } from "./planner";

const STORAGE_KEY = "ai-learning-os-state-v3";
const ARCHIVE_KEY = "ai-learning-os-archived-states-v1";
const ACTIVE_STATES_KEY = "ai-learning-os-active-states-v1";
const DAILY_BUDGET_KEY = "ai-learning-os-portfolio-daily-budget-v1";
const goal = {
  subject: "AI Agent 工程",
  currentLevel: "Java 高级工程师",
  targetOutcome: "独立交付企业级 Agent 应用",
  dailyMinutes: 60,
  durationWeeks: 12,
};

function saveTestState() {
  const plan = generateLearningPlan(goal, new Date("2026-07-31T10:00:00.000Z"));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(initializeLearningState(plan)));
}

describe("learning data controls", () => {
  beforeEach(() => {
    localStorage.clear();
    saveTestState();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the active learning dashboard without detectable accessibility violations", async () => {
    const { container } = render(<App />);

    expect(screen.getByRole("heading", { name: goal.subject })).toBeTruthy();
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations).toEqual([]);
  });

  it("switches between parallel active goals without losing either plan", async () => {
    const user = userEvent.setup();
    const first = initializeLearningState(generateLearningPlan(goal, new Date("2026-07-31T10:00:00.000Z")));
    const second = initializeLearningState(generateLearningPlan({ ...goal, subject: "分布式系统" }, new Date("2026-08-01T10:00:00.000Z")));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(first));
    localStorage.setItem(ACTIVE_STATES_KEY, JSON.stringify({ selectedPlanId: first.plan.id, states: [first, second] }));
    render(<App />);

    expect(screen.getByRole("heading", { name: goal.subject, level: 1 })).toBeTruthy();
    expect(screen.getByText("2 个目标 · 今日 0/8 项 · 剩余 120 分钟 · 0 个需关注")).toBeTruthy();
    const portfolioReview = screen.getByRole("region", { name: "跨目标周回顾" });
    expect(within(portfolioReview).getByText("本周跨目标证据尚未形成。", { exact: false })).toBeTruthy();
    expect(within(portfolioReview).getByText("完成任一目标的首个学习日后，这里会给出投入分配与风险建议。")).toBeTruthy();
    const firstSummary = screen.getByLabelText(`${goal.subject}目标摘要`);
    expect(within(firstSummary).getByText("0/4 项 · 剩余 60 分钟", { exact: false })).toBeTruthy();
    expect(within(firstSummary).getByText("当前节奏稳定")).toBeTruthy();
    expect(within(firstSummary).getByText("尚未完成首个学习日")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "切换" }));

    expect(screen.getByRole("heading", { name: "分布式系统", level: 1 })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(ACTIVE_STATES_KEY)!).selectedPlanId).toBe(second.plan.id);
    expect(JSON.parse(localStorage.getItem(ACTIVE_STATES_KEY)!).states).toHaveLength(2);
  });

  it("starts a parallel goal while preserving existing active progress", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "新建并行目标" }));

    expect(screen.getByRole("button", { name: /生成我的学习路线/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "进行中的目标" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开目标" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(ACTIVE_STATES_KEY)!).states).toHaveLength(1);
  });

  it("persists a cross-goal daily budget and warns when scheduled work exceeds it", async () => {
    const user = userEvent.setup();
    const first = initializeLearningState(generateLearningPlan(goal));
    const second = initializeLearningState(generateLearningPlan({ ...goal, subject: "分布式系统", dailyMinutes: 45 }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(first));
    localStorage.setItem(ACTIVE_STATES_KEY, JSON.stringify({ selectedPlanId: first.plan.id, states: [first, second] }));
    render(<App />);

    await user.clear(screen.getByRole("spinbutton", { name: "跨目标每日总时间预算" }));
    await user.type(screen.getByRole("spinbutton", { name: "跨目标每日总时间预算" }), "90");
    await user.click(screen.getByRole("button", { name: "保存预算" }));

    expect(screen.getByText("今日计划 105 分钟，超出预算 15 分钟。优先保留需关注目标和最小学习闭环。")).toBeTruthy();
    expect(localStorage.getItem(DAILY_BUDGET_KEY)).toBe("90");

    await user.click(screen.getByRole("button", { name: "清除" }));
    expect(localStorage.getItem(DAILY_BUDGET_KEY)).toBeNull();
  });

  it("turns the cross-goal budget into an actionable daily agenda", async () => {
    const user = userEvent.setup();
    const first = initializeLearningState(generateLearningPlan(goal));
    const second = initializeLearningState(generateLearningPlan({ ...goal, subject: "分布式系统", dailyMinutes: 30 }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(first));
    localStorage.setItem(ACTIVE_STATES_KEY, JSON.stringify({ selectedPlanId: first.plan.id, states: [first, second] }));
    localStorage.setItem(DAILY_BUDGET_KEY, "30");
    render(<App />);

    const agenda = screen.getByRole("region", { name: "今日跨目标清单" });
    expect(within(agenda).getByText("按 30 分钟预算安排")).toBeTruthy();
    expect(within(agenda).getByText(/分钟已安排 · .*分钟留待后续/)).toBeTruthy();
    expect(within(agenda).getAllByRole("listitem").length).toBeGreaterThan(0);
    await user.click(within(agenda).getAllByRole("button", { name: "打开任务" })[0]);

    expect(screen.getByRole("heading", { name: "分布式系统", level: 1 })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(ACTIVE_STATES_KEY)!).selectedPlanId).toBe(second.plan.id);
  });

  it("opens the goal prioritized by the cross-goal weekly review", async () => {
    const user = userEvent.setup();
    let first = initializeLearningState(generateLearningPlan(goal, new Date("2026-08-02T08:00:00.000Z")));
    for (const task of getCurrentRecord(first).tasks) first = toggleCurrentTask(first, task.id);
    first = completeCurrentDay(first, { difficulty: "just-right", reflection: "完成闭环" }, new Date("2026-08-02T10:00:00.000Z"));
    const second = initializeLearningState(generateLearningPlan({ ...goal, subject: "分布式系统" }, new Date("2026-08-02T08:00:00.000Z")));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(first));
    localStorage.setItem(ACTIVE_STATES_KEY, JSON.stringify({ selectedPlanId: first.plan.id, states: [first, second] }));
    render(<App />);

    const review = screen.getByRole("region", { name: "跨目标周回顾" });
    expect(within(review).getByText("“分布式系统”本周尚未投入，先完成一次最小学习闭环。")).toBeTruthy();
    await user.click(within(review).getByRole("button", { name: "打开本周优先目标" }));

    expect(screen.getByRole("heading", { name: "分布式系统", level: 1 })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(ACTIVE_STATES_KEY)!).selectedPlanId).toBe(second.plan.id);
  });

  it("downloads the cross-goal weekly review as Markdown", async () => {
    const user = userEvent.setup();
    const downloads: string[] = [];
    const first = initializeLearningState(generateLearningPlan(goal));
    const second = initializeLearningState(generateLearningPlan({ ...goal, subject: "分布式系统" }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(first));
    localStorage.setItem(ACTIVE_STATES_KEY, JSON.stringify({ selectedPlanId: first.plan.id, states: [first, second] }));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:portfolio-review") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) { downloads.push(this.download); });
    render(<App />);

    await user.click(screen.getByRole("button", { name: "导出跨目标周回顾" }));

    expect(downloads).toEqual([expect.stringMatching(/^ai-learning-os-cross-goal-weekly-review-\d{4}-\d{2}-\d{2}\.md$/)]);
    expect(screen.getByText("已导出跨目标周回顾 Markdown。")).toBeTruthy();
  });

  it("archives a completed goal and returns to goal creation without losing its history", async () => {
    const user = userEvent.setup();
    let state = initializeLearningState(generateLearningPlan({ ...goal, durationWeeks: 1 }));
    for (let index = 0; index < 7; index += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      state = completeCurrentDay(state, { difficulty: "just-right", reflection: `完成第 ${index + 1} 天` }, new Date(`2026-08-0${index + 1}T10:00:00.000Z`));
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "归档已完成目标" }));
    await user.click(screen.getByRole("button", { name: "确认归档" }));

    expect(screen.getByRole("heading", { name: "已完成目标" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /生成我的学习路线/ })).toBeTruthy();
    expect(screen.getByText("7 个完成日", { exact: false })).toBeTruthy();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(ARCHIVE_KEY)!)[0].state.plan.id).toBe(state.plan.id);

    await user.click(screen.getByRole("button", { name: "恢复查看" }));
    expect(screen.getByRole("heading", { name: goal.subject })).toBeTruthy();
    expect(localStorage.getItem(ARCHIVE_KEY)).toBeNull();
  });

  it("shows a weekly evidence review with a concrete next action", () => {
    let state = initializeLearningState(generateLearningPlan(goal));
    for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
    const practice = getCurrentRecord(state).tasks.find((task) => task.type === "practice")!;
    state = saveEvaluation(state, practice.id, "可验证成果", {
      rubric: [
        { dimension: "understanding", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "application", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "evidence", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "reflection", score: 2, evidence: "证据", feedback: "反馈" },
      ],
      totalScore: 8,
      masteryLevel: "developing",
      misconceptions: [],
      nextAction: "独立解释关键机制",
    });
    state = completeCurrentDay(state, { difficulty: "just-right", reflection: "" });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

    render(<App />);

    const review = screen.getByRole("region", { name: "学习周回顾" });
    expect(within(review).getByText("60")).toBeTruthy();
    expect(within(review).getByText("8/16")).toBeTruthy();
    expect(within(review).getByText("独立解释关键机制")).toBeTruthy();
    expect(within(review).getByText("周期趋势正在形成")).toBeTruthy();
    expect(within(review).getByText("完成至少 4 个学习日后，这里会显示等长周期趋势。")).toBeTruthy();
  });

  it("shows an improving equal-window trend after four completed learning days", () => {
    let state = initializeLearningState(generateLearningPlan(goal));
    for (let index = 0; index < 4; index += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      state = completeCurrentDay(
        state,
        { difficulty: index < 2 ? "too-hard" : "just-right", reflection: `复盘 ${index + 1}` },
        new Date(`2026-08-0${index + 2}T10:00:00.000Z`),
      );
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

    render(<App />);

    const review = screen.getByRole("region", { name: "学习周回顾" });
    expect(within(review).getByText("与前 2 个完成日相比")).toBeTruthy();
    expect(within(review).getByText("近期证据比上一阶段更稳，继续保持当前节奏。")).toBeTruthy();
    expect(within(review).getByText("偏难日 -2")).toBeTruthy();
  });

  it("downloads the weekly review and stage progress as Markdown", async () => {
    const user = userEvent.setup();
    const downloads: string[] = [];
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:progress") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) { downloads.push(this.download); });
    render(<App />);

    await user.click(screen.getByRole("button", { name: "导出进展 Markdown" }));
    expect(downloads).toEqual([expect.stringMatching(/^ai-learning-os-progress-\d{4}-\d{2}-\d{2}\.md$/)]);
    expect(screen.getByText("已导出学习周回顾与阶段进展摘要。")).toBeTruthy();
  });

  it("navigates the learning calendar and opens evidence for a recorded date", async () => {
    const user = userEvent.setup();
    let state = initializeLearningState(generateLearningPlan(goal), new Date("2026-07-31T10:00:00.000Z"));
    for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
    state = completeCurrentDay(state, { difficulty: "too-hard", reflection: "需要复查工具边界" }, new Date("2026-08-01T10:00:00.000Z"));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

    render(<App />);

    const calendar = screen.getByRole("region", { name: "学习日历" });
    expect(within(calendar).getByText("2026年8月")).toBeTruthy();
    await user.click(within(calendar).getByRole("button", { name: "查看上个月" }));
    await user.click(within(calendar).getByRole("button", { name: "2026-07-31，1 个完成日" }));
    expect(within(calendar).getByText("需要复查工具边界")).toBeTruthy();
    expect(within(calendar).getByText("投入 60 分钟")).toBeTruthy();
  });

  it("offers and renders a low-pressure Coach plan after missed learning days", async () => {
    const user = userEvent.setup();
    const stale = initializeLearningState(generateLearningPlan(goal), new Date("2026-07-28T10:00:00.000Z"));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stale));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, "http://localhost");
      if (url.pathname === "/api/auth/session") return Response.json({ error: "Authentication is not configured" }, { status: 503 });
      if (url.pathname === "/api/recovery-plans") return Response.json({
        headline: "用 12 分钟轻量重启",
        acknowledgement: "不需要补完错过的内容。",
        totalMinutes: 12,
        steps: [
          { id: "recall", title: "找回上下文", description: "写下还记得的内容。", minutes: 4 },
          { id: "restart", title: "完成最小一步", description: "只做当前任务第一步。", minutes: 8 },
        ],
        nextCheckIn: "现在继续是否更容易？",
      }, { status: 201 });
      return Response.json({ error: "Not found" }, { status: 404 });
    }));
    render(<App />);

    expect(screen.getByRole("heading", { name: "欢迎回来，今天不用追赶。" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "生成 10–20 分钟恢复计划" }));

    expect(await screen.findByText("用 12 分钟轻量重启 · 12 分钟")).toBeTruthy();
    expect(screen.getByText("完成最小一步")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("现在继续是否更容易");
  });

  it("automatically scores active recall and schedules the next adaptive review", async () => {
    const user = userEvent.setup();
    let state = initializeLearningState(generateLearningPlan(goal));
    for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
    const practice = getCurrentRecord(state).tasks.find((task) => task.type === "practice")!;
    state = saveEvaluation(state, practice.id, "可验证成果", {
      rubric: [
        { dimension: "understanding", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "application", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "evidence", score: 2, evidence: "证据", feedback: "反馈" },
        { dimension: "reflection", score: 2, evidence: "证据", feedback: "反馈" },
      ],
      totalScore: 8,
      masteryLevel: "developing",
      misconceptions: [],
      nextAction: "独立解释关键机制",
    });
    state = completeCurrentDay(state, { difficulty: "just-right", reflection: "" });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, "http://localhost");
      if (url.pathname === "/api/auth/session") return Response.json({ error: "Authentication is not configured" }, { status: 503 });
      if (url.pathname === "/api/review-assessments") return Response.json({
        answer: "重试再次执行失败步骤，恢复从检查点继续。", score: 4, recall: "easy",
        evidence: "区分了重试与恢复", feedback: "补充一个恢复失败分支。",
      }, { status: 201 });
      return Response.json({ error: "Not found" }, { status: 404 });
    }));
    render(<App />);

    expect(screen.getByText("Review Agent · 主动回忆自动判分")).toBeTruthy();
    const schedule = screen.getByRole("region", { name: "即将复习的薄弱点" });
    expect(within(schedule).getByText("今天")).toBeTruthy();
    expect(within(schedule).getByText(/独立解释关键机制/)).toBeTruthy();
    await user.type(screen.getByLabelText("闭卷主动回忆答案"), "重试再次执行失败步骤，恢复从检查点继续。");
    await user.click(screen.getByRole("button", { name: /提交答案并自动安排复习/ }));

    expect(await within(schedule).findByText("第 9 天")).toBeTruthy();
    expect(screen.getByText("主动回忆 4/4 · 轻松想起")).toBeTruthy();
    expect(screen.getByText("区分了重试与恢复")).toBeTruthy();

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    const reviewTask = saved.days[1].tasks.find((task: { type: string }) => task.type === "diagnose");
    expect(reviewTask.completed).toBe(true);
    expect(saved.days[1].artifacts[reviewTask.id].reviewPerformance).toEqual({
      sourceDays: [1], recall: "easy",
      assessment: { answer: "重试再次执行失败步骤，恢复从检查点继续。", score: 4, recall: "easy", evidence: "区分了重试与恢复", feedback: "补充一个恢复失败分支。" },
    });
  });

  it("creates, enriches, edits, and searches a manual stage learning note", async () => {
    const user = userEvent.setup();
    let state = initializeLearningState(generateLearningPlan(goal));
    const task = getCurrentRecord(state).tasks.find((item) => item.type === "learn")!;
    state = saveTeachingSession(state, task.id, {
      concept: "工具调用", explanation: "模型选择工具，宿主执行并验证参数。", workedExample: "先校验再调用。", practicePrompt: "练习",
      understandingChecks: [
        { id: "recall", prompt: "解释机制", expectedSignals: ["机制"] },
        { id: "apply", prompt: "迁移应用", expectedSignals: ["步骤"] },
      ],
      completionSignals: ["可解释"],
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render(<App />);

    await user.click(screen.getByRole("button", { name: "手动新建笔记" }));
    await user.clear(screen.getByLabelText("新笔记标题"));
    await user.type(screen.getByLabelText("新笔记标题"), "工具调用速查");
    await user.type(screen.getByLabelText("新笔记内容"), "人工结论：先定义执行边界。");
    await user.click(screen.getByRole("button", { name: "新建笔记" }));
    await user.click(screen.getByRole("button", { name: "追加新证据" }));

    const noteCard = screen.getByRole("heading", { name: "工具调用速查" }).closest("article")!;
    expect(within(noteCard).getByText(/人工结论：先定义执行边界/)).toBeTruthy();
    expect(within(noteCard).getByText(/模型选择工具，宿主执行并验证参数/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "编辑" }));
    await user.click(screen.getByRole("button", { name: "保存笔记" }));

    expect(screen.getByRole("heading", { name: "工具调用速查" })).toBeTruthy();
    await user.type(screen.getByLabelText("搜索笔记"), "不存在的关键词");
    expect(screen.getByText("没有匹配的笔记。")).toBeTruthy();
    await user.clear(screen.getByLabelText("搜索笔记"));
    await user.type(screen.getByLabelText("搜索笔记"), "验证参数");
    expect(screen.getByRole("heading", { name: "工具调用速查" })).toBeTruthy();
    const savedNote = JSON.parse(localStorage.getItem(STORAGE_KEY)!).plan.notes[0];
    expect(savedNote.content).toContain("人工结论：先定义执行边界。");
    expect(savedNote.content).toContain("宿主执行并验证参数");
    expect(savedNote.sourceDays).toEqual([1]);
  });

  it("exports a stage note as Markdown and requires confirmation before deleting it", async () => {
    const user = userEvent.setup();
    const downloads: string[] = [];
    let state = initializeLearningState(generateLearningPlan(goal));
    state.plan.notes = [{
      id: "note-stage-1", stageId: "stage-1", title: "工具调用速查", content: "先校验参数。", sourceDays: [1], updatedAt: "2026-08-01T12:00:00.000Z",
    }];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:stage-note") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    render(<App />);

    await user.click(screen.getByRole("button", { name: "导出 Markdown" }));
    expect(downloads).toEqual([expect.stringMatching(/^工具调用速查-\d{4}-\d{2}-\d{2}\.md$/)]);

    await user.click(screen.getByRole("button", { name: "删除" }));
    expect(screen.getByRole("alertdialog", { name: "删除“工具调用速查”？" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("heading", { name: "工具调用速查" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "删除" }));
    await user.click(screen.getByRole("button", { name: "确认删除笔记" }));
    expect(screen.queryByRole("heading", { name: "工具调用速查" })).toBeNull();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).plan.notes).toEqual([]);
  });

  it("generates and edits a retrospective after a stage is complete", async () => {
    const user = userEvent.setup();
    let state = initializeLearningState(generateLearningPlan({ ...goal, durationWeeks: 1 }));
    for (let day = 1; day <= 7; day += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      state = completeCurrentDay(state, { difficulty: "just-right", reflection: day === 7 ? "把基础方法用于真实项目" : "" });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render(<App />);

    const section = screen.getByRole("region", { name: "阶段结束回顾" });
    expect(within(section).getByRole("status", { name: "目标掌握度" }).textContent).toContain("计划日程已完成，但至少一个阶段仍缺少");
    expect(within(section).getByRole("status", { name: "目标掌握度" }).textContent).toContain("当前优先建立基础");
    expect(within(section).getByRole("status", { name: "阶段掌握度" }).textContent).toContain("证据不足");
    expect(within(section).getByText("补充一份可验证的实践成果并获取四维评估。")).toBeTruthy();
    expect(within(section).queryByRole("button", { name: "加入今天的补强实践" })).toBeNull();
    await user.click(within(section).getByRole("button", { name: "生成阶段回顾" }));
    expect(within(section).getByText(/已完成 7 个学习日/)).toBeTruthy();
    await user.click(within(section).getByRole("button", { name: "编辑回顾" }));
    await user.clear(within(section).getByLabelText("可迁移能力"));
    await user.type(within(section).getByLabelText("可迁移能力"), "拆解问题并验证最小成果");
    await user.click(within(section).getByRole("button", { name: "保存阶段回顾" }));

    expect(within(section).getByText("拆解问题并验证最小成果")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).plan.retrospectives[0].transferableSkills).toBe("拆解问题并验证最小成果");
  });

  it("downloads a standalone goal evidence report after schedule completion", async () => {
    const user = userEvent.setup();
    const downloads: string[] = [];
    let state = initializeLearningState(generateLearningPlan({ ...goal, durationWeeks: 1 }));
    for (let day = 1; day <= 7; day += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      state = completeCurrentDay(state, { difficulty: "just-right", reflection: "完成" });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:goal-evidence") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) { downloads.push(this.download); });
    render(<App />);

    await user.click(screen.getByRole("button", { name: "导出目标证据报告" }));

    expect(downloads).toEqual([expect.stringMatching(/^AI-Agent-工程-goal-evidence-\d{4}-\d{2}-\d{2}\.md$/)]);
    expect(screen.getByText("已导出目标证据报告 Markdown。")).toBeTruthy();
  });

  it("turns a linked misconception into a scored active-recall task", async () => {
    const user = userEvent.setup();
    let state = initializeLearningState(generateLearningPlan({ ...goal, durationWeeks: 2 }));
    for (let day = 1; day <= 8; day += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      if (day === 1 || day === 8) {
        const practice = getCurrentRecord(state).tasks.find((task) => task.type === "practice")!;
        state = saveEvaluation(state, practice.id, "成果", {
          rubric: [
            { dimension: "understanding", score: 2, evidence: "证据", feedback: "反馈" },
            { dimension: "application", score: 2, evidence: "证据", feedback: "反馈" },
            { dimension: "evidence", score: 2, evidence: "证据", feedback: "反馈" },
            { dimension: "reflection", score: 2, evidence: "证据", feedback: "反馈" },
          ],
          totalScore: 8, masteryLevel: "developing", misconceptions: ["混淆重试与恢复"], nextAction: "画出恢复路径",
        });
      }
      state = completeCurrentDay(state, { difficulty: "just-right", reflection: "" });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, "http://localhost");
      if (url.pathname === "/api/auth/session") return Response.json({ error: "Authentication is not configured" }, { status: 503 });
      if (url.pathname === "/api/review-assessments") return Response.json({
        answer: "重试再次执行，恢复从检查点继续。", score: 4, recall: "easy",
        evidence: "比较了两个阶段的恢复路径", feedback: "再验证一个失败分支。",
      }, { status: 201 });
      return Response.json({ error: "Not found" }, { status: 404 });
    }));

    render(<App />);

    const section = screen.getByRole("region", { name: "跨阶段重复误解" });
    expect(within(section).getByText("混淆重试与恢复")).toBeTruthy();
    expect(within(section).getByText("建立基础 · 第 1 天 ↔ 构建知识增强应用 · 第 8 天")).toBeTruthy();
    expect(within(section).getByText(/分别给出正确判断与一个可验证例子/)).toBeTruthy();
    await user.click(within(section).getByRole("button", { name: "加入今天的主动回忆" }));
    expect((within(section).getByRole("button", { name: "已加入今日任务" }) as HTMLButtonElement).disabled).toBe(true);

    const taskTitle = screen.getByText("跨阶段主动回忆：混淆重试与恢复");
    const taskBlock = taskTitle.closest("article")!;
    await user.type(within(taskBlock).getByLabelText("闭卷主动回忆答案"), "重试再次执行，恢复从检查点继续。");
    await user.click(within(taskBlock).getByRole("button", { name: /提交答案并自动安排复习/ }));

    expect(await within(taskBlock).findByText("主动回忆 4/4 · 轻松想起")).toBeTruthy();
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    const linkedTask = saved.days[8].tasks.find((task: { title: string }) => task.title.startsWith("跨阶段主动回忆"));
    expect(saved.days[8].artifacts[linkedTask.id].reviewPerformance.sourceDays).toEqual([1, 8]);
  });

  it("adds a stage mastery next action to today's evaluated practice", async () => {
    const user = userEvent.setup();
    let state = initializeLearningState(generateLearningPlan({ ...goal, durationWeeks: 2 }));
    for (let day = 1; day <= 7; day += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      if (day === 3) {
        const practice = getCurrentRecord(state).tasks.find((task) => task.type === "practice")!;
        state = saveEvaluation(state, practice.id, "恢复演练", {
          rubric: [
            { dimension: "understanding", score: 3, evidence: "解释边界", feedback: "继续" },
            { dimension: "application", score: 2, evidence: "仅成功路径", feedback: "补失败路径" },
            { dimension: "evidence", score: 2, evidence: "缺少日志", feedback: "保留结果" },
            { dimension: "reflection", score: 2, evidence: "复盘较短", feedback: "补充取舍" },
          ],
          totalScore: 9, masteryLevel: "developing", misconceptions: [], nextAction: "验证失败恢复路径",
        });
      }
      state = completeCurrentDay(state, { difficulty: "just-right", reflection: "" });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, "http://localhost");
      if (url.pathname === "/api/auth/session") return Response.json({ error: "Authentication is not configured" }, { status: 503 });
      if (url.pathname === "/api/evaluations") return Response.json({
        rubric: [
          { dimension: "understanding", score: 4, evidence: "解释失败边界", feedback: "继续" },
          { dimension: "application", score: 4, evidence: "覆盖失败恢复", feedback: "继续" },
          { dimension: "evidence", score: 4, evidence: "保留日志", feedback: "继续" },
          { dimension: "reflection", score: 4, evidence: "说明取舍", feedback: "继续" },
        ],
        totalScore: 16, masteryLevel: "ready", misconceptions: [], nextAction: "迁移到下一阶段",
      }, { status: 201 });
      return Response.json({ error: "Not found" }, { status: 404 });
    }));
    render(<App />);

    const section = screen.getByRole("region", { name: "阶段结束回顾" });
    await user.click(within(section).getByRole("button", { name: "加入今天的补强实践" }));

    expect((within(section).getByRole("button", { name: "已加入今日任务" }) as HTMLButtonElement).disabled).toBe(true);
    const taskTitle = screen.getByText("阶段补强实践：建立基础");
    const taskBlock = taskTitle.closest("article")!;
    expect(within(taskBlock).getByText(/验证失败恢复路径/)).toBeTruthy();
    await user.type(within(taskBlock).getByLabelText("描述成果、关键步骤、验证证据和复盘"), "补充了失败恢复测试、日志和取舍复盘");
    await user.click(within(taskBlock).getByRole("button", { name: /提交成果并获取反馈/ }));

    expect(await within(section).findByText("补强后变化 · 来源第 3 天")).toBeTruthy();
    expect(within(section).getByText("平均成果 9 → 12.5/16")).toBeTruthy();
    expect(within(section).getByText("补强来源：验证失败恢复路径")).toBeTruthy();
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(saved.days.at(-1).tasks.filter((task: { id: string }) => task.id === "day-8-stage-mastery-stage-1")).toHaveLength(1);
    expect(saved.days.at(-1).artifacts["day-8-stage-mastery-stage-1"].stageMasteryRemediation).toMatchObject({ stageId: "stage-1", sourceDay: 3 });
  });

  it("starts the goal-level priority remediation without searching stage cards", async () => {
    const user = userEvent.setup();
    let state = initializeLearningState(generateLearningPlan({ ...goal, durationWeeks: 2 }));
    for (let day = 1; day <= 14; day += 1) {
      for (const task of getCurrentRecord(state).tasks) state = toggleCurrentTask(state, task.id);
      if (day === 10) {
        const practice = getCurrentRecord(state).tasks.find((task) => task.type === "practice")!;
        state = saveEvaluation(state, practice.id, "完整的第二阶段成果", {
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render(<App />);

    const goalSummary = screen.getByRole("status", { name: "目标掌握度" });
    expect(goalSummary.textContent).toContain("当前优先建立基础");
    await user.click(within(goalSummary).getByRole("button", { name: "开始当前优先补强日" }));

    expect(screen.getAllByText("DAY 15", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText("阶段补强实践：建立基础")).toBeTruthy();
    expect((within(screen.getByRole("status", { name: "目标掌握度" })).getByRole("button", { name: "当前优先补强已加入" }) as HTMLButtonElement).disabled).toBe(true);
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(saved.days[14].artifacts["day-15-stage-mastery-stage-1"].stageMasteryRemediation).toMatchObject({
      stageId: "stage-1",
      sourceDay: 7,
      sourceNextAction: "补充一份可验证的实践成果并获取四维评估。",
    });
  });

  it("starts a follow-up learning day for weak final-stage evidence", async () => {
    const user = userEvent.setup();
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render(<App />);

    expect(screen.getByRole("button", { name: "归档已完成目标" })).toBeTruthy();
    const section = screen.getByRole("region", { name: "阶段结束回顾" });
    await user.click(within(section).getByRole("button", { name: "开始补强学习日" }));

    expect(screen.getAllByText("DAY 8", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText("阶段补强实践：建立基础")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "归档已完成目标" })).toBeNull();
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(saved.currentDay).toBe(8);
    expect(saved.days[7].artifacts["day-8-stage-mastery-stage-1"].stageMasteryRemediation).toMatchObject({ stageId: "stage-1", sourceDay: 3 });
  });

  it("keeps data on cancellation and removes every local version after confirmation", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ai-learning-os-state-v2", "legacy-state");
    localStorage.setItem("ai-learning-os-plan-v1", "legacy-plan");
    localStorage.setItem(DAILY_BUDGET_KEY, "90");
    render(<App />);

    await user.click(screen.getByRole("button", { name: "删除本地数据" }));
    expect(screen.getByRole("alertdialog", { name: "删除当前浏览器中的学习数据？" })).toBeTruthy();
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "删除本地数据" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    expect(screen.getByRole("heading", { name: /把想学的事/ })).toBeTruthy();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem("ai-learning-os-state-v2")).toBeNull();
    expect(localStorage.getItem("ai-learning-os-plan-v1")).toBeNull();
    expect(localStorage.getItem(DAILY_BUDGET_KEY)).toBeNull();
  });

  it("downloads the current state as a dated JSON file", async () => {
    const user = userEvent.setup();
    const downloads: string[] = [];
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:learning-data") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    render(<App />);

    await user.click(screen.getByRole("button", { name: "导出学习记录" }));

    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(downloads).toEqual([expect.stringMatching(/^ai-learning-os-learning-data-\d{4}-\d{2}-\d{2}\.json$/)]);
  });

  it("validates and confirms a learning-record restore before replacing local progress", async () => {
    const user = userEvent.setup();
    const restoredPlan = generateLearningPlan({ ...goal, subject: "分布式系统" }, new Date("2026-07-30T10:00:00.000Z"));
    const restoredState = initializeLearningState(restoredPlan);
    render(<App />);

    await user.upload(
      screen.getByLabelText("选择学习记录文件"),
      new File([serializeLearningStateExport(restoredState)], "learning-data.json", { type: "application/json" }),
    );

    expect(screen.getByRole("alertdialog", { name: "恢复“分布式系统”？" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: goal.subject })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "确认恢复" }));

    expect(screen.getByRole("heading", { name: "分布式系统" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).plan.goal.subject).toBe("分布式系统");
    expect(screen.getByRole("status").textContent).toContain("已恢复");
  });

  it("rejects an invalid learning-record file without changing local progress", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.upload(
      screen.getByLabelText("选择学习记录文件"),
      new File([JSON.stringify({ format: "ai-learning-os-learning-data", exportVersion: 99 })], "invalid.json", { type: "application/json" }),
    );

    expect(screen.getByRole("alert").textContent).toContain("版本暂不受支持");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).plan.goal.subject).toBe(goal.subject);
  });

  it("shows account controls and syncs local progress for an authenticated session", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, "http://localhost");
      if (url.pathname === "/api/auth/session") {
        return Response.json({ authenticated: true, principal: { userId: "user-1", deviceId: "device-1" } });
      }
      if (url.pathname === "/api/sync/changes") return Response.json({ changes: [], cursor: "cursor-1" });
      if (init?.method === "PUT") {
        const value = JSON.parse(String(init.body));
        const daily = url.pathname.includes("/daily-records/");
        return Response.json({
          entityType: daily ? "daily-record" : "learning-plan",
          entityId: decodeURIComponent(url.pathname.split("/").at(-1)!),
          revision: 1,
          updatedAt: "2026-08-01T10:00:00.000Z",
          value,
        });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }));
    render(<App />);

    expect(await screen.findByText("已登录")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("上传 2 项"), { timeout: 2_500 });
    expect(screen.getByText(/上次同步/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "立即同步" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "退出" })).toBeTruthy();
  });

  it("confirms account deletion before clearing cloud and local learning data", async () => {
    const user = userEvent.setup();
    const requests: Array<{ path: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, "http://localhost");
      requests.push({ path: url.pathname, method: init?.method ?? "GET" });
      if (url.pathname === "/api/auth/session") return Response.json({ authenticated: true, principal: { userId: "user-1", deviceId: "device-1" } });
      if (url.pathname === "/api/auth/account" && init?.method === "DELETE") return Response.json({ deleted: true });
      if (url.pathname === "/api/sync/changes") return Response.json({ changes: [], cursor: "cursor-1" });
      if (init?.method === "PUT") {
        const value = JSON.parse(String(init.body));
        const daily = url.pathname.includes("/daily-records/");
        return Response.json({ entityType: daily ? "daily-record" : "learning-plan", entityId: decodeURIComponent(url.pathname.split("/").at(-1)!), revision: 1, updatedAt: "2026-08-01T10:00:00.000Z", value });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }));
    render(<App />);

    await screen.findByText("已登录");
    await user.click(screen.getByRole("button", { name: "删除账号" }));
    expect(screen.getByRole("alertdialog", { name: "永久删除账号和全部学习数据？" })).toBeTruthy();
    expect(requests.some((request) => request.path === "/api/auth/account")).toBe(false);
    await user.click(screen.getByRole("button", { name: "永久删除账号" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: /把想学的事/ })).toBeTruthy());
    expect(requests).toContainEqual({ path: "/api/auth/account", method: "DELETE" });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("已删除");
  });

  it("confirms signing out every device without deleting local learning data", async () => {
    const user = userEvent.setup();
    const requests: Array<{ path: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, "http://localhost");
      requests.push({ path: url.pathname, method: init?.method ?? "GET" });
      if (url.pathname === "/api/auth/session") return Response.json({ authenticated: true, principal: { userId: "user-1", deviceId: "device-1" } });
      if (url.pathname === "/api/auth/logout-all" && init?.method === "POST") return Response.json({ authenticated: false, revokedAll: true });
      if (url.pathname === "/api/sync/changes") return Response.json({ changes: [], cursor: "cursor-1" });
      if (init?.method === "PUT") {
        const value = JSON.parse(String(init.body));
        const daily = url.pathname.includes("/daily-records/");
        return Response.json({ entityType: daily ? "daily-record" : "learning-plan", entityId: decodeURIComponent(url.pathname.split("/").at(-1)!), revision: 1, updatedAt: "2026-08-01T10:00:00.000Z", value });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }));
    render(<App />);

    await screen.findByText("已登录");
    await user.click(screen.getByRole("button", { name: "退出所有设备" }));
    expect(screen.getByRole("alertdialog", { name: "退出所有设备？" })).toBeTruthy();
    expect(requests.some((request) => request.path === "/api/auth/logout-all")).toBe(false);
    await user.click(screen.getByRole("button", { name: "确认退出所有设备" }));

    await waitFor(() => expect(screen.getByRole("link", { name: "登录并同步" })).toBeTruthy());
    expect(requests).toContainEqual({ path: "/api/auth/logout-all", method: "POST" });
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("已退出所有设备");
  });

  it("shows active devices and revokes a selected remote device", async () => {
    const user = userEvent.setup();
    const requests: Array<{ path: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, "http://localhost");
      requests.push({ path: url.pathname, method: init?.method ?? "GET" });
      if (url.pathname === "/api/auth/session") return Response.json({ authenticated: true, principal: { userId: "user-1", deviceId: "device-1" } });
      if (url.pathname === "/api/auth/devices" && !init?.method) return Response.json({ devices: [
        { id: "device-1", label: "Laptop", createdAt: "2026-08-01T10:00:00.000Z", lastSeenAt: "2026-08-01T12:00:00.000Z", current: true },
        { id: "device-2", label: "Phone", createdAt: "2026-08-01T10:30:00.000Z", lastSeenAt: "2026-08-01T11:30:00.000Z", current: false },
      ] });
      if (url.pathname === "/api/auth/devices/device-2" && init?.method === "DELETE") return Response.json({ revoked: true, revokedCurrent: false });
      if (url.pathname === "/api/sync/changes") return Response.json({ changes: [], cursor: "cursor-1" });
      if (init?.method === "PUT") {
        const value = JSON.parse(String(init.body));
        const daily = url.pathname.includes("/daily-records/");
        return Response.json({ entityType: daily ? "daily-record" : "learning-plan", entityId: decodeURIComponent(url.pathname.split("/").at(-1)!), revision: 1, updatedAt: "2026-08-01T10:00:00.000Z", value });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }));
    render(<App />);

    await screen.findByText("已登录");
    await user.click(screen.getByRole("button", { name: "管理设备" }));
    expect(await screen.findByRole("dialog", { name: "管理登录设备" })).toBeTruthy();
    expect(screen.getByText("Laptop")).toBeTruthy();
    expect(screen.getByText("Phone")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "退出此设备" }));

    await waitFor(() => expect(screen.queryByText("Phone")).toBeNull());
    expect(requests).toContainEqual({ path: "/api/auth/devices/device-2", method: "DELETE" });
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("已退出设备");
  });

  it("previews diverged local and cloud progress and applies the selected cloud version", async () => {
    const user = userEvent.setup();
    const entities = new Map<string, { entityType: "learning-plan" | "daily-record"; entityId: string; revision: number; updatedAt: string; value: unknown }>();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, "http://localhost");
      if (url.pathname === "/api/auth/session") return Response.json({ authenticated: true, principal: { userId: "user-1", deviceId: "device-1" } });
      if (url.pathname === "/api/sync/changes") return Response.json({ changes: [...entities.values()], cursor: "cursor-1" });
      if (init?.method === "PUT") {
        const daily = url.pathname.includes("/daily-records/");
        const entityId = decodeURIComponent(url.pathname.split("/").at(-1)!);
        const entityType = daily ? "daily-record" as const : "learning-plan" as const;
        const key = `${entityType}:${entityId}`;
        const current = entities.get(key);
        const entity = { entityType, entityId, revision: (current?.revision ?? 0) + 1, updatedAt: "2026-08-01T10:00:00.000Z", value: JSON.parse(String(init.body)) };
        entities.set(key, entity);
        return Response.json(entity);
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }));
    render(<App />);
    await screen.findByText("已登录");
    await user.click(screen.getByRole("button", { name: "立即同步" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("上传 2 项"));

    const recordKey = [...entities.keys()].find((key) => key.startsWith("daily-record:"))!;
    const remote = entities.get(recordKey)!;
    const remoteValue = structuredClone(remote.value) as { record: { tasks: Array<{ description: string }> } };
    remoteValue.record.tasks[1].description = "云端设备补充的学习说明";
    entities.set(recordKey, { ...remote, revision: 2, updatedAt: "2026-08-01T11:00:00.000Z", value: remoteValue });
    await user.click(screen.getByRole("button", { name: /快速基线评估/ }));
    await user.click(screen.getByRole("button", { name: "立即同步" }));

    expect(await screen.findByRole("alertdialog", { name: "比较本地与云端进度" })).toBeTruthy();
    expect(screen.getByText("当前浏览器")).toBeTruthy();
    expect(screen.getByText("云端版本")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "使用云端版本" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "比较本地与云端进度" })).toBeNull());
    expect(screen.getByText("云端设备补充的学习说明")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("已保留云端冲突版本");
  });
});
