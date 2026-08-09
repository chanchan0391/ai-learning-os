export interface DatabasePoolCounters {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

export interface DatabasePoolCapacitySnapshot {
  limit: number;
  total: number;
  idle: number;
  inUse: number;
  waiting: number;
  saturated: boolean;
}

export interface DatabasePoolCapacityMonitor {
  snapshot(): DatabasePoolCapacitySnapshot;
}

/** Converts node-postgres counters into an identifier-free health snapshot. */
export class PostgresPoolCapacityMonitor implements DatabasePoolCapacityMonitor {
  constructor(
    private readonly pool: DatabasePoolCounters,
    private readonly limit: number,
  ) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError("Database pool limit must be a positive integer");
    }
  }

  snapshot(): DatabasePoolCapacitySnapshot {
    const total = this.safeCounter(this.pool.totalCount);
    const idle = Math.min(total, this.safeCounter(this.pool.idleCount));
    const waiting = this.safeCounter(this.pool.waitingCount);
    const inUse = total - idle;
    return {
      limit: this.limit,
      total,
      idle,
      inUse,
      waiting,
      saturated: waiting > 0 || (total >= this.limit && idle === 0),
    };
  }

  private safeCounter(value: number): number {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
}
