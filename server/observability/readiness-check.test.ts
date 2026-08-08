import { describe, expect, it } from "vitest";
import { coalesceReadinessCheck } from "./readiness-check";

describe("coalesceReadinessCheck", () => {
  it("shares concurrent probes and starts a fresh probe after completion", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const check = coalesceReadinessCheck(async () => {
      calls += 1;
      if (calls === 1) await gate;
    });

    const first = check();
    const second = check();
    await Promise.resolve();
    expect(calls).toBe(1);

    release();
    await Promise.all([first, second]);
    await check();
    expect(calls).toBe(2);
  });

  it("shares failures but retries on the next probe", async () => {
    let calls = 0;
    const check = coalesceReadinessCheck(async () => {
      calls += 1;
      if (calls === 1) throw new Error("database unavailable");
    });

    const first = check();
    const second = check();
    await expect(first).rejects.toThrow("database unavailable");
    await expect(second).rejects.toThrow("database unavailable");
    expect(calls).toBe(1);

    await expect(check()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
