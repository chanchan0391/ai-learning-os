import { createHash } from "node:crypto";

export interface Migration {
  name: string;
  sql: string;
}

export interface MigrationQueryResult {
  rowCount: number | null;
  rows: Array<Record<string, unknown>>;
}

export interface MigrationClient {
  query(sql: string, values?: unknown[]): Promise<MigrationQueryResult>;
}

const MIGRATION_LOCK_NAMESPACE = 1_093_418_579;
const MIGRATION_LOCK_KEY = 1;

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export async function runMigrations(client: MigrationClient, migrations: Migration[]): Promise<string[]> {
  const lock = await client.query(
    "SELECT pg_try_advisory_lock($1, $2) AS locked",
    [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY],
  );
  if (lock.rows[0]?.locked !== true) {
    throw new Error("Another database migration is already running");
  }

  const appliedNames: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text CHECK (checksum IS NULL OR length(checksum) = 64),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(
      "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text CHECK (checksum IS NULL OR length(checksum) = 64)",
    );

    for (const migration of migrations) {
      const checksum = migrationChecksum(migration.sql);
      const applied = await client.query(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [migration.name],
      );
      if (applied.rowCount === 1) {
        const recordedChecksum = applied.rows[0]?.checksum;
        if (recordedChecksum === null || recordedChecksum === undefined) {
          await client.query(
            "UPDATE schema_migrations SET checksum = $2 WHERE name = $1 AND checksum IS NULL",
            [migration.name, checksum],
          );
          continue;
        }
        if (recordedChecksum !== checksum) {
          throw new Error(`Applied migration checksum mismatch: ${migration.name}`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [migration.name, checksum],
        );
        await client.query("COMMIT");
        appliedNames.push(migration.name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return appliedNames;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1, $2)", [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY]);
  }
}
