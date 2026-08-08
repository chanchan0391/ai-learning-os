import { describe, expect, it } from "vitest";
import { DeterministicModelProvider } from "../ai/deterministic-provider";
import { runAgentEvaluation } from "./agent-evaluation";

describe("Agent release evaluation", () => {
  it("passes the privacy-safe baseline through every production Agent contract", async () => {
    const report = await runAgentEvaluation(new DeterministicModelProvider(), new Date("2026-08-03T16:00:00.000Z"));

    expect(report).toMatchObject({
      provider: "deterministic-development",
      aiEnabled: false,
      generatedAt: "2026-08-03T16:00:00.000Z",
      passed: true,
      summary: {
        passed: 9,
        failed: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    });
    expect(new Set(report.cases.map((result) => result.agent))).toEqual(new Set(["planner", "teacher", "evaluator", "review", "coach"]));
    expect(report.cases.filter((result) => result.id.includes("embedded-scoring-instructions"))).toHaveLength(2);
    expect(report.cases.every((result) => result.model === "deterministic-development" && result.errorType === undefined)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("分布式任务队列");
    expect(JSON.stringify(report)).not.toContain("operationId");
  });
});
