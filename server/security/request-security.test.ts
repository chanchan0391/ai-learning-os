import { describe, expect, it, vi } from "vitest";
import {
  InMemoryFixedWindowRateLimiter,
  JsonLineSecurityAuditSink,
  RollingRequestCapacityMonitor,
  auditOutcome,
} from "./request-security";

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

  it("writes stable pseudonymous principal references instead of raw identifiers", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sink = new JsonLineSecurityAuditSink();
    const event = {
      occurredAt: "2026-08-04T04:00:00.000Z",
      action: "sync.plan.write",
      method: "PUT",
      path: "/api/sync/plans/plan-1",
      status: 200,
      outcome: "success" as const,
      userId: "user-private-id",
      deviceId: "device-private-id",
    };

    sink.record(event);
    sink.record(event);

    const first = JSON.parse(String(log.mock.calls[0][0])) as Record<string, unknown>;
    const second = JSON.parse(String(log.mock.calls[1][0])) as Record<string, unknown>;
    expect(first).toMatchObject({ type: "security_audit", action: event.action, status: 200 });
    expect(first).not.toHaveProperty("userId");
    expect(first).not.toHaveProperty("deviceId");
    expect(first.userRef).toMatch(/^[0-9a-f]{32}$/);
    expect(first.deviceRef).toMatch(/^[0-9a-f]{32}$/);
    expect(first.userRef).not.toBe(first.deviceRef);
    expect(second.userRef).toBe(first.userRef);
    expect(second.deviceRef).toBe(first.deviceRef);
    expect(log.mock.calls.flat().join(" ")).not.toContain("private-id");
    log.mockRestore();
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
