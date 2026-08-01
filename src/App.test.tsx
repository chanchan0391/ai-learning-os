// @vitest-environment jsdom

import axe from "axe-core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  completeCurrentDay,
  getCurrentRecord,
  initializeLearningState,
  saveEvaluation,
  serializeLearningStateExport,
  toggleCurrentTask,
} from "./learning-state";
import { generateLearningPlan } from "./planner";

const STORAGE_KEY = "ai-learning-os-state-v3";
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

  it("records review recall from the dashboard before completing an adaptive review", async () => {
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
    render(<App />);

    expect(screen.getByRole("group", { name: "复习回忆表现" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "轻松想起 · 延长间隔" }));

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    const reviewTask = saved.days[1].tasks.find((task: { type: string }) => task.type === "diagnose");
    expect(reviewTask.completed).toBe(true);
    expect(saved.days[1].artifacts[reviewTask.id].reviewPerformance).toEqual({ sourceDays: [1], recall: "easy" });
  });

  it("generates, edits, and searches stage learning notes", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "生成当前阶段笔记" }));
    expect(screen.getByRole("heading", { name: "建立基础学习笔记" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "编辑" }));
    await user.clear(screen.getByLabelText("笔记标题"));
    await user.type(screen.getByLabelText("笔记标题"), "工具调用速查");
    await user.clear(screen.getByLabelText("笔记内容"));
    await user.type(screen.getByLabelText("笔记内容"), "宿主负责执行工具并验证参数。");
    await user.click(screen.getByRole("button", { name: "保存笔记" }));

    expect(screen.getByRole("heading", { name: "工具调用速查" })).toBeTruthy();
    await user.type(screen.getByLabelText("搜索笔记"), "不存在的关键词");
    expect(screen.getByText("没有匹配的笔记。")).toBeTruthy();
    await user.clear(screen.getByLabelText("搜索笔记"));
    await user.type(screen.getByLabelText("搜索笔记"), "验证参数");
    expect(screen.getByRole("heading", { name: "工具调用速查" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).plan.notes[0].content).toBe("宿主负责执行工具并验证参数。");
  });

  it("keeps data on cancellation and removes every local version after confirmation", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ai-learning-os-state-v2", "legacy-state");
    localStorage.setItem("ai-learning-os-plan-v1", "legacy-plan");
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
