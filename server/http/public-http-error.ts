/**
 * Marks a fixed, request-safe message that may be returned to an API client.
 *
 * Unexpected built-in errors are deliberately not public: adapter and dependency
 * messages can contain learning content, credentials, or private infrastructure.
 */
export class PublicHttpError extends Error {
  constructor(readonly status: 400 | 403 | 413 | 415 | 428, message: string) {
    super(message);
    this.name = "PublicHttpError";
  }
}
