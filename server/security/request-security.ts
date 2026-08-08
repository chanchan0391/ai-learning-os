import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
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

export interface ConcurrencySnapshot {
  limit: number;
  inFlight: number;
  rejected: number;
}

export interface RequestConcurrencyLimiter {
  tryAcquire(): (() => void) | null;
  snapshot(): ConcurrencySnapshot;
}

/** Bounds expensive in-flight work within one API instance. */
export class InMemoryConcurrencyLimiter implements RequestConcurrencyLimiter {
  private inFlight = 0;
  private rejected = 0;

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Concurrency limit must be a positive integer");
  }

  tryAcquire(): (() => void) | null {
    if (this.inFlight >= this.limit) {
      this.rejected += 1;
      return null;
    }
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
    };
  }

  snapshot(): ConcurrencySnapshot {
    return { limit: this.limit, inFlight: this.inFlight, rejected: this.rejected };
  }
}

interface RateLimitWindow {
  count: number;
  resetAt: number;
}

export class InMemoryFixedWindowRateLimiter implements RequestRateLimiter {
  private readonly windows = new Map<string, RateLimitWindow>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 10_000,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("Rate limit entry cap must be a positive integer");
    }
  }

  consume(scope: string, key: string, policy: RateLimitPolicy): RateLimitDecision {
    const now = this.now();
    const windowKey = `${scope}:${key}`;
    let window = this.windows.get(windowKey);
    if (window?.resetAt !== undefined && window.resetAt <= now) {
      window = { count: 0, resetAt: now + policy.windowMs };
      this.windows.set(windowKey, window);
    }
    if (!window) {
      if (this.windows.size >= this.maxEntries) this.pruneExpired(now);
      if (this.windows.size >= this.maxEntries) {
        return {
          allowed: false,
          limit: policy.limit,
          remaining: 0,
          resetAt: this.earliestResetAt(now + policy.windowMs),
        };
      }
      window = { count: 0, resetAt: now + policy.windowMs };
      this.windows.set(windowKey, window);
    }
    window.count += 1;

    return {
      allowed: window.count <= policy.limit,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - window.count),
      resetAt: window.resetAt,
    };
  }

  private pruneExpired(now: number): void {
    for (const [candidateKey, candidate] of this.windows) {
      if (candidate.resetAt <= now) this.windows.delete(candidateKey);
    }
  }

  private earliestResetAt(fallback: number): number {
    let earliest = fallback;
    for (const candidate of this.windows.values()) earliest = Math.min(earliest, candidate.resetAt);
    return earliest;
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

function auditPrincipalReference(kind: "user" | "device", value: string): string {
  return createHash("sha256").update(`${kind}:${value}`, "utf8").digest("hex").slice(0, 32);
}

export class JsonLineSecurityAuditSink implements SecurityAuditSink {
  record(event: SecurityAuditEvent): void {
    const { userId, deviceId, ...safeEvent } = event;
    console.info(JSON.stringify({
      type: "security_audit",
      ...safeEvent,
      ...(userId ? { userRef: auditPrincipalReference("user", userId) } : {}),
      ...(deviceId ? { deviceRef: auditPrincipalReference("device", deviceId) } : {}),
    }));
  }
}

function normalizeIpAddress(value: string): string | null {
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("::ffff:") && isIP(trimmed.slice(7)) === 4 ? trimmed.slice(7) : trimmed;
  return isIP(normalized) ? normalized : null;
}

/** Uses the closest forwarded address only when the direct peer is explicitly trusted. */
export function clientRateLimitKey(request: IncomingMessage, trustedProxyAddresses: readonly string[] = []): string {
  const peer = request.socket.remoteAddress ? normalizeIpAddress(request.socket.remoteAddress) : null;
  if (!peer || !trustedProxyAddresses.includes(peer)) return peer ?? "unknown";

  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor !== "string") return peer;
  const closestForwardedAddress = forwardedFor.split(",").at(-1);
  return closestForwardedAddress ? normalizeIpAddress(closestForwardedAddress) ?? peer : peer;
}

export function auditOutcome(status: number): SecurityAuditOutcome {
  if (status < 400) return "success";
  if (status < 500) return "rejected";
  return "failed";
}

export function principalFields(principal: SyncPrincipal | null | undefined): Pick<SecurityAuditEvent, "userId" | "deviceId"> {
  return principal ? { userId: principal.userId, deviceId: principal.deviceId } : {};
}
