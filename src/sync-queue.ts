export const AUTO_SYNC_STATUS_KEY = "ai-learning-os-auto-sync-v1";

export type AutoSyncPhase = "idle" | "pending" | "syncing" | "offline" | "error" | "blocked";

export interface AutoSyncStatus {
  phase: AutoSyncPhase;
  lastSyncedAt?: string;
}

interface PersistedAutoSyncStatus {
  version: 1;
  pending: boolean;
  lastSyncedAt?: string;
}

interface AutoSyncQueueOptions {
  debounceMs?: number;
  retryDelaysMs?: number[];
  eventTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
  isOnline?: () => boolean;
  now?: () => Date;
  setTimer?: typeof window.setTimeout;
  clearTimer?: typeof window.clearTimeout;
  shouldRetry?: (error: unknown) => boolean;
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
    this.setPending(true);
    if (!this.isOnline()) {
      this.emit("offline");
      return;
    }
    this.emit("pending");
    this.schedule(this.debounceMs);
  }

  flushNow(): Promise<void> {
    this.generation += 1;
    this.setPending(true);
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    return this.flush();
  }

  completeExternalSync(): void {
    this.retryIndex = 0;
    this.setPending(false, this.now().toISOString());
    this.emit("idle");
  }

  clear(): void {
    this.stop();
    this.storage.removeItem(AUTO_SYNC_STATUS_KEY);
    this.persisted = { version: 1, pending: false };
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
    const generation = this.generation;
    this.emit("syncing");
    this.running = this.synchronize().then(() => {
      this.retryIndex = 0;
      const moreWork = generation !== this.generation;
      this.setPending(moreWork, this.now().toISOString());
      this.emit(moreWork ? "pending" : "idle");
      if (moreWork) this.schedule(this.debounceMs);
    }).catch((error: unknown) => {
      this.setPending(true);
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
    });
    return this.running;
  }

  private setPending(pending: boolean, lastSyncedAt = this.persisted.lastSyncedAt): void {
    this.persisted = { version: 1, pending, ...(lastSyncedAt ? { lastSyncedAt } : {}) };
    this.storage.setItem(AUTO_SYNC_STATUS_KEY, JSON.stringify(this.persisted));
  }

  private emit(phase: AutoSyncPhase): void {
    this.onStatus({ phase, lastSyncedAt: this.persisted.lastSyncedAt });
  }

  private load(): PersistedAutoSyncStatus {
    try {
      const parsed = JSON.parse(this.storage.getItem(AUTO_SYNC_STATUS_KEY) ?? "null") as Partial<PersistedAutoSyncStatus> | null;
      if (parsed?.version === 1 && typeof parsed.pending === "boolean") {
        return {
          version: 1,
          pending: parsed.pending,
          ...(typeof parsed.lastSyncedAt === "string" ? { lastSyncedAt: parsed.lastSyncedAt } : {}),
        };
      }
    } catch {
      // Queue metadata can be recreated without touching learning data.
    }
    return { version: 1, pending: false };
  }
}
