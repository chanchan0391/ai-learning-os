export const AUTO_SYNC_STATUS_KEY = "ai-learning-os-auto-sync-v1";
const AUTO_SYNC_LOCK_NAME = "ai-learning-os-auto-sync-v1";
const AUTO_SYNC_LEASE_KEY = "ai-learning-os-auto-sync-lease-v1";

export type AutoSyncPhase = "idle" | "pending" | "syncing" | "offline" | "error" | "blocked";

export interface AutoSyncStatus {
  phase: AutoSyncPhase;
  lastSyncedAt?: string;
}

interface PersistedAutoSyncStatus {
  version: 2;
  pending: boolean;
  changeId?: string;
  lastSyncedAt?: string;
}

type ExclusiveRunner = (task: () => Promise<void>) => Promise<boolean>;
type Synchronize = (signal: AbortSignal) => Promise<void>;

interface AutoSyncQueueOptions {
  debounceMs?: number;
  retryDelaysMs?: number[];
  syncTimeoutMs?: number;
  eventTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
  isOnline?: () => boolean;
  now?: () => Date;
  setTimer?: typeof window.setTimeout;
  clearTimer?: typeof window.clearTimeout;
  shouldRetry?: (error: unknown) => boolean;
  runExclusive?: ExclusiveRunner;
}

function uniqueId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function storageLeaseRunner(
  storage: Storage,
  setTimer: typeof window.setTimeout,
  clearTimer: typeof window.clearTimeout,
): ExclusiveRunner {
  const ownerId = uniqueId();
  const leaseMs = 15_000;
  const heartbeatMs = 5_000;
  return async (task) => {
    let storageAvailable = true;
    const readLease = (): { ownerId: string; expiresAt: number } | null => {
      try {
        const parsed = JSON.parse(storage.getItem(AUTO_SYNC_LEASE_KEY) ?? "null") as { ownerId?: unknown; expiresAt?: unknown } | null;
        if (parsed && typeof parsed.ownerId === "string" && typeof parsed.expiresAt === "number") {
          return { ownerId: parsed.ownerId, expiresAt: parsed.expiresAt };
        }
        return null;
      } catch {
        storageAvailable = false;
        return null;
      }
    };
    const now = Date.now();
    const existing = readLease();
    if (!storageAvailable) {
      await task();
      return true;
    }
    if (existing && existing.ownerId !== ownerId && existing.expiresAt > now) return false;
    try {
      storage.setItem(AUTO_SYNC_LEASE_KEY, JSON.stringify({ ownerId, expiresAt: now + leaseMs }));
    } catch {
      await task();
      return true;
    }
    if (readLease()?.ownerId !== ownerId) return false;

    let heartbeat: number | undefined;
    const renew = () => {
      if (readLease()?.ownerId !== ownerId) return;
      try {
        storage.setItem(AUTO_SYNC_LEASE_KEY, JSON.stringify({ ownerId, expiresAt: Date.now() + leaseMs }));
      } catch {
        return;
      }
      heartbeat = setTimer(renew, heartbeatMs);
    };
    heartbeat = setTimer(renew, heartbeatMs);
    try {
      await task();
      return true;
    } finally {
      if (heartbeat !== undefined) clearTimer(heartbeat);
      if (readLease()?.ownerId === ownerId) {
        try {
          storage.removeItem(AUTO_SYNC_LEASE_KEY);
        } catch {
          // Lease expiry lets another tab recover when browser storage is writable again.
        }
      }
    }
  };
}

/**
 * Persistent, latest-state-wins queue for local-first browser synchronization.
 * Learning data remains in the learning repository; this queue only remembers
 * whether a newer local snapshot still needs reconciliation.
 */
export class AutoSyncQueue {
  private readonly debounceMs: number;
  private readonly retryDelaysMs: number[];
  private readonly syncTimeoutMs: number;
  private readonly eventTarget: AutoSyncQueueOptions["eventTarget"];
  private readonly isOnline: () => boolean;
  private readonly now: () => Date;
  private readonly setTimer: typeof window.setTimeout;
  private readonly clearTimer: typeof window.clearTimeout;
  private readonly shouldRetry: (error: unknown) => boolean;
  private readonly runExclusive: ExclusiveRunner;
  private timer: number | undefined;
  private running: Promise<void> | null = null;
  private activeSyncController: AbortController | null = null;
  private generation = 0;
  private retryIndex = 0;
  private started = false;
  private volatileMetadata = false;
  private clearGeneration = 0;
  private lifecycleGeneration = 0;
  private persisted: PersistedAutoSyncStatus;

  constructor(
    private readonly storage: Storage,
    private readonly synchronize: Synchronize,
    private readonly onStatus: (status: AutoSyncStatus) => void,
    options: AutoSyncQueueOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 1_500;
    this.retryDelaysMs = options.retryDelaysMs ?? [2_000, 5_000, 15_000, 30_000];
    this.syncTimeoutMs = options.syncTimeoutMs ?? 120_000;
    if (!Number.isFinite(this.syncTimeoutMs) || this.syncTimeoutMs <= 0) {
      throw new RangeError("Automatic sync timeout must be positive");
    }
    this.eventTarget = options.eventTarget ?? window;
    this.isOnline = options.isOnline ?? (() => navigator.onLine);
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? window.setTimeout.bind(window);
    this.clearTimer = options.clearTimer ?? window.clearTimeout.bind(window);
    this.shouldRetry = options.shouldRetry ?? (() => true);
    const fallback = storageLeaseRunner(storage, this.setTimer, this.clearTimer);
    this.runExclusive = options.runExclusive ?? (async (task) => {
      if (!navigator.locks) return fallback(task);
      let taskStarted = false;
      try {
        return await navigator.locks.request(AUTO_SYNC_LOCK_NAME, { ifAvailable: true }, async (lock) => {
          if (!lock) return false;
          taskStarted = true;
          await task();
          return true;
        });
      } catch (error) {
        // A denied or broken LockManager must not strand already-persisted work.
        // Never repeat a task whose callback actually started, though: the
        // reconciliation may already have produced remote side effects.
        if (taskStarted) throw error;
        return fallback(task);
      }
    });
    this.persisted = this.load();
  }

  getStatus(): AutoSyncStatus {
    return {
      phase: this.persisted.pending ? (this.isOnline() ? "pending" : "offline") : "idle",
      lastSyncedAt: this.persisted.lastSyncedAt,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.eventTarget?.addEventListener("online", this.handleOnline);
    this.eventTarget?.addEventListener("storage", this.handleStorage);
    // Keep an already-observed pending generation so external conflict
    // resolution can still prove it is not clearing a newer tab's edit.
    // An idle queue can safely adopt anything persisted while it was stopped.
    if (!this.volatileMetadata && !this.persisted.pending) this.persisted = this.load();
    this.emit(this.getStatus().phase);
    if (this.persisted.pending) this.schedule(0);
  }

  stop(): void {
    this.started = false;
    this.lifecycleGeneration += 1;
    this.activeSyncController?.abort();
    this.eventTarget?.removeEventListener("online", this.handleOnline);
    this.eventTarget?.removeEventListener("storage", this.handleStorage);
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.emit(this.getStatus().phase);
  }

  enqueue(): void {
    this.generation += 1;
    this.setPending(true, undefined, uniqueId());
    if (!this.isOnline()) {
      this.emit("offline");
      return;
    }
    this.emit("pending");
    this.schedule(this.debounceMs);
  }

  flushNow(): Promise<void> {
    this.generation += 1;
    this.setPending(true, undefined, uniqueId());
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    return this.flush();
  }

  completeExternalSync(): void {
    this.retryIndex = 0;
    const latest = this.load();
    if (latest.pending && latest.changeId !== this.persisted.changeId) {
      this.persisted = latest;
      this.emit("pending");
      this.schedule(this.debounceMs);
      return;
    }
    this.setPending(false, this.now().toISOString());
    this.emit("idle");
  }

  clear(): void {
    this.stop();
    this.clearGeneration += 1;
    try {
      this.storage.removeItem(AUTO_SYNC_STATUS_KEY);
      this.volatileMetadata = false;
    } catch {
      this.volatileMetadata = true;
    }
    this.persisted = { version: 2, pending: false };
    this.emit("idle");
  }

  private readonly handleOnline = () => {
    if (this.persisted.pending) this.schedule(0);
  };

  private readonly handleStorage = (event: Event) => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key !== AUTO_SYNC_STATUS_KEY
      || (storageEvent.storageArea !== null && storageEvent.storageArea !== this.storage)) return;
    const latest = this.load();
    if (this.volatileMetadata && this.persisted.pending) {
      // A failed metadata write makes the in-memory pending generation the only
      // evidence for this tab's already-committed learning change. Never let an
      // older idle value from another tab erase it. A distinct external pending
      // generation still schedules an additional reconciliation in case it was
      // written while the current synchronization was taking its snapshot.
      if (latest.pending && latest.changeId !== this.persisted.changeId) this.generation += 1;
      this.emit(this.isOnline() ? "pending" : "offline");
      if (this.isOnline()) this.schedule(0);
      return;
    }
    this.persisted = latest;
    if (!latest.pending) {
      if (!this.running) this.emit("idle");
      return;
    }
    if (!this.isOnline()) {
      this.emit("offline");
      return;
    }
    this.emit("pending");
    this.schedule(0);
  };

  private schedule(delay: number): void {
    if (!this.started) return;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
  }

  private flush(): Promise<void> {
    if (this.running) return this.running;
    if (!this.isOnline()) {
      this.emit("offline");
      return Promise.resolve();
    }
    const lifecycleGeneration = this.lifecycleGeneration;
    this.running = this.runExclusive(async () => {
      if (lifecycleGeneration !== this.lifecycleGeneration) return;
      if (!this.volatileMetadata) this.persisted = this.load();
      if (!this.persisted.pending) {
        this.emit("idle");
        return;
      }
      const generation = this.generation;
      const clearGeneration = this.clearGeneration;
      const changeId = this.persisted.changeId;
      this.emit("syncing");
      const controller = new AbortController();
      this.activeSyncController = controller;
      const timeout = this.setTimer(() => {
        controller.abort(new DOMException("Automatic synchronization timed out", "TimeoutError"));
      }, this.syncTimeoutMs);
      try {
        await this.synchronize(controller.signal);
        if (lifecycleGeneration !== this.lifecycleGeneration) return;
        if (clearGeneration !== this.clearGeneration) return;
        this.retryIndex = 0;
        const latest = this.volatileMetadata ? this.persisted : this.load();
        const moreWork = generation !== this.generation
          || (latest.pending && latest.changeId !== changeId);
        this.setPending(moreWork, this.now().toISOString(), moreWork ? latest.changeId : undefined);
        this.emit(moreWork ? "pending" : "idle");
        if (moreWork) this.schedule(this.debounceMs);
      } catch (error: unknown) {
        if (lifecycleGeneration !== this.lifecycleGeneration) return;
        if (clearGeneration !== this.clearGeneration) return;
        if (!this.volatileMetadata) this.persisted = this.load();
        if (!this.persisted.pending) this.setPending(true, undefined, changeId ?? uniqueId());
        if (!this.shouldRetry(error)) {
          this.emit("blocked");
          return;
        }
        if (!this.isOnline()) {
          this.emit("offline");
          return;
        }
        this.emit("error");
        const delay = this.retryDelaysMs[Math.min(this.retryIndex, this.retryDelaysMs.length - 1)] ?? 30_000;
        this.retryIndex += 1;
        this.schedule(delay);
      } finally {
        this.clearTimer(timeout);
        if (this.activeSyncController === controller) this.activeSyncController = null;
      }
    }).then((acquired) => {
      if (lifecycleGeneration !== this.lifecycleGeneration) return;
      if (acquired) return;
      this.persisted = this.load();
      this.emit(this.persisted.pending ? "pending" : "idle");
      if (this.persisted.pending) this.schedule(Math.min(this.debounceMs, 500));
    }).catch((error: unknown) => {
      if (lifecycleGeneration !== this.lifecycleGeneration) return;
      // Coordination itself can fail before the task callback runs. Preserve
      // the pending generation and use the same bounded retry policy as a
      // transient synchronization failure.
      if (!this.persisted.pending) this.setPending(true, undefined, uniqueId());
      if (!this.shouldRetry(error)) {
        this.emit("blocked");
        return;
      }
      if (!this.isOnline()) {
        this.emit("offline");
        return;
      }
      this.emit("error");
      const delay = this.retryDelaysMs[Math.min(this.retryIndex, this.retryDelaysMs.length - 1)] ?? 30_000;
      this.retryIndex += 1;
      this.schedule(delay);
    }).finally(() => {
      this.running = null;
      if (lifecycleGeneration !== this.lifecycleGeneration && this.started && this.persisted.pending) this.schedule(0);
    });
    return this.running;
  }

  private setPending(pending: boolean, lastSyncedAt = this.persisted.lastSyncedAt, changeId = this.persisted.changeId): void {
    this.persisted = {
      version: 2,
      pending,
      ...(pending && changeId ? { changeId } : {}),
      ...(lastSyncedAt ? { lastSyncedAt } : {}),
    };
    try {
      this.storage.setItem(AUTO_SYNC_STATUS_KEY, JSON.stringify(this.persisted));
      this.volatileMetadata = false;
    } catch {
      // Learning data is stored separately. Keep the queue usable in memory;
      // signed-in startup will enqueue reconciliation again after a reload.
      this.volatileMetadata = true;
    }
  }

  private emit(phase: AutoSyncPhase): void {
    this.onStatus({ phase, lastSyncedAt: this.persisted.lastSyncedAt });
  }

  private load(): PersistedAutoSyncStatus {
    try {
      const parsed = JSON.parse(this.storage.getItem(AUTO_SYNC_STATUS_KEY) ?? "null") as {
        version?: unknown;
        pending?: unknown;
        changeId?: unknown;
        lastSyncedAt?: unknown;
      } | null;
      if ((parsed?.version === 1 || parsed?.version === 2) && typeof parsed.pending === "boolean") {
        return {
          version: 2,
          pending: parsed.pending,
          ...(parsed.pending && typeof parsed.changeId === "string" ? { changeId: parsed.changeId } : {}),
          ...(typeof parsed.lastSyncedAt === "string" ? { lastSyncedAt: parsed.lastSyncedAt } : {}),
        };
      }
    } catch {
      // Queue metadata can be recreated without touching learning data.
    }
    return { version: 2, pending: false };
  }
}
