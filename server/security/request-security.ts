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
  consume(scope: string, key: string, policy: RateLimitPolicy): RateLimitDecision;
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
