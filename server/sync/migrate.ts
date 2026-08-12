import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { readDatabaseConnectionConfig, readDatabasePoolConfig, toDatabasePoolConfig } from "../runtime-config";
import { runMigrations } from "./migration-runner";

try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const database = readDatabaseConnectionConfig(process.env);
const poolConfig = toDatabasePoolConfig(
  database.connectionString,
  { ...readDatabasePoolConfig(process.env), max: 1 },
  database.databaseTls,
);

const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((name) => /^\d+[-_].+\.sql$/.test(name))
  .sort();
const pool = new pg.Pool(poolConfig);

try {
  const migrations = await Promise.all(migrationFiles.map(async (name) => ({
    name,
    sql: await readFile(resolve(migrationsDirectory, name), "utf8"),
  })));
  const client = await pool.connect();
  try {
    const applied = await runMigrations(client, migrations);
    for (const name of applied) console.log(`Applied ${name}`);
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
