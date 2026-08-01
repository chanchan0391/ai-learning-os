import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { RateLimitDecision, RateLimitPolicy, RequestRateLimiter } from "./request-security";

export class PostgresFixedWindowRateLimiter implements RequestRateLimiter {
  private consumeCount = 0;

  constructor(
    private readonly pool: Pool,
    private readonly now: () => number = Date.now,
  ) {}

  async consume(scope: string, key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    const now = this.now();
    const windowStartedAt = Math.floor(now / policy.windowMs) * policy.windowMs;
    const resetAt = windowStartedAt + policy.windowMs;
    const keyHash = createHash("sha256").update(key).digest("hex");
    const result = await this.pool.query<{ request_count: number }>(
      `INSERT INTO request_rate_limits (scope, key_hash, window_started_at, expires_at, request_count)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (scope, key_hash, window_started_at)
       DO UPDATE SET request_count = request_rate_limits.request_count + 1,
                     expires_at = EXCLUDED.expires_at
       RETURNING request_count`,
      [scope, keyHash, new Date(windowStartedAt), new Date(resetAt + policy.windowMs)],
    );
    const count = Number(result.rows[0].request_count);

    this.consumeCount += 1;
    if (this.consumeCount % 1_000 === 0) {
      void this.pool.query("DELETE FROM request_rate_limits WHERE expires_at <= $1", [new Date(now)])
        .catch((error) => console.error("Rate limit cleanup failed", error));
    }

    return {
      allowed: count <= policy.limit,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - count),
      resetAt,
    };
  }
}
