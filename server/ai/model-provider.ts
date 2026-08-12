export type JsonSchema = Record<string, unknown>;

export interface StructuredGenerationRequest {
  instructions: string;
  input: string;
  signal?: AbortSignal;
  schema: {
    name: string;
    value: JsonSchema;
  };
}

export interface StructuredGenerationResult<T> {
  value: T;
  model: string;
  requestId?: string;
  usage?: ModelTokenUsage;
}

export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ModelProvider {
  readonly id: string;
  readonly isAiEnabled: boolean;
  generateStructured<T>(request: StructuredGenerationRequest): Promise<StructuredGenerationResult<T>>;
}

const PROVIDER_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/**
 * Provider request IDs cross an untrusted upstream boundary before they are
 * returned to a browser or written to the usage ledger. Keep only a small,
 * log-safe correlation token rather than arbitrary response content.
 */
export function safeProviderRequestId(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && PROVIDER_REQUEST_ID_PATTERN.test(normalized) ? normalized : undefined;
}

export class ModelProviderError extends Error {
  constructor(message: string, readonly status = 502, readonly requestId?: string) {
    super(message);
    this.name = "ModelProviderError";
  }
}
