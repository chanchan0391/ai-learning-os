import { ModelProviderError, type ModelProvider, type StructuredGenerationRequest, type StructuredGenerationResult } from "./model-provider";
import { readBoundedJson, UpstreamResponseTooLargeError } from "../http/bounded-json-response";

interface OpenAIProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  apiMode?: "responses" | "chat-completions";
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  maxOutputTokens?: number;
  maxResponseBytes?: number;
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
export const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

interface OpenAIResponseBody {
  id?: string;
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string };
}

function extractUsage(body: OpenAIResponseBody) {
  const inputTokens = body.usage?.input_tokens ?? body.usage?.prompt_tokens;
  const outputTokens = body.usage?.output_tokens ?? body.usage?.completion_tokens;
  const totalTokens = body.usage?.total_tokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0));
  if (![inputTokens, outputTokens, totalTokens].every((value) => Number.isSafeInteger(value) && value! >= 0)) return undefined;
  return { inputTokens: inputTokens!, outputTokens: outputTokens!, totalTokens };
}

function extractOutputText(body: OpenAIResponseBody): string | undefined {
  if (body.output_text) return body.output_text;
  const chatContent = body.choices?.[0]?.message?.content;
  if (chatContent) return chatContent;
  for (const item of body.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  return undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function retryDelay(response: Response | undefined, attempt: number, baseDelayMs: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 10_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay > 0) return Math.min(dateDelay, 10_000);
  }
  return baseDelayMs * 2 ** attempt;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class OpenAIResponsesProvider implements ModelProvider {
  readonly id: string;
  readonly isAiEnabled = true;
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxOutputTokens: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly config: OpenAIProviderConfig) {
    if (!config.apiKey.trim()) throw new Error("OpenAI API key is required");
    if (!config.model.trim()) throw new Error("OpenAI model is required");
    this.id = config.apiMode === "chat-completions" ? "openai-compatible-chat" : "openai-responses";
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.fetchImplementation = config.fetchImplementation ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryDelayMs = config.retryDelayMs ?? 250;
    this.maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("OpenAI timeout must be positive");
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) throw new Error("OpenAI max retries must be a non-negative integer");
    if (!Number.isSafeInteger(this.maxOutputTokens) || this.maxOutputTokens <= 0) {
      throw new Error("OpenAI max output tokens must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new Error("OpenAI response byte limit must be a positive safe integer");
    }
  }

  async generateStructured<T>(request: StructuredGenerationRequest): Promise<StructuredGenerationResult<T>> {
    const format = {
      type: "json_schema",
      name: request.schema.name,
      schema: request.schema.value,
      strict: true,
    } as const;
    const chatCompletions = this.config.apiMode === "chat-completions";
    const body = JSON.stringify(chatCompletions ? {
      model: this.config.model,
      messages: [
        { role: "system", content: request.instructions },
        { role: "user", content: request.input },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: request.schema.name,
          schema: request.schema.value,
          strict: true,
        },
      },
      max_completion_tokens: this.maxOutputTokens,
      stream: false,
    } : {
      model: this.config.model,
      instructions: request.instructions,
      input: request.input,
      max_output_tokens: this.maxOutputTokens,
      text: { format },
      store: false,
    });

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (request.signal?.aborted) throw new ModelProviderError("Model request was cancelled", 499);
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort("timeout"), this.timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeoutController.signal]) : timeoutController.signal;
      let response: Response | undefined;
      try {
        const endpoint = chatCompletions ? "chat/completions" : "responses";
        response = await this.fetchImplementation(`${this.baseUrl}/${endpoint}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "X-Client-Request-Id": crypto.randomUUID(),
          },
          body,
          signal,
        });
        const responseBody = await readBoundedJson<OpenAIResponseBody>(response, this.maxResponseBytes);
        const requestId = response.headers.get("x-request-id") ?? responseBody.id;
        if (!response.ok) {
          if (attempt < this.maxRetries && isRetryableStatus(response.status)) {
            await wait(retryDelay(response, attempt, this.retryDelayMs), request.signal);
            continue;
          }
          throw new ModelProviderError(responseBody.error?.message ?? "OpenAI request failed", response.status, requestId);
        }

        const outputText = extractOutputText(responseBody);
        if (!outputText) throw new ModelProviderError("OpenAI response did not contain structured output", 502, requestId);
        try {
          const usage = extractUsage(responseBody);
          return {
            value: JSON.parse(outputText) as T,
            model: this.config.model,
            requestId,
            ...(usage ? { usage } : {}),
          };
        } catch {
          throw new ModelProviderError("OpenAI response contained invalid JSON", 502, requestId);
        }
      } catch (error) {
        if (error instanceof ModelProviderError) throw error;
        if (error instanceof UpstreamResponseTooLargeError) {
          throw new ModelProviderError("Model provider response was too large", 502, response?.headers.get("x-request-id") ?? undefined);
        }
        if (request.signal?.aborted) throw new ModelProviderError("Model request was cancelled", 499);
        if (timeoutController.signal.aborted) {
          if (attempt >= this.maxRetries) throw new ModelProviderError(`Model request timed out after ${this.timeoutMs}ms`, 504);
          await wait(retryDelay(response, attempt, this.retryDelayMs), request.signal);
          continue;
        }
        if (attempt >= this.maxRetries) throw new ModelProviderError("OpenAI request failed due to a network error", 502);
        await wait(retryDelay(response, attempt, this.retryDelayMs), request.signal);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new ModelProviderError("OpenAI request failed", 502);
  }
}
