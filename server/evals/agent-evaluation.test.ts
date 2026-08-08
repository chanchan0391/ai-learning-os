import { describe, expect, it } from "vitest";
import type { ModelProvider, StructuredGenerationRequest, StructuredGenerationResult } from "../ai/model-provider";
import { DeterministicModelProvider } from "../ai/deterministic-provider";
import { DEFAULT_AGENT_EVALUATION_LIMITS, runAgentEvaluation } from "./agent-evaluation";

class UsageReportingProvider implements ModelProvider {
  readonly id = "usage-reporting-test";
  readonly isAiEnabled = true;

  constructor(
    private readonly delegate: ModelProvider,
    private readonly inputTokens: number,
    private readonly outputTokens: number,
  ) {}

  async generateStructured<T>(request: StructuredGenerationRequest): Promise<StructuredGenerationResult<T>> {
    const result = await this.delegate.generateStructured<T>(request);
    return {
      ...result,
      model: this.id,
      usage: {
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        totalTokens: this.inputTokens + this.outputTokens,
      },
    };
  }
}

describe("Agent release evaluation", () => {
  it("passes the privacy-safe baseline through every production Agent contract", async () => {
    const report = await runAgentEvaluation(new DeterministicModelProvider(), new Date("2026-08-03T16:00:00.000Z"));

    expect(report).toMatchObject({
      provider: "deterministic-development",
      aiEnabled: false,
      generatedAt: "2026-08-03T16:00:00.000Z",
      passed: true,
      limits: { ...DEFAULT_AGENT_EVALUATION_LIMITS, breaches: [] },
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

  it("fails a case that exceeds its output-token release limit", async () => {
    const provider = new UsageReportingProvider(new DeterministicModelProvider(), 10, 101);
    const report = await runAgentEvaluation(provider, new Date("2026-08-03T16:00:00.000Z"), {
      maxCaseDurationMs: 30_000,
      maxCaseOutputTokens: 100,
      maxTotalTokens: 10_000,
    });

    expect(report.passed).toBe(false);
    expect(report.summary.failed).toBe(9);
    expect(report.cases.every((result) => result.errorType === "AgentEvaluationOutputTokenLimitError")).toBe(true);
  });

  it("fails live-provider cases when token usage is unavailable", async () => {
    const provider = Object.assign(new DeterministicModelProvider(), { isAiEnabled: true });
    const report = await runAgentEvaluation(provider);

    expect(report.passed).toBe(false);
    expect(report.cases.every((result) => result.errorType === "AgentEvaluationUsageMissingError")).toBe(true);
  });

  it("fails the report when aggregate token use exceeds the release limit", async () => {
    const provider = new UsageReportingProvider(new DeterministicModelProvider(), 10, 10);
    const report = await runAgentEvaluation(provider, new Date("2026-08-03T16:00:00.000Z"), {
      maxCaseDurationMs: 30_000,
      maxCaseOutputTokens: 100,
      maxTotalTokens: 100,
    });

    expect(report.summary).toMatchObject({ passed: 9, failed: 0, usage: { totalTokens: 180 } });
    expect(report.passed).toBe(false);
    expect(report.limits.breaches).toEqual(["total-token-limit"]);
  });

  it("rejects invalid release limits before making model calls", async () => {
    await expect(runAgentEvaluation(new DeterministicModelProvider(), new Date(), {
      maxCaseDurationMs: 0,
      maxCaseOutputTokens: 100,
      maxTotalTokens: 1_000,
    })).rejects.toThrow("maxCaseDurationMs must be a positive integer");
  });
});
