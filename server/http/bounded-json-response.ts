export class UpstreamResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Upstream response exceeded the ${maxBytes} byte limit`);
    this.name = "UpstreamResponseTooLargeError";
  }
}

/** Reads an upstream JSON response without allowing a provider to grow process memory without bound. */
export async function readBoundedJson<T>(response: Response, maxBytes: number): Promise<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("Upstream response limit must be a positive safe integer");
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpstreamResponseTooLargeError(maxBytes);
    }
  }

  if (!response.body) return JSON.parse("") as T;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpstreamResponseTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes).toString("utf8");
  return JSON.parse(body) as T;
}
