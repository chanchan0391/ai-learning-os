import { describe, expect, it } from "vitest";
import {
  migrationChecksum,
  runMigrations,
  type MigrationClient,
  type MigrationQueryResult,
} from "./migration-runner";

class RecordingClient implements MigrationClient {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];

  constructor(
    private readonly handler: (sql: string, values?: unknown[]) => MigrationQueryResult = () => ({ rowCount: 0, rows: [] }),
  ) {}

  async query(sql: string, values?: unknown[]): Promise<MigrationQueryResult> {
    this.calls.push({ sql, values });
    return this.handler(sql, values);
  }
}

describe("migration runner", () => {
  it("applies new migrations transactionally and records their checksums", async () => {
    const client = new RecordingClient((sql) => {
      if (sql.includes("pg_try_advisory_lock")) return { rowCount: 1, rows: [{ locked: true }] };
      return { rowCount: 0, rows: [] };
    });

    await expect(runMigrations(client, [{ name: "001-start.sql", sql: "SELECT 1;" }]))
      .resolves.toEqual(["001-start.sql"]);

    expect(client.calls.map(({ sql }) => sql)).toEqual(expect.arrayContaining([
      "BEGIN",
      "SELECT 1;",
      "COMMIT",
    ]));
    expect(client.calls.find(({ sql }) => sql.startsWith("INSERT INTO schema_migrations"))?.values)
      .toEqual(["001-start.sql", migrationChecksum("SELECT 1;")]);
    expect(client.calls.at(-1)?.sql).toContain("pg_advisory_unlock");
  });

  it("backfills legacy rows without reapplying their migration", async () => {
    const client = new RecordingClient((sql) => {
      if (sql.includes("pg_try_advisory_lock")) return { rowCount: 1, rows: [{ locked: true }] };
      if (sql.startsWith("SELECT checksum")) return { rowCount: 1, rows: [{ checksum: null }] };
      return { rowCount: 0, rows: [] };
    });

    await expect(runMigrations(client, [{ name: "001-start.sql", sql: "SELECT 1;" }]))
      .resolves.toEqual([]);

    expect(client.calls.find(({ sql }) => sql.startsWith("UPDATE schema_migrations"))?.values)
      .toEqual(["001-start.sql", migrationChecksum("SELECT 1;")]);
    expect(client.calls.some(({ sql }) => sql === "BEGIN")).toBe(false);
  });

  it("rejects an edited applied migration and releases the lock", async () => {
    const client = new RecordingClient((sql) => {
      if (sql.includes("pg_try_advisory_lock")) return { rowCount: 1, rows: [{ locked: true }] };
      if (sql.startsWith("SELECT checksum")) return { rowCount: 1, rows: [{ checksum: "0".repeat(64) }] };
      return { rowCount: 0, rows: [] };
    });

    await expect(runMigrations(client, [{ name: "001-start.sql", sql: "SELECT 1;" }]))
      .rejects.toThrow("Applied migration checksum mismatch: 001-start.sql");
    expect(client.calls.at(-1)?.sql).toContain("pg_advisory_unlock");
  });

  it("fails safely when another migration runner owns the lock", async () => {
    const client = new RecordingClient((sql) => sql.includes("pg_try_advisory_lock")
      ? { rowCount: 1, rows: [{ locked: false }] }
      : { rowCount: 0, rows: [] });

    await expect(runMigrations(client, [])).rejects.toThrow("Another database migration is already running");
    expect(client.calls).toHaveLength(1);
  });

  it("rolls back a failed migration before releasing the lock", async () => {
    const client = new RecordingClient((sql) => {
      if (sql.includes("pg_try_advisory_lock")) return { rowCount: 1, rows: [{ locked: true }] };
      if (sql === "BROKEN") throw new Error("migration failed");
      return { rowCount: 0, rows: [] };
    });

    await expect(runMigrations(client, [{ name: "001-broken.sql", sql: "BROKEN" }]))
      .rejects.toThrow("migration failed");
    expect(client.calls.slice(-2).map(({ sql }) => sql)).toEqual([
      "ROLLBACK",
      expect.stringContaining("pg_advisory_unlock"),
    ]);
  });
});
