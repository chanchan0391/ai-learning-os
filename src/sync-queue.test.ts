// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_SYNC_STATUS_KEY, AutoSyncQueue, type AutoSyncStatus } from "./sync-queue";

describe("automatic sync queue", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it("coalesces rapid local changes and records the last successful sync", async () => {
    const synchronize = vi.fn(async () => undefined);
    const statuses: AutoSyncStatus[] = [];
    const queue = new AutoSyncQueue(localStorage, synchronize, (status) => statuses.push(status), {
      debounceMs: 100,
      now: () => new Date("2026-08-01T12:00:00.000Z"),
    });
    queue.start();

    queue.enqueue();
    queue.enqueue();
    await vi.advanceTimersByTimeAsync(100);

    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toEqual({ phase: "idle", lastSyncedAt: "2026-08-01T12:00:00.000Z" });
    expect(JSON.parse(localStorage.getItem(AUTO_SYNC_STATUS_KEY)!)).toEqual({
      version: 1, pending: false, lastSyncedAt: "2026-08-01T12:00:00.000Z",
    });
    queue.stop();
  });

  it("keeps work pending offline and retries as soon as connectivity returns", async () => {
    let online = false;
    const synchronize = vi.fn(async () => undefined);
    const queue = new AutoSyncQueue(localStorage, synchronize, () => undefined, {
      debounceMs: 100,
      isOnline: () => online,
    });
    queue.start();
    queue.enqueue();
    await vi.advanceTimersByTimeAsync(500);
    expect(synchronize).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(AUTO_SYNC_STATUS_KEY)!).pending).toBe(true);

    online = true;
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);

    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(AUTO_SYNC_STATUS_KEY)!).pending).toBe(false);
    queue.stop();
  });

  it("restores pending work after reload and backs off after a transient failure", async () => {
    localStorage.setItem(AUTO_SYNC_STATUS_KEY, JSON.stringify({ version: 1, pending: true }));
    const synchronize = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(undefined);
    const queue = new AutoSyncQueue(localStorage, synchronize, () => undefined, {
      retryDelaysMs: [250],
    });

    queue.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(synchronize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);

    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem(AUTO_SYNC_STATUS_KEY)!).pending).toBe(false);
    queue.stop();
  });

  it("leaves conflicts pending without repeatedly retrying them", async () => {
    const conflict = new Error("conflict");
    const synchronize = vi.fn(async () => { throw conflict; });
    const statuses: AutoSyncStatus[] = [];
    const queue = new AutoSyncQueue(localStorage, synchronize, (status) => statuses.push(status), {
      debounceMs: 10,
      retryDelaysMs: [10],
      shouldRetry: (error) => error !== conflict,
    });
    queue.start();
    queue.enqueue();
    await vi.advanceTimersByTimeAsync(100);

    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)?.phase).toBe("blocked");
    expect(JSON.parse(localStorage.getItem(AUTO_SYNC_STATUS_KEY)!).pending).toBe(true);
    queue.stop();
  });
});
