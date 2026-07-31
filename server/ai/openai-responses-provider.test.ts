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
      expect(body).toMatchObject({ model: "test-model", store: false, text: { format: { type: "json_schema", name: "plan", strict: true } } });
      return new Response(JSON.stringify({ id: "resp_1", output: [{ content: [{ type: "output_text", text: "{\"ok\":true}" }] }] }), { status: 200 });
    });
    const provider = new OpenAIResponsesProvider({ apiKey: "secret", model: "test-model", fetchImplementation: fetchMock as typeof fetch });
    await expect(provider.generateStructured<{ ok: boolean }>(request)).resolves.toMatchObject({ value: { ok: true }, model: "test-model" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("converts provider failures to safe typed errors", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "secret", model: "test-model",
      fetchImplementation: (async () => new Response(JSON.stringify({ error: { message: "Rate limited" } }), { status: 429, headers: { "x-request-id": "req_1" } })) as typeof fetch,
    });
    await expect(provider.generateStructured(request)).rejects.toEqual(new ModelProviderError("Rate limited", 429, "req_1"));
  });
});
