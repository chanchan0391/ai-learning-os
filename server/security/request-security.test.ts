import { describe, expect, it } from "vitest";
import { InMemoryFixedWindowRateLimiter, RollingRequestCapacityMonitor, auditOutcome } from "./request-security";

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

  it("reports rolling privacy-safe request capacity by scope", () => {
    let now = Date.parse("2026-08-01T12:00:01.000Z");
    const monitor = new RollingRequestCapacityMonitor(() => now);
    const completeRead = monitor.start("sync-read");
    now += 25;
    completeRead(200);
    const completeWrite = monitor.start("sync-write");
    now += 75;
    completeWrite(429, true);

    expect(monitor.snapshot()).toMatchObject({
      windowStartedAt: "2026-08-01T12:00:00.000Z",
      windowMs: 60_000,
      inFlight: 0,
      requests: 2,
      rejected: 1,
      failed: 0,
      rateLimited: 1,
      averageLatencyMs: 50,
      maxLatencyMs: 75,
      byScope: {
        "sync-read": { requests: 1, rejected: 0, failed: 0, rateLimited: 0 },
        "sync-write": { requests: 1, rejected: 1, failed: 0, rateLimited: 1 },
      },
    });

    now += 60_000;
    expect(monitor.snapshot()).toMatchObject({ requests: 0, rejected: 0, rateLimited: 0, byScope: {} });
  });
});
