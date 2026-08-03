import { describe, expect, it, vi } from "vitest";
import { ModelProviderError } from "./model-provider";
import { OpenAIResponsesProvider } from "./openai-responses-provider";

const request = {
  instructions: "Return a plan",
  input: "goal",
  schema: { name: "plan", value: { type: "object" } },
};

describe("OpenAI Responses provider", () => {
  it("sends a strict structured-output request without exposing configuration", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(init?.headers).toMatchObject({ Authorization: "Bearer secret", "Content-Type": "application/json" });
      expect((init?.headers as Record<string, string>)["X-Client-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(body).toMatchObject({ model: "test-model", store: false, text: { format: { type: "json_schema", name: "plan", strict: true } } });
      return new Response(JSON.stringify({ id: "resp_1", output: [{ content: [{ type: "output_text", text: "{\"ok\":true}" }] }] }), { status: 200 });
    });
    const provider = new OpenAIResponsesProvider({ apiKey: "secret", model: "test-model", fetchImplementation: fetchMock as typeof fetch });
    await expect(provider.generateStructured<{ ok: boolean }>(request)).resolves.toMatchObject({ value: { ok: true }, model: "test-model" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("normalizes Responses and compatible token usage for account metering", async () => {
    const responsesProvider = new OpenAIResponsesProvider({
      apiKey: "secret", model: "responses-model",
      fetchImplementation: (async () => new Response(JSON.stringify({
        output_text: "{\"ok\":true}", usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
      }))) as typeof fetch,
    });
    await expect(responsesProvider.generateStructured(request)).resolves.toMatchObject({
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });

    const compatibleProvider = new OpenAIResponsesProvider({
      apiKey: "secret", model: "compatible-model", apiMode: "chat-completions",
      fetchImplementation: (async () => new Response(JSON.stringify({
        choices: [{ message: { content: "{\"ok\":true}" } }],
        usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
      }))) as typeof fetch,
    });
    await expect(compatibleProvider.generateStructured(request)).resolves.toMatchObject({
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    });
  });

  it("converts provider failures to safe typed errors", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "secret", model: "test-model",
      fetchImplementation: (async () => new Response(JSON.stringify({ error: { message: "Rate limited" } }), { status: 429, headers: { "x-request-id": "req_1" } })) as typeof fetch,
    });
    await expect(provider.generateStructured(request)).rejects.toEqual(new ModelProviderError("Rate limited", 429, "req_1"));
  });

  it("retries transient failures with one logical result", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Busy" } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: "{\"ok\":true}" }), { status: 200 }));
    const provider = new OpenAIResponsesProvider({
      apiKey: "secret", model: "test-model", retryDelayMs: 0,
      fetchImplementation: fetchMock as typeof fetch,
    });

    await expect(provider.generateStructured<{ ok: boolean }>(request)).resolves.toMatchObject({ value: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent request failures", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Bad input" } }), { status: 400 }));
    const provider = new OpenAIResponsesProvider({
      apiKey: "secret", model: "test-model", retryDelayMs: 0,
      fetchImplementation: fetchMock as typeof fetch,
    });

    await expect(provider.generateStructured(request)).rejects.toEqual(new ModelProviderError("Bad input", 400));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("times out bounded attempts and reports a gateway timeout", async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const provider = new OpenAIResponsesProvider({
      apiKey: "secret", model: "test-model", timeoutMs: 5, maxRetries: 1, retryDelayMs: 0,
      fetchImplementation: fetchMock as typeof fetch,
    });

    await expect(provider.generateStructured(request)).rejects.toEqual(new ModelProviderError("Model request timed out after 5ms", 504));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cancels immediately when the caller aborts", async () => {
    const fetchMock = vi.fn();
    const provider = new OpenAIResponsesProvider({ apiKey: "secret", model: "test-model", fetchImplementation: fetchMock as typeof fetch });
    const controller = new AbortController();
    controller.abort();

    await expect(provider.generateStructured({ ...request, signal: controller.signal })).rejects.toEqual(new ModelProviderError("Model request was cancelled", 499));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
