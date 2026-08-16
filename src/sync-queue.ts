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

interface AutoSyncQueueOptions {
  debounceMs?: number;
  retryDelaysMs?: number[];
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
    const readLease = (): { ownerId: string; expiresAt: number } | null => {
      try {
        const parsed = JSON.parse(storage.getItem(AUTO_SYNC_LEASE_KEY) ?? "null") as { ownerId?: unknown; expiresAt?: unknown } | null;
        if (parsed && typeof parsed.ownerId === "string" && typeof parsed.expiresAt === "number") {
          return { ownerId: parsed.ownerId, expiresAt: parsed.expiresAt };
        }
        return null;
      } catch {
        return null;
      }
    };
    const now = Date.now();
    const existing = readLease();
    if (existing && existing.ownerId !== ownerId && existing.expiresAt > now) return false;
    storage.setItem(AUTO_SYNC_LEASE_KEY, JSON.stringify({ ownerId, expiresAt: now + leaseMs }));
    if (readLease()?.ownerId !== ownerId) return false;

    let heartbeat: number | undefined;
    const renew = () => {
      if (readLease()?.ownerId !== ownerId) return;
      storage.setItem(AUTO_SYNC_LEASE_KEY, JSON.stringify({ ownerId, expiresAt: Date.now() + leaseMs }));
      heartbeat = setTimer(renew, heartbeatMs);
    };
    heartbeat = setTimer(renew, heartbeatMs);
    try {
      await task();
      return true;
    } finally {
      if (heartbeat !== undefined) clearTimer(heartbeat);
      if (readLease()?.ownerId === ownerId) storage.removeItem(AUTO_SYNC_LEASE_KEY);
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
  private readonly eventTarget: AutoSyncQueueOptions["eventTarget"];
  private readonly isOnline: () => boolean;
  private readonly now: () => Date;
  private readonly setTimer: typeof window.setTimeout;
  private readonly clearTimer: typeof window.clearTimeout;
  private readonly shouldRetry: (error: unknown) => boolean;
  private readonly runExclusive: ExclusiveRunner;
  private timer: number | undefined;
  private running: Promise<void> | null = null;
  private generation = 0;
  private retryIndex = 0;
  private started = false;
  private persisted: PersistedAutoSyncStatus;

  constructor(
    private readonly storage: Storage,
    private readonly synchronize: () => Promise<void>,
    private readonly onStatus: (status: AutoSyncStatus) => void,
    options: AutoSyncQueueOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 1_500;
    this.retryDelaysMs = options.retryDelaysMs ?? [2_000, 5_000, 15_000, 30_000];
    this.eventTarget = options.eventTarget ?? window;
    this.isOnline = options.isOnline ?? (() => navigator.onLine);
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? window.setTimeout.bind(window);
    this.clearTimer = options.clearTimer ?? window.clearTimeout.bind(window);
    this.shouldRetry = options.shouldRetry ?? (() => true);
    const fallback = storageLeaseRunner(storage, this.setTimer, this.clearTimer);
    this.runExclusive = options.runExclusive ?? (async (task) => {
      if (!navigator.locks) return fallback(task);
      return navigator.locks.request(AUTO_SYNC_LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) return false;
        await task();
        return true;
      });
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
    this.emit(this.getStatus().phase);
    if (this.persisted.pending) this.schedule(0);
  }

  stop(): void {
    this.started = false;
    this.eventTarget?.removeEventListener("online", this.handleOnline);
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
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
    this.storage.removeItem(AUTO_SYNC_STATUS_KEY);
    this.persisted = { version: 2, pending: false };
    this.emit("idle");
  }

  private readonly handleOnline = () => {
    if (this.persisted.pending) this.schedule(0);
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
    this.running = this.runExclusive(async () => {
      this.persisted = this.load();
      if (!this.persisted.pending) {
        this.emit("idle");
        return;
      }
      const generation = this.generation;
      const changeId = this.persisted.changeId;
      this.emit("syncing");
      try {
        await this.synchronize();
        this.retryIndex = 0;
        const latest = this.load();
        const moreWork = generation !== this.generation
          || (latest.pending && latest.changeId !== changeId);
        this.setPending(moreWork, this.now().toISOString(), moreWork ? latest.changeId : undefined);
        this.emit(moreWork ? "pending" : "idle");
        if (moreWork) this.schedule(this.debounceMs);
      } catch (error: unknown) {
        this.persisted = this.load();
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
      }
    }).then((acquired) => {
      if (acquired) return;
      this.persisted = this.load();
      this.emit(this.persisted.pending ? "pending" : "idle");
      if (this.persisted.pending) this.schedule(Math.min(this.debounceMs, 500));
    }).finally(() => {
      this.running = null;
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
    this.storage.setItem(AUTO_SYNC_STATUS_KEY, JSON.stringify(this.persisted));
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
