import { DeterministicModelProvider } from "../ai/deterministic-provider";
import { createModelProvider } from "../ai/provider-factory";
import { DEFAULT_AGENT_EVALUATION_LIMITS, runAgentEvaluation, type AgentEvaluationLimits } from "./agent-evaluation";

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

const limits: AgentEvaluationLimits = {
  maxCaseDurationMs: positiveInteger(process.env.AI_EVAL_MAX_CASE_DURATION_MS, DEFAULT_AGENT_EVALUATION_LIMITS.maxCaseDurationMs, "AI_EVAL_MAX_CASE_DURATION_MS"),
  maxCaseOutputTokens: positiveInteger(process.env.AI_EVAL_MAX_CASE_OUTPUT_TOKENS, DEFAULT_AGENT_EVALUATION_LIMITS.maxCaseOutputTokens, "AI_EVAL_MAX_CASE_OUTPUT_TOKENS"),
  maxTotalTokens: positiveInteger(process.env.AI_EVAL_MAX_TOTAL_TOKENS, DEFAULT_AGENT_EVALUATION_LIMITS.maxTotalTokens, "AI_EVAL_MAX_TOTAL_TOKENS"),
};

const allowLive = process.env.AI_EVAL_ALLOW_LIVE === "1";
if (allowLive) {
  try {
    process.loadEnvFile(".env.local");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

const provider = allowLive ? createModelProvider() : new DeterministicModelProvider();
if (allowLive && !provider.isAiEnabled) throw new Error("AI_EVAL_ALLOW_LIVE=1 requires a configured live model provider");

const report = await runAgentEvaluation(provider, new Date(), limits);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
