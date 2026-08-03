import { DeterministicModelProvider } from "../ai/deterministic-provider";
import { createModelProvider } from "../ai/provider-factory";
import { runAgentEvaluation } from "./agent-evaluation";

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

const report = await runAgentEvaluation(provider);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
