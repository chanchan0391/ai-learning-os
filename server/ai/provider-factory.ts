import { DeterministicModelProvider } from "./deterministic-provider";
import type { ModelProvider } from "./model-provider";
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_TOTAL_TIMEOUT_MS, OpenAIResponsesProvider } from "./openai-responses-provider";

function parseMaxOutputTokens(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_MAX_OUTPUT_TOKENS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("OPENAI_MAX_OUTPUT_TOKENS must be a positive integer");
  }
  return parsed;
}

function parseTotalTimeout(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_TOTAL_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("OPENAI_TOTAL_TIMEOUT_MS must be a positive integer");
  }
  return parsed;
}

function normalizeCompatibleBaseUrl(value: string): string {
  const parsed = new URL(value);
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) || parsed.search || parsed.hash) {
    throw new Error("OPENAI_COMPATIBLE_BASE_URL must be HTTPS (or local HTTP) without query or fragment");
  }
  if (parsed.pathname === "/" || parsed.pathname === "") parsed.pathname = "/v1";
  return parsed.toString().replace(/\/$/, "");
}

export function createModelProvider(environment: NodeJS.ProcessEnv = process.env): ModelProvider {
  const openAiApiKey = environment.OPENAI_API_KEY?.trim();
  const compatibleApiKey = environment.OPENAI_COMPATIBLE_API_KEY?.trim();
  const compatibleBaseUrl = environment.OPENAI_COMPATIBLE_BASE_URL?.trim();
  const openAiModel = environment.OPENAI_MODEL?.trim();
  const compatibleModel = environment.OPENAI_COMPATIBLE_MODEL?.trim() || openAiModel;
  const maxOutputTokens = parseMaxOutputTokens(environment.OPENAI_MAX_OUTPUT_TOKENS);
  const totalTimeoutMs = parseTotalTimeout(environment.OPENAI_TOTAL_TIMEOUT_MS);

  if (compatibleApiKey && !compatibleBaseUrl) {
    throw new Error("OPENAI_COMPATIBLE_BASE_URL is required with OPENAI_COMPATIBLE_API_KEY");
  }
  if (compatibleBaseUrl && !compatibleApiKey) {
    throw new Error("OPENAI_COMPATIBLE_API_KEY is required with OPENAI_COMPATIBLE_BASE_URL");
  }
  if (openAiApiKey && compatibleApiKey) {
    throw new Error("Configure either OPENAI_API_KEY or OPENAI_COMPATIBLE_API_KEY, not both");
  }
  if (compatibleApiKey && compatibleBaseUrl && compatibleModel) {
    return new OpenAIResponsesProvider({
      apiKey: compatibleApiKey,
      model: compatibleModel,
      baseUrl: normalizeCompatibleBaseUrl(compatibleBaseUrl),
      apiMode: "chat-completions",
      maxOutputTokens,
      totalTimeoutMs,
    });
  }
  if (compatibleApiKey || compatibleBaseUrl || environment.OPENAI_COMPATIBLE_MODEL?.trim()) {
    throw new Error("Compatible API key, base URL, and model must be configured together");
  }
  if (openAiApiKey && openAiModel) {
    return new OpenAIResponsesProvider({ apiKey: openAiApiKey, model: openAiModel, maxOutputTokens, totalTimeoutMs });
  }
  if (openAiApiKey || openAiModel) {
    throw new Error("OPENAI_API_KEY and OPENAI_MODEL must be configured together");
  }
  if (environment.OPENAI_MAX_OUTPUT_TOKENS?.trim()) {
    throw new Error("OPENAI_MAX_OUTPUT_TOKENS requires a configured model provider");
  }
  if (environment.OPENAI_TOTAL_TIMEOUT_MS?.trim()) {
    throw new Error("OPENAI_TOTAL_TIMEOUT_MS requires a configured model provider");
  }
  return new DeterministicModelProvider();
}
