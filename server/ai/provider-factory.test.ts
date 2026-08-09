import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelProvider } from "./provider-factory";

afterEach(() => vi.unstubAllGlobals());

describe("createModelProvider", () => {
  it("keeps deterministic mode when no model credentials are configured", () => {
    expect(createModelProvider({}).id).toBe("deterministic-development");
  });

  it("uses an OpenAI-compatible key and base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "request-1",
      choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createModelProvider({
      OPENAI_COMPATIBLE_API_KEY: "compatible-key",
      OPENAI_COMPATIBLE_BASE_URL: "https://models.example/",
      OPENAI_MODEL: "compatible-model",
    });
    expect(provider.id).toBe("openai-compatible-chat");
    await provider.generateStructured({
      instructions: "Return JSON",
      input: "test",
      schema: { name: "test_result", value: { type: "object" } },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://models.example/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer compatible-key" }),
      }),
    );
  });

  it("rejects an incomplete compatible configuration", () => {
    expect(() => createModelProvider({
      OPENAI_COMPATIBLE_API_KEY: "compatible-key",
      OPENAI_MODEL: "compatible-model",
    })).toThrow("OPENAI_COMPATIBLE_BASE_URL");
  });

  it("never mixes an OpenAI key with a compatible endpoint", () => {
    expect(() => createModelProvider({
      OPENAI_API_KEY: "openai-key",
      OPENAI_COMPATIBLE_API_KEY: "compatible-key",
      OPENAI_COMPATIBLE_BASE_URL: "https://models.example/v1",
      OPENAI_MODEL: "model",
    })).toThrow("not both");
  });

  it("rejects insecure remote compatible endpoints", () => {
    expect(() => createModelProvider({
      OPENAI_COMPATIBLE_API_KEY: "compatible-key",
      OPENAI_COMPATIBLE_BASE_URL: "http://models.example/v1",
      OPENAI_COMPATIBLE_MODEL: "model",
    })).toThrow("must be HTTPS");
  });

  it("rejects compatible endpoints with embedded credentials", () => {
    expect(() => createModelProvider({
      OPENAI_COMPATIBLE_API_KEY: "compatible-key",
      OPENAI_COMPATIBLE_BASE_URL: "https://operator:secret@models.example/v1",
      OPENAI_COMPATIBLE_MODEL: "model",
    })).toThrow(/without credentials/);
  });

  it("allows a loopback HTTP compatible endpoint for development", () => {
    expect(createModelProvider({
      OPENAI_COMPATIBLE_API_KEY: "compatible-key",
      OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:1234",
      OPENAI_COMPATIBLE_MODEL: "model",
    }).id).toBe("openai-compatible-chat");
  });

  it("passes an explicit output cap to model requests", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ max_output_tokens: 768 });
      return new Response(JSON.stringify({ output_text: "{\"ok\":true}" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createModelProvider({
      OPENAI_API_KEY: "openai-key", OPENAI_MODEL: "model", OPENAI_MAX_OUTPUT_TOKENS: "768",
    });
    await provider.generateStructured({ instructions: "Return JSON", input: "test", schema: { name: "result", value: {} } });
  });

  it("rejects an invalid or orphaned output cap", () => {
    expect(() => createModelProvider({ OPENAI_MAX_OUTPUT_TOKENS: "0" })).toThrow(/positive integer/);
    expect(() => createModelProvider({ OPENAI_MAX_OUTPUT_TOKENS: "512" })).toThrow(/requires a configured model provider/);
  });

  it("accepts a total request deadline only with a configured provider", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ output_text: "{\"ok\":true}" })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createModelProvider({
      OPENAI_API_KEY: "openai-key", OPENAI_MODEL: "model", OPENAI_TOTAL_TIMEOUT_MS: "12000",
    });
    await expect(provider.generateStructured({ instructions: "Return JSON", input: "test", schema: { name: "result", value: {} } })).resolves.toMatchObject({ value: { ok: true } });
    expect(() => createModelProvider({ OPENAI_TOTAL_TIMEOUT_MS: "0" })).toThrow(/positive integer/);
    expect(() => createModelProvider({ OPENAI_TOTAL_TIMEOUT_MS: "12000" })).toThrow(/requires a configured model provider/);
  });
});
