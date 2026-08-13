import { describe, expect, it } from "vitest";
import {
  readBoundedJson,
  UpstreamResponseInvalidEncodingError,
  UpstreamResponseTooLargeError,
} from "./bounded-json-response";

describe("bounded upstream JSON responses", () => {
  it("parses valid UTF-8 JSON within the byte limit", async () => {
    await expect(readBoundedJson(Response.json({ value: "学习" }), 64)).resolves.toEqual({ value: "学习" });
  });

  it("rejects a chunked response that crosses the byte limit", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"value":"${"x".repeat(80)}"}`));
      },
    }));

    await expect(readBoundedJson(response, 64)).rejects.toBeInstanceOf(UpstreamResponseTooLargeError);
  });

  it("rejects malformed UTF-8 instead of decoding replacement characters", async () => {
    const response = new Response(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]));

    await expect(readBoundedJson(response, 64)).rejects.toBeInstanceOf(UpstreamResponseInvalidEncodingError);
  });
});
