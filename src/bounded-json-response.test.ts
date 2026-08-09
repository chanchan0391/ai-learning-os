import { describe, expect, it } from "vitest";
import { readBoundedJson, ResponseTooLargeError } from "./bounded-json-response";

describe("bounded browser JSON responses", () => {
  it("parses a response within the byte limit", async () => {
    const response = Response.json({ ok: true });

    await expect(readBoundedJson(response, 64, "too large")).resolves.toEqual({ ok: true });
  });

  it("rejects an oversized declared response before reading it", async () => {
    const response = new Response("{}", { headers: { "Content-Length": "65" } });

    await expect(readBoundedJson(response, 64, "too large"))
      .rejects.toEqual(expect.objectContaining({ name: "ResponseTooLargeError", message: "too large" }));
  });

  it("cancels a chunked response that crosses the byte limit", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"value":"${"x".repeat(80)}"}`));
      },
      cancel() {
        cancelled = true;
      },
    }));

    await expect(readBoundedJson(response, 64, "too large")).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(cancelled).toBe(true);
  });
});
