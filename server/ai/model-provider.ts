export type JsonSchema = Record<string, unknown>;

export interface StructuredGenerationRequest {
  instructions: string;
  input: string;
  schema: {
    name: string;
    value: JsonSchema;
  };
}

export interface StructuredGenerationResult<T> {
  value: T;
  model: string;
  requestId?: string;
}

export interface ModelProvider {
  readonly id: string;
  readonly isAiEnabled: boolean;
  generateStructured<T>(request: StructuredGenerationRequest): Promise<StructuredGenerationResult<T>>;
}

export class ModelProviderError extends Error {
  constructor(message: string, readonly status = 502, readonly requestId?: string) {
    super(message);
    this.name = "ModelProviderError";
  }
}
