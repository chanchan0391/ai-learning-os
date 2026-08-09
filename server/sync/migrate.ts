import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations } from "./migration-runner";

try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required to run database migrations");

const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((name) => /^\d+[-_].+\.sql$/.test(name))
  .sort();
const pool = new pg.Pool({ connectionString, max: 1 });

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
