import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool } from "pg";
import { ModelProviderError } from "./model-provider";
import type { ModelProvider, StructuredGenerationRequest, StructuredGenerationResult } from "./model-provider";

export interface ModelBudgetDecision {
  allowed: boolean;
  exceeded: "account" | "global" | null;
  resetAt: number;
  remainingTokens: number;
  remainingCostMicros: number;
  remainingGlobalCostMicros?: number;
}

export interface ModelUsageLedger {
  checkBudget(userId: string, planKey?: string | null): Promise<ModelBudgetDecision>;
  record(entry: {
    userId: string;
    action: string;
    provider: string;
    model: string;
    requestId?: string;
    inputTokens: number;
    outputTokens: number;
  }): Promise<void>;
}

export interface ModelUsagePolicy {
  monthlyTokenLimit: number;
  monthlyCostLimitMicros: number;
  planBudgets?: Record<string, AccountModelBudget>;
  globalMonthlyCostLimitMicros?: number;
  inputCostMicrosPerMillionTokens: number;
  outputCostMicrosPerMillionTokens: number;
}

export interface AccountModelBudget {
  monthlyTokenLimit: number;
  monthlyCostLimitMicros: number;
}

interface UsageContext {
  userId: string;
  action: string;
}

function utcMonthRange(now: number): { start: Date; end: Date } {
  const date = new Date(now);
  return {
    start: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)),
    end: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)),
  };
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
}

export class PostgresModelUsageLedger implements ModelUsageLedger {
  constructor(
    private readonly pool: Pool,
    private readonly policy: ModelUsagePolicy,
    private readonly now: () => number = Date.now,
  ) {
    assertPositiveSafeInteger(policy.monthlyTokenLimit, "monthlyTokenLimit");
    assertPositiveSafeInteger(policy.monthlyCostLimitMicros, "monthlyCostLimitMicros");
    for (const [planKey, budget] of Object.entries(policy.planBudgets ?? {})) {
      if (!planKey.trim()) throw new Error("plan budget keys must not be empty");
      assertPositiveSafeInteger(budget.monthlyTokenLimit, `${planKey}.monthlyTokenLimit`);
      assertPositiveSafeInteger(budget.monthlyCostLimitMicros, `${planKey}.monthlyCostLimitMicros`);
    }
    if (policy.globalMonthlyCostLimitMicros !== undefined) {
      assertPositiveSafeInteger(policy.globalMonthlyCostLimitMicros, "globalMonthlyCostLimitMicros");
    }
    assertPositiveSafeInteger(policy.inputCostMicrosPerMillionTokens, "inputCostMicrosPerMillionTokens");
    assertPositiveSafeInteger(policy.outputCostMicrosPerMillionTokens, "outputCostMicrosPerMillionTokens");
  }

  async checkBudget(userId: string, planKey?: string | null): Promise<ModelBudgetDecision> {
    const { start, end } = utcMonthRange(this.now());
    const configuredPlanBudgets = this.policy.planBudgets;
    const accountBudget = planKey && configuredPlanBudgets
      ? configuredPlanBudgets[planKey]
      : { monthlyTokenLimit: this.policy.monthlyTokenLimit, monthlyCostLimitMicros: this.policy.monthlyCostLimitMicros };
    const result = await this.pool.query<{ total_tokens: string; total_cost_micros: string }>(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::text AS total_tokens,
              COALESCE(SUM(cost_micros), 0)::text AS total_cost_micros
         FROM model_usage_events
        WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at < $3`,
      [userId, start, end],
    );
    const totalTokens = Number(result.rows[0].total_tokens);
    const totalCostMicros = Number(result.rows[0].total_cost_micros);
    const remainingTokens = Math.max(0, (accountBudget?.monthlyTokenLimit ?? 0) - totalTokens);
    const remainingCostMicros = Math.max(0, (accountBudget?.monthlyCostLimitMicros ?? 0) - totalCostMicros);
    let remainingGlobalCostMicros: number | undefined;
    if (this.policy.globalMonthlyCostLimitMicros !== undefined) {
      const globalResult = await this.pool.query<{ total_cost_micros: string }>(
        `SELECT COALESCE(SUM(cost_micros), 0)::text AS total_cost_micros
           FROM model_usage_events
          WHERE occurred_at >= $1 AND occurred_at < $2`,
        [start, end],
      );
      remainingGlobalCostMicros = Math.max(
        0,
        this.policy.globalMonthlyCostLimitMicros - Number(globalResult.rows[0].total_cost_micros),
      );
    }
    const accountAllowed = remainingTokens > 0 && remainingCostMicros > 0;
    const globalAllowed = remainingGlobalCostMicros === undefined || remainingGlobalCostMicros > 0;
    return {
      allowed: accountAllowed && globalAllowed,
      exceeded: !accountAllowed ? "account" : !globalAllowed ? "global" : null,
      resetAt: end.getTime(),
      remainingTokens,
      remainingCostMicros,
      ...(remainingGlobalCostMicros === undefined ? {} : { remainingGlobalCostMicros }),
    };
  }

  async record(entry: Parameters<ModelUsageLedger["record"]>[0]): Promise<void> {
    const costMicros = Math.ceil((
      entry.inputTokens * this.policy.inputCostMicrosPerMillionTokens
      + entry.outputTokens * this.policy.outputCostMicrosPerMillionTokens
    ) / 1_000_000);
    await this.pool.query(
      `INSERT INTO model_usage_events
        (user_id, action, provider, model, provider_request_id, input_tokens, output_tokens, cost_micros, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT DO NOTHING`,
      [entry.userId, entry.action, entry.provider, entry.model, entry.requestId ?? null,
        entry.inputTokens, entry.outputTokens, costMicros, new Date(this.now())],
    );
  }
}

export class MeteredModelProvider implements ModelProvider {
  readonly id: string;
  readonly isAiEnabled: boolean;
  private readonly context = new AsyncLocalStorage<UsageContext>();

  constructor(private readonly provider: ModelProvider, private readonly ledger: ModelUsageLedger) {
    this.id = provider.id;
    this.isAiEnabled = provider.isAiEnabled;
  }

  run<T>(context: UsageContext, callback: () => Promise<T>): Promise<T> {
    return this.context.run(context, callback);
  }

  async generateStructured<T>(request: StructuredGenerationRequest): Promise<StructuredGenerationResult<T>> {
    const result = await this.provider.generateStructured<T>(request);
    const context = this.context.getStore();
    if (context && this.provider.isAiEnabled && !result.usage) {
      throw new ModelProviderError("Model provider did not report billable usage", 502, result.requestId);
    }
    if (context && result.usage) {
      await this.ledger.record({
        ...context,
        provider: this.provider.id,
        model: result.model,
        requestId: result.requestId,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
    }
    return result;
  }
}
