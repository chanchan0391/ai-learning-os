import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const backupScript = join(repositoryRoot, "deploy/dev/backup.sh");
const temporaryDirectories: string[] = [];

interface Fixture {
  backupDir: string;
  docker: string;
}

function executable(path: string, contents: string): string {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
  return path;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ai-learning-backup-"));
  temporaryDirectories.push(root);
  return {
    backupDir: join(root, "backups"),
    docker: executable(join(root, "docker"), "#!/bin/sh\nset -eu\ncase \"$*\" in\n  'exec pg pg_dump --format=custom --no-owner --no-privileges -U postgres -d ai_learning_os') printf 'valid custom archive' ;;\n  'exec -i pg pg_restore --list') [ \"$(cat)\" = 'valid custom archive' ] ;;\n  *) exit 2 ;;\nesac\n"),
  };
}

function runBackup(fixture: Fixture) {
  return spawnSync("sh", [backupScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      AI_LEARNING_BACKUP_DIR: fixture.backupDir,
      AI_LEARNING_DOCKER_BIN: fixture.docker,
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("dev database backup", () => {
  it("publishes only a verified, private custom archive", () => {
    const fixture = makeFixture();

    const result = runBackup(fixture);

    expect(result.status, result.stderr).toBe(0);
    const files = readdirSync(fixture.backupDir);
    expect(files).toHaveLength(2);
    const backupName = files.find((file) => file.endsWith(".dump"));
    expect(backupName).toMatch(/^ai-learning-os-\d{8}T\d{6}Z-[A-Za-z0-9]+\.dump$/);
    const backup = join(fixture.backupDir, backupName!);
    const checksum = `${backup}.sha256`;
    expect(readFileSync(backup, "utf8")).toBe("valid custom archive");
    expect(readFileSync(checksum, "utf8")).toBe(
      `${createHash("sha256").update("valid custom archive").digest("hex")}  ${backupName}\n`,
    );
    expect(statSync(fixture.backupDir).mode & 0o777).toBe(0o700);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(statSync(checksum).mode & 0o777).toBe(0o600);
  });

  it("removes the temporary artifact when archive verification fails", () => {
    const fixture = makeFixture();
    executable(fixture.docker, "#!/bin/sh\nset -eu\ncase \"$*\" in\n  *pg_dump*) printf 'invalid archive' ;;\n  *) exit 1 ;;\nesac\n");

    const result = runBackup(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed PostgreSQL archive verification");
    expect(existsSync(fixture.backupDir)).toBe(true);
    expect(readdirSync(fixture.backupDir)).toEqual([]);
  });

  it("rejects an empty dump without publishing an artifact", () => {
    const fixture = makeFixture();
    executable(fixture.docker, "#!/bin/sh\nexit 0\n");

    const result = runBackup(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Database backup is empty");
    expect(readdirSync(fixture.backupDir)).toEqual([]);
  });

  it("removes expired archives and their checksum sidecars together", () => {
    const fixture = makeFixture();
    mkdirSync(fixture.backupDir);
    const expiredBackup = join(fixture.backupDir, "ai-learning-os-20260701T000000Z-old.dump");
    const expiredChecksum = `${expiredBackup}.sha256`;
    writeFileSync(expiredBackup, "expired archive");
    writeFileSync(expiredChecksum, "expired checksum");
    const expiredAt = new Date(Date.now() - 9 * 24 * 60 * 60 * 1_000);
    utimesSync(expiredBackup, expiredAt, expiredAt);
    utimesSync(expiredChecksum, expiredAt, expiredAt);

    const result = runBackup(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(expiredBackup)).toBe(false);
    expect(existsSync(expiredChecksum)).toBe(false);
    expect(readdirSync(fixture.backupDir)).toHaveLength(2);
  });
});
