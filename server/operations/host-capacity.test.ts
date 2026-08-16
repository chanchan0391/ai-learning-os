import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const capacityScript = join(repositoryRoot, "deploy/dev/host-capacity.sh");
const temporaryDirectories: string[] = [];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-learning-host-capacity-"));
  temporaryDirectories.push(root);
  const baseDir = join(root, "service");
  const backupDir = join(root, "backups");
  const df = join(root, "df");
  mkdirSync(baseDir);
  mkdirSync(backupDir);
  writeFileSync(df, `#!/bin/sh
set -eu
case "$1" in
  -Pk) printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/fake 10000000 2000000 %s %s%% /\\n' "\${FAKE_FREE_KIB:-8000000}" "\${FAKE_USED_PERCENT:-20}" ;;
  -Pi) printf 'Filesystem Inodes IUsed IFree IUse%% Mounted on\\n/dev/fake 1000000 200000 %s %s%% /\\n' "\${FAKE_FREE_INODES:-800000}" "\${FAKE_INODE_USED_PERCENT:-20}" ;;
  *) exit 2 ;;
esac
`);
  chmodSync(df, 0o755);
  return { backupDir, baseDir, df };
}

function runCapacity(fixture: ReturnType<typeof makeFixture>, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("sh", [capacityScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      AI_LEARNING_DEPLOY_DIR: fixture.baseDir,
      AI_LEARNING_BACKUP_DIR: fixture.backupDir,
      AI_LEARNING_DF_BIN: fixture.df,
      AI_LEARNING_MIN_FREE_BYTES: "5368709120",
      AI_LEARNING_MIN_FREE_INODES: "100000",
      ...extraEnv,
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("dev host capacity monitoring", () => {
  it("checks block and inode headroom for deployment and backup storage", () => {
    const fixture = makeFixture();

    const result = runCapacity(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Deployment capacity healthy: 20% blocks used, 20% inodes used");
    expect(result.stdout).toContain("Backup capacity healthy: 20% blocks used, 20% inodes used");
  });

  it("fails when absolute free space is below the safe boundary", () => {
    const fixture = makeFixture();

    const result = runCapacity(fixture, { FAKE_FREE_KIB: "1000" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Deployment filesystem capacity is below the safe boundary");
    expect(result.stderr).not.toContain(fixture.baseDir);
  });

  it("fails when percentage usage reaches the configured boundary", () => {
    const fixture = makeFixture();

    const result = runCapacity(fixture, { FAKE_USED_PERCENT: "90" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Deployment filesystem capacity is below the safe boundary");
  });

  it("fails before checking backups when free inodes are exhausted", () => {
    const fixture = makeFixture();

    const result = runCapacity(fixture, { FAKE_FREE_INODES: "99999" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Deployment filesystem inode capacity is below the safe boundary");
  });

  it("rejects invalid thresholds before reading capacity", () => {
    const fixture = makeFixture();

    const result = runCapacity(fixture, { AI_LEARNING_MAX_DISK_USED_PERCENT: "101" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Maximum disk usage percentage must be between 1 and 100");
  });

  it("rejects symlinked managed directories", () => {
    const fixture = makeFixture();
    const linkedBase = join(fixture.baseDir, "linked");
    // The shell monitor must reject the link itself even when its target is valid.
    symlinkSync(fixture.baseDir, linkedBase);

    const result = runCapacity({ ...fixture, baseDir: linkedBase });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Deployment directory must be a real directory, not a symlink");
  });

  it("rejects a symlinked df before reading capacity", () => {
    const fixture = makeFixture();
    const marker = join(dirname(fixture.df), "df-called");
    const realDf = join(dirname(fixture.df), "real-df");
    writeFileSync(realDf, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(realDf, 0o755);
    const linkedDf = join(dirname(fixture.df), "linked-df");
    symlinkSync(realDf, linkedDf);

    const result = runCapacity(fixture, { AI_LEARNING_DF_BIN: linkedDf });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("df executable is missing or unsafe");
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects a group-writable df before reading capacity", () => {
    const fixture = makeFixture();
    const marker = join(dirname(fixture.df), "df-called");
    writeFileSync(fixture.df, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(fixture.df, 0o775);

    const result = runCapacity(fixture);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("must not be group or other writable");
    expect(existsSync(marker)).toBe(false);
  });
});
