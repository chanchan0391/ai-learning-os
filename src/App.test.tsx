// @vitest-environment jsdom

import axe from "axe-core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { initializeLearningState, serializeLearningStateExport } from "./learning-state";
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
