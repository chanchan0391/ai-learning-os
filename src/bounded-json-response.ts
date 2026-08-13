export class ResponseTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseTooLargeError";
  }
}

export class ResponseInvalidEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseInvalidEncodingError";
  }
}

/** Reads browser API JSON without allowing an anomalous response to grow memory without bound. */
export async function readBoundedJson<T>(response: Response, maxBytes: number, tooLargeMessage: string): Promise<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("Response limit must be a positive safe integer");
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(tooLargeMessage);
    }
  }

  if (!response.body) return JSON.parse("") as T;

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  const bodyChunks: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(tooLargeMessage);
      }
      try {
        bodyChunks.push(decoder.decode(value, { stream: true }));
      } catch {
        await reader.cancel().catch(() => undefined);
        throw new ResponseInvalidEncodingError("API 响应不是有效的 UTF-8 JSON，请稍后重试");
      }
    }
    try {
      bodyChunks.push(decoder.decode());
    } catch {
      throw new ResponseInvalidEncodingError("API 响应不是有效的 UTF-8 JSON，请稍后重试");
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(bodyChunks.join("")) as T;
}
