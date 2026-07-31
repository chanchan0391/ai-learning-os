import { DeterministicModelProvider } from "./deterministic-provider";
import type { ModelProvider } from "./model-provider";
import { OpenAIResponsesProvider } from "./openai-responses-provider";

export function createModelProvider(environment: NodeJS.ProcessEnv = process.env): ModelProvider {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  const model = environment.OPENAI_MODEL?.trim();

  if (apiKey && model) return new OpenAIResponsesProvider({ apiKey, model });
  if (apiKey || model) throw new Error("OPENAI_API_KEY and OPENAI_MODEL must be configured together");
  return new DeterministicModelProvider();
}
