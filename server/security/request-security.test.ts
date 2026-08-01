import { describe, expect, it } from "vitest";
import { InMemoryFixedWindowRateLimiter, auditOutcome } from "./request-security";

describe("request security", () => {
  it("limits each scope and client independently and resets expired windows", () => {
    let now = 1_000;
    const limiter = new InMemoryFixedWindowRateLimiter(() => now);
    const policy = { limit: 2, windowMs: 5_000 };

    expect(limiter.consume("auth", "client-a", policy)).toMatchObject({ allowed: true, remaining: 1, resetAt: 6_000 });
    expect(limiter.consume("auth", "client-a", policy)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume("auth", "client-a", policy)).toMatchObject({ allowed: false, remaining: 0 });
    expect(limiter.consume("sync", "client-a", policy).allowed).toBe(true);
    expect(limiter.consume("auth", "client-b", policy).allowed).toBe(true);

    now = 6_000;
    expect(limiter.consume("auth", "client-a", policy)).toMatchObject({ allowed: true, remaining: 1, resetAt: 11_000 });
  });

  it("classifies audit outcomes from HTTP status", () => {
    expect(auditOutcome(302)).toBe("success");
    expect(auditOutcome(401)).toBe("rejected");
    expect(auditOutcome(503)).toBe("failed");
  });
});
