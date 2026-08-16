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
      version: 2, pending: false, lastSyncedAt: "2026-08-01T12:00:00.000Z",
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

  it("lets only one tab reconcile a shared pending generation", async () => {
    localStorage.setItem(AUTO_SYNC_STATUS_KEY, JSON.stringify({ version: 2, pending: true, changeId: "change-1" }));
    let lockHeld = false;
    const runExclusive = async (task: () => Promise<void>) => {
      if (lockHeld) return false;
      lockHeld = true;
      try {
        await task();
        return true;
      } finally {
        lockHeld = false;
      }
    };
    let release!: () => void;
    const firstSync = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const secondSync = vi.fn(async () => undefined);
    const first = new AutoSyncQueue(localStorage, firstSync, () => undefined, { runExclusive, debounceMs: 100 });
    const second = new AutoSyncQueue(localStorage, secondSync, () => undefined, { runExclusive, debounceMs: 100 });

    first.start();
    second.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(firstSync).toHaveBeenCalledTimes(1);
    expect(secondSync).not.toHaveBeenCalled();

    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(secondSync).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(AUTO_SYNC_STATUS_KEY)!).pending).toBe(false);
    first.stop();
    second.stop();
  });

  it("preserves a newer generation enqueued by another tab during synchronization", async () => {
    localStorage.setItem(AUTO_SYNC_STATUS_KEY, JSON.stringify({ version: 2, pending: true, changeId: "change-1" }));
    let release!: () => void;
    const synchronize = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockResolvedValue(undefined);
    const queue = new AutoSyncQueue(localStorage, synchronize, () => undefined, {
      debounceMs: 100,
      runExclusive: async (task) => { await task(); return true; },
    });
    queue.start();
    await vi.advanceTimersByTimeAsync(0);

    localStorage.setItem(AUTO_SYNC_STATUS_KEY, JSON.stringify({ version: 2, pending: true, changeId: "change-2" }));
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(localStorage.getItem(AUTO_SYNC_STATUS_KEY)!)).toMatchObject({ pending: true, changeId: "change-2" });

    await vi.advanceTimersByTimeAsync(100);
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem(AUTO_SYNC_STATUS_KEY)!).pending).toBe(false);
    queue.stop();
  });

  it("migrates version one queue metadata without losing pending work", () => {
    localStorage.setItem(AUTO_SYNC_STATUS_KEY, JSON.stringify({ version: 1, pending: true, lastSyncedAt: "2026-08-01T10:00:00.000Z" }));
    const queue = new AutoSyncQueue(localStorage, async () => undefined, () => undefined);
    expect(queue.getStatus()).toEqual({ phase: "pending", lastSyncedAt: "2026-08-01T10:00:00.000Z" });
  });

  it("does not clear another tab's newer generation after external conflict resolution", async () => {
    localStorage.setItem(AUTO_SYNC_STATUS_KEY, JSON.stringify({ version: 2, pending: true, changeId: "conflict" }));
    const synchronize = vi.fn(async () => undefined);
    const queue = new AutoSyncQueue(localStorage, synchronize, () => undefined, { debounceMs: 100 });
    queue.start();
    queue.stop();

    localStorage.setItem(AUTO_SYNC_STATUS_KEY, JSON.stringify({ version: 2, pending: true, changeId: "newer-tab-edit" }));
    queue.start();
    queue.completeExternalSync();
    expect(JSON.parse(localStorage.getItem(AUTO_SYNC_STATUS_KEY)!)).toMatchObject({ pending: true, changeId: "newer-tab-edit" });

    await vi.advanceTimersByTimeAsync(100);
    expect(synchronize).toHaveBeenCalledTimes(1);
    queue.stop();
  });

  it("continues synchronization in memory when queue metadata cannot be written", async () => {
    const storage = {
      get length() { return localStorage.length; },
      clear: () => localStorage.clear(),
      getItem: (key: string) => localStorage.getItem(key),
      key: (index: number) => localStorage.key(index),
      removeItem: (key: string) => localStorage.removeItem(key),
      setItem: () => { throw new DOMException("blocked", "QuotaExceededError"); },
    } satisfies Storage;
    const synchronize = vi.fn(async () => undefined);
    const statuses: AutoSyncStatus[] = [];
    const queue = new AutoSyncQueue(storage, synchronize, (status) => statuses.push(status), {
      debounceMs: 10,
      runExclusive: async (task) => { await task(); return true; },
    });
    queue.start();

    expect(() => queue.enqueue()).not.toThrow();
    await vi.advanceTimersByTimeAsync(10);

    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)?.phase).toBe("idle");
    queue.stop();
  });

  it("falls back to an idempotent sync when lease storage is unavailable", async () => {
    const storage = {
      get length() { return localStorage.length; },
      clear: () => localStorage.clear(),
      getItem: (key: string) => {
        if (key.includes("lease")) throw new DOMException("blocked", "SecurityError");
        return localStorage.getItem(key);
      },
      key: (index: number) => localStorage.key(index),
      removeItem: (key: string) => localStorage.removeItem(key),
      setItem: (key: string, value: string) => localStorage.setItem(key, value),
    } satisfies Storage;
    const synchronize = vi.fn(async () => undefined);
    const queue = new AutoSyncQueue(storage, synchronize, () => undefined, { debounceMs: 10 });
    queue.start();
    queue.enqueue();

    await vi.advanceTimersByTimeAsync(10);

    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(queue.getStatus().phase).toBe("idle");
    queue.stop();
  });

  it("falls back to the storage lease when Web Locks fails before granting a lock", async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: vi.fn().mockRejectedValue(new DOMException("blocked", "SecurityError")) },
    });
    const synchronize = vi.fn(async () => undefined);
    const queue = new AutoSyncQueue(localStorage, synchronize, () => undefined, { debounceMs: 10 });
    queue.start();
    queue.enqueue();

    await vi.advanceTimersByTimeAsync(10);

    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(queue.getStatus().phase).toBe("idle");
    queue.stop();
    if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
    else Reflect.deleteProperty(navigator, "locks");
  });

  it("preserves and retries work when exclusive coordination rejects", async () => {
    const runExclusive = vi.fn()
      .mockRejectedValueOnce(new Error("coordination unavailable"))
      .mockImplementationOnce(async (task: () => Promise<void>) => { await task(); return true; });
    const synchronize = vi.fn(async () => undefined);
    const statuses: AutoSyncStatus[] = [];
    const queue = new AutoSyncQueue(localStorage, synchronize, (status) => statuses.push(status), {
      debounceMs: 10,
      retryDelaysMs: [25],
      runExclusive,
    });
    queue.start();
    queue.enqueue();

    await vi.advanceTimersByTimeAsync(10);
    expect(statuses.at(-1)?.phase).toBe("error");
    expect(JSON.parse(localStorage.getItem(AUTO_SYNC_STATUS_KEY)!).pending).toBe(true);
    await vi.advanceTimersByTimeAsync(25);

    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(queue.getStatus().phase).toBe("idle");
    queue.stop();
  });

  it("does not recreate cleared metadata when an in-flight sync settles", async () => {
    let release!: () => void;
    const synchronize = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const statuses: AutoSyncStatus[] = [];
    const queue = new AutoSyncQueue(localStorage, synchronize, (status) => statuses.push(status), {
      debounceMs: 10,
      runExclusive: async (task) => { await task(); return true; },
    });
    queue.start();
    queue.enqueue();
    await vi.advanceTimersByTimeAsync(10);

    queue.clear();
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(localStorage.getItem(AUTO_SYNC_STATUS_KEY)).toBeNull();
    expect(statuses.at(-1)?.phase).toBe("idle");
  });

  it("preserves pending work when stopped during an in-flight sync", async () => {
    let release!: () => void;
    const synchronize = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const statuses: AutoSyncStatus[] = [];
    const queue = new AutoSyncQueue(localStorage, synchronize, (status) => statuses.push(status), {
      debounceMs: 10,
      runExclusive: async (task) => { await task(); return true; },
    });
    queue.start();
    queue.enqueue();
    await vi.advanceTimersByTimeAsync(10);

    queue.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(JSON.parse(localStorage.getItem(AUTO_SYNC_STATUS_KEY)!).pending).toBe(true);
    expect(statuses.at(-1)?.phase).toBe("pending");
  });

  it("aborts in-flight synchronization when stopped and preserves its pending generation", async () => {
    let observedSignal!: AbortSignal;
    const synchronize = vi.fn((signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const statuses: AutoSyncStatus[] = [];
    const queue = new AutoSyncQueue(localStorage, synchronize, (status) => statuses.push(status), {
      debounceMs: 10,
      runExclusive: async (task) => { await task(); return true; },
    });
    queue.start();
    queue.enqueue();
    await vi.advanceTimersByTimeAsync(10);

    queue.stop();
    await vi.advanceTimersByTimeAsync(0);

    expect(observedSignal.aborted).toBe(true);
    expect(JSON.parse(localStorage.getItem(AUTO_SYNC_STATUS_KEY)!).pending).toBe(true);
    expect(statuses.at(-1)?.phase).toBe("pending");
  });

  it("does not start work after stopping while exclusive coordination is pending", async () => {
    let grant!: () => void;
    const runExclusive = vi.fn(async (task: () => Promise<void>) => {
      await new Promise<void>((resolve) => { grant = resolve; });
      await task();
      return true;
    });
    const synchronize = vi.fn().mockResolvedValue(undefined);
    const queue = new AutoSyncQueue(localStorage, synchronize, () => undefined, {
      debounceMs: 10,
      runExclusive,
    });
    queue.start();
    queue.enqueue();
    await vi.advanceTimersByTimeAsync(10);

    queue.stop();
    grant();
    await vi.advanceTimersByTimeAsync(0);

    expect(synchronize).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(AUTO_SYNC_STATUS_KEY)!).pending).toBe(true);
  });

  it("runs preserved work after restarting once stale in-flight work settles", async () => {
    let release!: () => void;
    const synchronize = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockResolvedValueOnce(undefined);
    const queue = new AutoSyncQueue(localStorage, synchronize, () => undefined, {
      debounceMs: 10,
      runExclusive: async (task) => { await task(); return true; },
    });
    queue.start();
    queue.enqueue();
    await vi.advanceTimersByTimeAsync(10);
    queue.stop();
    queue.start();

    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(queue.getStatus().phase).toBe("idle");
    queue.stop();
  });
});
