import { describe, expect, it } from "vitest";
import { PostgresPoolCapacityMonitor } from "./database-capacity";

describe("PostgresPoolCapacityMonitor", () => {
  it("reports identifier-free connection capacity", () => {
    const counters = { totalCount: 7, idleCount: 2, waitingCount: 0 };
    const monitor = new PostgresPoolCapacityMonitor(counters, 10);

    expect(monitor.snapshot()).toEqual({
      limit: 10, total: 7, idle: 2, inUse: 5, waiting: 0, saturated: false,
    });
  });

  it("marks a fully used pool or queued acquisition as saturated", () => {
    const counters = { totalCount: 10, idleCount: 0, waitingCount: 0 };
    const monitor = new PostgresPoolCapacityMonitor(counters, 10);
    expect(monitor.snapshot()).toMatchObject({ inUse: 10, waiting: 0, saturated: true });

    counters.totalCount = 8;
    counters.waitingCount = 3;
    expect(monitor.snapshot()).toMatchObject({ inUse: 8, waiting: 3, saturated: true });
  });

  it("bounds invalid dependency counters and rejects invalid limits", () => {
    const monitor = new PostgresPoolCapacityMonitor({
      totalCount: Number.NaN, idleCount: 5, waitingCount: -1,
    }, 10);
    expect(monitor.snapshot()).toEqual({
      limit: 10, total: 0, idle: 0, inUse: 0, waiting: 0, saturated: false,
    });
    expect(() => new PostgresPoolCapacityMonitor({ totalCount: 0, idleCount: 0, waitingCount: 0 }, 0))
      .toThrow(/positive integer/);
  });
});
