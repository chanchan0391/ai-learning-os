import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { DeterministicModelProvider } from "./ai/deterministic-provider";
import { ModelProviderError, type ModelProvider } from "./ai/model-provider";

const servers: ReturnType<typeof createApp>[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

async function startApi(provider: ModelProvider = new DeterministicModelProvider()) {
  const server = createApp(provider);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("AI Learning OS API", () => {
  const goal = { subject: "AI Agent 工程", currentLevel: "Java 工程师", targetOutcome: "交付 Agent 应用", dailyMinutes: 60, durationWeeks: 12 };
  const task = { id: "learn-1", type: "learn" as const, title: "理解工具调用", description: "实现一个工具调用闭环", minutes: 20, completed: false };

  it("reports whether a live AI model is enabled", async () => {
    const baseUrl = await startApi();
    await expect(fetch(`${baseUrl}/api/health`).then((response) => response.json())).resolves.toEqual({ status: "ok", provider: "deterministic-development", aiEnabled: false });
  });

  it("creates a validated plan through the Agent boundary", async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/plans`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(goal),
    });
    const plan = await response.json() as { today: Array<{ minutes: number }> };
    expect(response.status).toBe(201);
    expect(plan.today.reduce((sum, task) => sum + task.minutes, 0)).toBe(60);
  });

  it("creates a teaching session with active understanding checks", async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/teaching-sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, task, learnerContext: { knownConcepts: ["Java 接口"], recentErrors: ["没有处理超时"] } }),
    });
    const session = await response.json() as { understandingChecks: unknown[]; completionSignals: unknown[] };
    expect(response.status).toBe(201);
    expect(session.understandingChecks).toHaveLength(2);
    expect(session.completionSignals.length).toBeGreaterThan(0);
  });

  it("evaluates a submission against the fixed rubric", async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/evaluations`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, task, submission: "我实现了工具调用，记录了输入、输出和失败后的重试结果，并复盘了超时处理。" }),
    });
    const evaluation = await response.json() as { rubric: unknown[]; totalScore: number; masteryLevel: string };
    expect(response.status).toBe(201);
    expect(evaluation.rubric).toHaveLength(4);
    expect(evaluation.totalScore).toBe(8);
    expect(evaluation.masteryLevel).toBe("developing");
  });

  it("rejects an empty evaluation submission", async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/evaluations`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, task, submission: "  " }),
    });
    expect(response.status).toBe(400);
  });

  it("cancels an Agent call when its client disconnects", async () => {
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    const provider: ModelProvider = {
      id: "cancellation-test",
      isAiEnabled: true,
      generateStructured: ({ signal }) => new Promise((_resolve, reject) => {
        markStarted();
        signal?.addEventListener("abort", () => {
          markAborted();
          reject(new ModelProviderError("cancelled", 499));
        }, { once: true });
      }),
    };
    const baseUrl = await startApi(provider);
    const controller = new AbortController();
    const fetchResult = fetch(`${baseUrl}/api/plans`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(goal), signal: controller.signal,
    });
    await started;
    controller.abort();

    await expect(fetchResult).rejects.toThrow();
    await expect(aborted).resolves.toBeUndefined();
  });
});
