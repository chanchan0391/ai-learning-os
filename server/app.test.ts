import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { DeterministicPlannerProvider } from "./ai/deterministic-provider";

const servers: ReturnType<typeof createApp>[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

async function startApi() {
  const server = createApp(new DeterministicPlannerProvider());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("AI Learning OS API", () => {
  it("reports whether a live AI model is enabled", async () => {
    const baseUrl = await startApi();
    await expect(fetch(`${baseUrl}/api/health`).then((response) => response.json())).resolves.toEqual({ status: "ok", provider: "deterministic-development", aiEnabled: false });
  });

  it("creates a validated plan through the Agent boundary", async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/plans`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "AI Agent 工程", currentLevel: "Java 工程师", targetOutcome: "交付 Agent 应用", dailyMinutes: 60, durationWeeks: 12 }),
    });
    const plan = await response.json() as { today: Array<{ minutes: number }> };
    expect(response.status).toBe(201);
    expect(plan.today.reduce((sum, task) => sum + task.minutes, 0)).toBe(60);
  });
});
