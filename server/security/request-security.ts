import type { IncomingMessage } from "node:http";
import type { SyncPrincipal } from "../sync/sync-store";

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

export interface RequestRateLimiter {
  consume(scope: string, key: string, policy: RateLimitPolicy): RateLimitDecision | Promise<RateLimitDecision>;
}

interface RateLimitWindow {
  count: number;
  resetAt: number;
}

export class InMemoryFixedWindowRateLimiter implements RequestRateLimiter {
  private readonly windows = new Map<string, RateLimitWindow>();

  constructor(private readonly now: () => number = Date.now) {}

  consume(scope: string, key: string, policy: RateLimitPolicy): RateLimitDecision {
    const now = this.now();
    const windowKey = `${scope}:${key}`;
    let window = this.windows.get(windowKey);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + policy.windowMs };
      this.windows.set(windowKey, window);
    }
    window.count += 1;

    if (this.windows.size > 10_000) {
      for (const [candidateKey, candidate] of this.windows) {
        if (candidate.resetAt <= now) this.windows.delete(candidateKey);
      }
    }

    return {
      allowed: window.count <= policy.limit,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - window.count),
      resetAt: window.resetAt,
    };
  }
}

export interface CapacityScopeSnapshot {
  requests: number;
  rejected: number;
  failed: number;
  rateLimited: number;
}

export interface RequestCapacitySnapshot extends CapacityScopeSnapshot {
  windowStartedAt: string;
  windowMs: number;
  inFlight: number;
  averageLatencyMs: number;
  maxLatencyMs: number;
  byScope: Record<string, CapacityScopeSnapshot>;
}

export interface RequestCapacityMonitor {
  start(scope: string): (status: number, rateLimited?: boolean) => void;
  snapshot(): RequestCapacitySnapshot;
}

interface MutableCapacityScope extends CapacityScopeSnapshot {
  totalLatencyMs: number;
  maxLatencyMs: number;
}

function emptyCapacityScope(): MutableCapacityScope {
  return { requests: 0, rejected: 0, failed: 0, rateLimited: 0, totalLatencyMs: 0, maxLatencyMs: 0 };
}

export class RollingRequestCapacityMonitor implements RequestCapacityMonitor {
  private windowStartedAt: number;
  private inFlight = 0;
  private totals = emptyCapacityScope();
  private readonly scopes = new Map<string, MutableCapacityScope>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = 60_000,
  ) {
    this.windowStartedAt = this.bucketStart(this.now());
  }

  start(scope: string): (status: number, rateLimited?: boolean) => void {
    const startedAt = this.now();
    this.rotateIfNeeded(startedAt);
    this.inFlight += 1;
    let completed = false;
    return (status, rateLimited = false) => {
      if (completed) return;
      completed = true;
      const finishedAt = this.now();
      this.rotateIfNeeded(finishedAt);
      this.inFlight = Math.max(0, this.inFlight - 1);
      const latencyMs = Math.max(0, finishedAt - startedAt);
      this.record(this.totals, status, rateLimited, latencyMs);
      const scopeTotals = this.scopes.get(scope) ?? emptyCapacityScope();
      this.record(scopeTotals, status, rateLimited, latencyMs);
      this.scopes.set(scope, scopeTotals);
    };
  }

  snapshot(): RequestCapacitySnapshot {
    this.rotateIfNeeded(this.now());
    const byScope = Object.fromEntries([...this.scopes].map(([scope, totals]) => [scope, this.publicScope(totals)]));
    return {
      ...this.publicScope(this.totals),
      windowStartedAt: new Date(this.windowStartedAt).toISOString(),
      windowMs: this.windowMs,
      inFlight: this.inFlight,
      averageLatencyMs: this.totals.requests === 0 ? 0 : Math.round(this.totals.totalLatencyMs / this.totals.requests),
      maxLatencyMs: this.totals.maxLatencyMs,
      byScope,
    };
  }

  private bucketStart(now: number): number {
    return Math.floor(now / this.windowMs) * this.windowMs;
  }

  private rotateIfNeeded(now: number): void {
    const bucket = this.bucketStart(now);
    if (bucket === this.windowStartedAt) return;
    this.windowStartedAt = bucket;
    this.totals = emptyCapacityScope();
    this.scopes.clear();
  }

  private record(target: MutableCapacityScope, status: number, rateLimited: boolean, latencyMs: number): void {
    target.requests += 1;
    if (status >= 400 && status < 500) target.rejected += 1;
    if (status >= 500) target.failed += 1;
    if (rateLimited) target.rateLimited += 1;
    target.totalLatencyMs += latencyMs;
    target.maxLatencyMs = Math.max(target.maxLatencyMs, latencyMs);
  }

  private publicScope(scope: MutableCapacityScope): CapacityScopeSnapshot {
    return {
      requests: scope.requests,
      rejected: scope.rejected,
      failed: scope.failed,
      rateLimited: scope.rateLimited,
    };
  }
}

export type SecurityAuditOutcome = "success" | "rejected" | "failed";

export interface SecurityAuditEvent {
  occurredAt: string;
  action: string;
  method: string;
  path: string;
  status: number;
  outcome: SecurityAuditOutcome;
  reason?: string;
  userId?: string;
  deviceId?: string;
}

export interface SecurityAuditSink {
  record(event: SecurityAuditEvent): void | Promise<void>;
}

export class JsonLineSecurityAuditSink implements SecurityAuditSink {
  record(event: SecurityAuditEvent): void {
    console.info(JSON.stringify({ type: "security_audit", ...event }));
  }
}

export function clientRateLimitKey(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

export function auditOutcome(status: number): SecurityAuditOutcome {
  if (status < 400) return "success";
  if (status < 500) return "rejected";
  return "failed";
}

export function principalFields(principal: SyncPrincipal | null | undefined): Pick<SecurityAuditEvent, "userId" | "deviceId"> {
  return principal ? { userId: principal.userId, deviceId: principal.deviceId } : {};
}
