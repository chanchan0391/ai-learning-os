import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const backupScript = join(repositoryRoot, "deploy/dev/backup.sh");
const deployScript = join(repositoryRoot, "deploy/dev/deploy-main.sh");
const publishScript = join(repositoryRoot, "deploy/dev/publish-main.sh");
const temporaryDirectories: string[] = [];

interface Fixture {
  backupDir: string;
  docker: string;
}

function addHealthyDeploymentCommands(fakeBin: string, revision: string) {
  executable(join(fakeBin, "systemctl"), "#!/bin/sh\nset -eu\ncase \"$*\" in\n  *\" show \"*) printf '%s\\n' \"$FAKE_MAIN_PID\" ;;\n  *\" is-active \"*) exit 0 ;;\n  *) exit 0 ;;\nesac\n");
  executable(join(fakeBin, "curl"), `#!/bin/sh\nset -eu\ncase "$*" in\n  *8787/api/health*) printf '%s\\n' '{"status":"ok","releaseRevision":"${revision}","aiEnabled":true,"syncEnabled":true}' ;;\n  *) exit 0 ;;\nesac\n`);
  executable(join(fakeBin, "readlink"), "#!/bin/sh\nprintf '%s\\n' \"$FAKE_NODE_BIN\"\n");
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

describe("dev operational runner updates", () => {
  it("refreshes both deployment and backup runners for an already deployed revision", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-runners-"));
    temporaryDirectories.push(root);
    const baseDir = join(root, "service");
    const current = join(baseDir, "current");
    const releaseOperations = join(current, "deploy/dev");
    const fakeBin = join(root, "bin");
    const revision = "a".repeat(40);
    mkdirSync(releaseOperations, { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(join(current, "DEPLOYED_COMMIT"), `${revision}\n`);
    writeFileSync(join(releaseOperations, "deploy-main.sh"), "new deploy runner\n");
    writeFileSync(join(releaseOperations, "backup.sh"), "new backup runner\n");
    writeFileSync(join(baseDir, "deploy-main.sh"), "old deploy runner\n");
    writeFileSync(join(baseDir, "backup.sh"), "old backup runner\n");
    executable(join(fakeBin, "flock"), "#!/bin/sh\nexit 0\n");
    addHealthyDeploymentCommands(fakeBin, revision);

    const result = spawnSync("sh", [deployScript, revision], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        AI_LEARNING_DEPLOY_DIR: baseDir,
        AI_LEARNING_NODE_BIN: process.execPath,
        FAKE_MAIN_PID: String(process.pid),
        FAKE_NODE_BIN: process.execPath,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Revision ${revision} is already deployed`);
    expect(readFileSync(join(baseDir, "deploy-main.sh"), "utf8")).toBe("new deploy runner\n");
    expect(readFileSync(join(baseDir, "backup.sh"), "utf8")).toBe("new backup runner\n");
    expect(statSync(join(baseDir, "deploy-main.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(baseDir, "backup.sh")).mode & 0o777).toBe(0o755);
  });

  it("does not rewrite operational runners that already match the active release", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-runners-current-"));
    temporaryDirectories.push(root);
    const baseDir = join(root, "service");
    const current = join(baseDir, "current");
    const releaseOperations = join(current, "deploy/dev");
    const fakeBin = join(root, "bin");
    const revision = "c".repeat(40);
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");
    mkdirSync(releaseOperations, { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(join(current, "DEPLOYED_COMMIT"), `${revision}\n`);
    for (const runner of ["deploy-main.sh", "backup.sh"]) {
      writeFileSync(join(releaseOperations, runner), `${runner} current\n`);
      executable(join(baseDir, runner), `${runner} current\n`);
      utimesSync(join(baseDir, runner), fixedTime, fixedTime);
    }
    executable(join(fakeBin, "flock"), "#!/bin/sh\nexit 0\n");
    addHealthyDeploymentCommands(fakeBin, revision);

    const result = spawnSync("sh", [deployScript, revision], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        AI_LEARNING_DEPLOY_DIR: baseDir,
        AI_LEARNING_NODE_BIN: process.execPath,
        FAKE_MAIN_PID: String(process.pid),
        FAKE_NODE_BIN: process.execPath,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    for (const runner of ["deploy-main.sh", "backup.sh"]) {
      expect(statSync(join(baseDir, runner)).mtimeMs).toBe(fixedTime.getTime());
    }
  });

  it("restarts and verifies unhealthy services for an already deployed revision", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-runners-reconcile-"));
    temporaryDirectories.push(root);
    const baseDir = join(root, "service");
    const current = join(baseDir, "current");
    const releaseOperations = join(current, "deploy/dev");
    const fakeBin = join(root, "bin");
    const systemctlLog = join(root, "systemctl.log");
    const healthState = join(root, "healthy");
    const revision = "d".repeat(40);
    mkdirSync(releaseOperations, { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(join(current, "DEPLOYED_COMMIT"), `${revision}\n`);
    for (const runner of ["deploy-main.sh", "backup.sh"]) {
      writeFileSync(join(releaseOperations, runner), `${runner} current\n`);
      executable(join(baseDir, runner), `${runner} current\n`);
    }
    executable(join(fakeBin, "flock"), "#!/bin/sh\nexit 0\n");
    executable(join(fakeBin, "systemctl"), `#!/bin/sh\nset -eu\nprintf '%s\\n' "$*" >> "$FAKE_SYSTEMCTL_LOG"\ncase "$*" in\n  *" restart "*) touch "$FAKE_HEALTH_STATE" ;;\n  *" show "*) printf '%s\\n' "$FAKE_MAIN_PID" ;;\n  *" is-active "*) [ -f "$FAKE_HEALTH_STATE" ] ;;\n  *) exit 0 ;;\nesac\n`);
    executable(join(fakeBin, "curl"), `#!/bin/sh\nset -eu\n[ -f "$FAKE_HEALTH_STATE" ]\ncase "$*" in\n  *8787/api/health*) printf '%s\\n' '{"status":"ok","releaseRevision":"${revision}","aiEnabled":true,"syncEnabled":true}' ;;\n  *) exit 0 ;;\nesac\n`);
    executable(join(fakeBin, "readlink"), "#!/bin/sh\nprintf '%s\\n' \"$FAKE_NODE_BIN\"\n");

    const result = spawnSync("sh", [deployScript, revision], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        AI_LEARNING_DEPLOY_DIR: baseDir,
        AI_LEARNING_NODE_BIN: process.execPath,
        FAKE_MAIN_PID: String(process.pid),
        FAKE_NODE_BIN: process.execPath,
        FAKE_SYSTEMCTL_LOG: systemctlLog,
        FAKE_HEALTH_STATE: healthState,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Reconciled revision ${revision} successfully`);
    expect(readFileSync(systemctlLog, "utf8")).toContain(
      "--user restart ai-learning-os-api.service ai-learning-os-web.service",
    );
  });

  it("reconciles remote runners when the application revision is already current", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-publisher-"));
    temporaryDirectories.push(root);
    const checkout = join(root, "checkout");
    const fakeBin = join(root, "bin");
    const sshLog = join(root, "ssh.log");
    const revision = "b".repeat(40);
    mkdirSync(join(checkout, ".git"), { recursive: true });
    mkdirSync(fakeBin);
    executable(join(fakeBin, "git"), `#!/bin/sh\nset -eu\ncase "$1" in\n  fetch) exit 0 ;;\n  rev-parse) printf '%s\\n' '${revision}' ;;\n  *) exit 2 ;;\nesac\n`);
    executable(join(fakeBin, "ssh"), `#!/bin/sh\nset -eu\ncase "$*" in\n  *DEPLOYED_COMMIT*) printf '%s\\n' '${revision}' ;;\n  *) printf '%s\\n' "$*" >> "$FAKE_SSH_LOG" ;;\nesac\n`);

    const result = spawnSync("sh", [publishScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        TMPDIR: root,
        AI_LEARNING_CHECKOUT_DIR: checkout,
        AI_LEARNING_DEPLOY_HOST: "dev-host",
        AI_LEARNING_REMOTE_BASE: "/srv/ai-learning-os",
        FAKE_SSH_LOG: sshLog,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(sshLog, "utf8")).toBe(
      `dev-host '/srv/ai-learning-os/deploy-main.sh' '${revision}'\n`,
    );
  });
});
