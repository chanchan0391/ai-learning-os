import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { LearningPlan } from "../../src/types";
import {
  SyncConflictError,
  SyncRequestError,
  requireSyncIdentity,
  requireSyncWriteRequest,
  syncOperationFingerprint,
  type DailyRecordSyncValue,
  type SyncChanges,
  type SyncEntity,
  type SyncEntityType,
  type SyncEntityValue,
  type SyncPrincipal,
  type SyncWriteRequest,
} from "./sync-store";

interface EntityRow extends QueryResultRow {
  entity_type: SyncEntityType;
  entity_id: string;
  revision: number;
  updated_at: Date | string;
  value: SyncEntityValue;
  change_sequence: string | number;
}

interface OperationRow extends QueryResultRow {
  fingerprint: string;
  result: SyncEntity;
}

function entityFromRow<T = SyncEntityValue>(row: EntityRow): SyncEntity<T> {
  return {
    entityType: row.entity_type,
    entityId: row.entity_id,
    revision: Number(row.revision),
    updatedAt: new Date(row.updated_at).toISOString(),
    value: structuredClone(row.value) as T,
  };
}

/**
 * PostgreSQL implementation of the provider-neutral sync contract.
 *
 * A trusted identity layer must provision users and devices before this store is
 * called. Each write locks the user's row, which serializes that user's
 * idempotency and revision checks without blocking unrelated users.
 */
export class PostgresSyncStore {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
    private readonly createCursor: () => string = () => randomUUID(),
  ) {}

  putPlan(principal: SyncPrincipal, request: SyncWriteRequest<LearningPlan>): Promise<SyncEntity<LearningPlan>> {
    return this.write(principal, "learning-plan", request);
  }

  async putDailyRecord(
    principal: SyncPrincipal,
    request: SyncWriteRequest<DailyRecordSyncValue>,
  ): Promise<SyncEntity<DailyRecordSyncValue>> {
    return this.write(principal, "daily-record", request);
  }

  async getChanges(principal: SyncPrincipal, cursor?: string): Promise<SyncChanges> {
    requireSyncIdentity(principal);
    await this.requireActivePrincipal(this.pool, principal);
    let afterSequence = 0;
    if (cursor) {
      const cursorResult = await this.pool.query<{ sequence: string | number }>(
        "SELECT sequence FROM sync_cursors WHERE token = $1 AND user_id = $2",
        [cursor, principal.userId],
      );
      if (cursorResult.rowCount !== 1) {
        throw new SyncRequestError("invalid-cursor", "The sync cursor is invalid for the authenticated user");
      }
      afterSequence = Number(cursorResult.rows[0].sequence);
    }

    const rows = await this.pool.query<EntityRow>(
      `SELECT 'learning-plan'::text AS entity_type, id AS entity_id, revision, updated_at, value, change_sequence
         FROM learning_plans
        WHERE user_id = $1 AND change_sequence > $2
       UNION ALL
       SELECT 'daily-record'::text AS entity_type, id AS entity_id, revision, updated_at, value, change_sequence
         FROM daily_records
        WHERE user_id = $1 AND change_sequence > $2
       ORDER BY change_sequence`,
      [principal.userId, afterSequence],
    );
    const latestSequence = rows.rows.length > 0
      ? Math.max(...rows.rows.map((row) => Number(row.change_sequence)))
      : afterSequence;
    const nextCursor = this.createCursor();
    await this.pool.query(
      "INSERT INTO sync_cursors (token, user_id, sequence) VALUES ($1, $2, $3)",
      [nextCursor, principal.userId, latestSequence],
    );
    return { changes: rows.rows.map((row) => entityFromRow(row)), cursor: nextCursor };
  }

  private async write<T extends SyncEntityValue>(
    principal: SyncPrincipal,
    entityType: SyncEntityType,
    request: SyncWriteRequest<T>,
  ): Promise<SyncEntity<T>> {
    requireSyncIdentity(principal);
    requireSyncWriteRequest(request);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.requireActivePrincipal(client, principal, true);
      const fingerprint = syncOperationFingerprint(entityType, request);
      const previous = await client.query<OperationRow>(
        "SELECT fingerprint, result FROM sync_operations WHERE user_id = $1 AND operation_id = $2",
        [principal.userId, request.operationId],
      );
      if (previous.rowCount === 1) {
        if (previous.rows[0].fingerprint !== fingerprint) {
          throw new SyncRequestError("idempotency-mismatch", "The operation ID was already used for different content");
        }
        await client.query("COMMIT");
        return structuredClone(previous.rows[0].result) as SyncEntity<T>;
      }

      if (entityType === "daily-record") {
        const planId = (request.value as DailyRecordSyncValue).planId;
        const plan = await client.query(
          "SELECT 1 FROM learning_plans WHERE user_id = $1 AND id = $2",
          [principal.userId, planId],
        );
        if (plan.rowCount !== 1) {
          throw new SyncRequestError("missing-plan", "The daily record's plan does not belong to the authenticated user");
        }
      }

      const table = entityType === "learning-plan" ? "learning_plans" : "daily_records";
      const currentResult = await client.query<EntityRow>(
        `SELECT $3::text AS entity_type, id AS entity_id, revision, updated_at, value, change_sequence
           FROM ${table}
          WHERE user_id = $1 AND id = $2
          FOR UPDATE`,
        [principal.userId, request.entityId, entityType],
      );
      const current = currentResult.rowCount === 1 ? entityFromRow<T>(currentResult.rows[0]) : null;
      if (request.baseRevision !== (current?.revision ?? null)) throw new SyncConflictError(current);

      const revision = (current?.revision ?? 0) + 1;
      const updatedAt = this.now().toISOString();
      const planId = entityType === "daily-record" ? (request.value as DailyRecordSyncValue).planId : null;
      const writeResult = entityType === "learning-plan"
        ? await client.query<EntityRow>(
          `INSERT INTO learning_plans (user_id, id, revision, updated_at, value)
                VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (user_id, id) DO UPDATE
                   SET revision = EXCLUDED.revision,
                       updated_at = EXCLUDED.updated_at,
                       change_sequence = nextval('sync_change_sequence'),
                       value = EXCLUDED.value
             RETURNING 'learning-plan'::text AS entity_type, id AS entity_id, revision, updated_at, value, change_sequence`,
          [principal.userId, request.entityId, revision, updatedAt, JSON.stringify(request.value)],
        )
        : await client.query<EntityRow>(
          `INSERT INTO daily_records (user_id, id, plan_id, revision, updated_at, value)
                VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (user_id, id) DO UPDATE
                   SET plan_id = EXCLUDED.plan_id,
                       revision = EXCLUDED.revision,
                       updated_at = EXCLUDED.updated_at,
                       change_sequence = nextval('sync_change_sequence'),
                       value = EXCLUDED.value
             RETURNING 'daily-record'::text AS entity_type, id AS entity_id, revision, updated_at, value, change_sequence`,
          [principal.userId, request.entityId, planId, revision, updatedAt, JSON.stringify(request.value)],
        );
      const result = entityFromRow<T>(writeResult.rows[0]);
      await client.query(
        `INSERT INTO sync_operations (user_id, operation_id, fingerprint, result)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [principal.userId, request.operationId, fingerprint, JSON.stringify(result)],
      );
      await client.query(
        "UPDATE sync_devices SET last_seen_at = $3 WHERE user_id = $1 AND id = $2",
        [principal.userId, principal.deviceId, updatedAt],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async requireActivePrincipal(client: Pool | PoolClient, principal: SyncPrincipal, lockUser = false): Promise<void> {
    const result = await client.query(
      `SELECT u.id
         FROM users u
         JOIN sync_devices d ON d.user_id = u.id AND d.id = $2
        WHERE u.id = $1 AND u.deleted_at IS NULL AND d.revoked_at IS NULL
        ${lockUser ? "FOR UPDATE" : ""}`,
      [principal.userId, principal.deviceId],
    );
    if (result.rowCount !== 1) {
      throw new SyncRequestError("unknown-principal", "The authenticated user or device is not active");
    }
  }
}
