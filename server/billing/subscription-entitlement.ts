import type { Pool } from "pg";

export type SubscriptionAccessState = "active" | "grace" | "inactive";

export interface SubscriptionEntitlementDecision {
  allowed: boolean;
  state: SubscriptionAccessState;
  planKey: string | null;
  accessUntil: number | null;
}

export interface SubscriptionEntitlementResolver {
  checkEntitlement(userId: string): Promise<SubscriptionEntitlementDecision>;
}

interface EntitlementRow {
  plan_key: string;
  status: SubscriptionAccessState;
  access_until: Date | string | null;
}

export class PostgresSubscriptionEntitlementResolver implements SubscriptionEntitlementResolver {
  constructor(private readonly pool: Pool, private readonly now: () => number = Date.now) {}

  async checkEntitlement(userId: string): Promise<SubscriptionEntitlementDecision> {
    const result = await this.pool.query<EntitlementRow>(
      `SELECT plan_key, status, access_until
         FROM subscription_entitlements
        WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return { allowed: false, state: "inactive", planKey: null, accessUntil: null };

    const accessUntil = row.access_until === null ? null : new Date(row.access_until).getTime();
    const hasAccess = row.status !== "inactive" && (accessUntil === null || accessUntil > this.now());
    return {
      allowed: hasAccess,
      state: hasAccess ? row.status : "inactive",
      planKey: row.plan_key,
      accessUntil,
    };
  }
}
