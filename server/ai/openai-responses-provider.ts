import { ModelProviderError, type ModelProvider, type StructuredGenerationRequest, type StructuredGenerationResult } from "./model-provider";

interface OpenAIProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
}

interface OpenAIResponseBody {
  id?: string;
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  error?: { message?: string };
}

function extractOutputText(body: OpenAIResponseBody): string | undefined {
  if (body.output_text) return body.output_text;
  for (const item of body.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  return undefined;
}

export class OpenAIResponsesProvider implements ModelProvider {
  readonly id = "openai-responses";
  readonly isAiEnabled = true;
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly config: OpenAIProviderConfig) {
    if (!config.apiKey.trim()) throw new Error("OpenAI API key is required");
    if (!config.model.trim()) throw new Error("OpenAI model is required");
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.fetchImplementation = config.fetchImplementation ?? fetch;
  }

  async generateStructured<T>(request: StructuredGenerationRequest): Promise<StructuredGenerationResult<T>> {
    const response = await this.fetchImplementation(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        instructions: request.instructions,
        input: request.input,
        text: {
          format: {
            type: "json_schema",
            name: request.schema.name,
            schema: request.schema.value,
            strict: true,
          },
        },
        store: false,
      }),
    });

    const body = await response.json() as OpenAIResponseBody;
    const requestId = response.headers.get("x-request-id") ?? body.id;
    if (!response.ok) {
      throw new ModelProviderError(body.error?.message ?? "OpenAI request failed", response.status, requestId);
    }

    const outputText = extractOutputText(body);
    if (!outputText) throw new ModelProviderError("OpenAI response did not contain structured output", 502, requestId);

    try {
      return { value: JSON.parse(outputText) as T, model: this.config.model, requestId };
    } catch {
      throw new ModelProviderError("OpenAI response contained invalid JSON", 502, requestId);
    }
  }
}
