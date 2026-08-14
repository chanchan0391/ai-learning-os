import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const backupScript = join(repositoryRoot, "deploy/dev/backup.sh");
const deployScript = join(repositoryRoot, "deploy/dev/deploy-main.sh");
const publishScript = join(repositoryRoot, "deploy/dev/publish-main.sh");
const temporaryDirectories: string[] = [];

interface Fixture {
  backupDir: string;
  docker: string;
  flock: string;
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
    flock: executable(join(root, "flock"), "#!/bin/sh\n[ \"${FAKE_FLOCK_AVAILABLE:-true}\" = true ]\n"),
  };
}

function runBackup(fixture: Fixture, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("sh", [backupScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      AI_LEARNING_BACKUP_DIR: fixture.backupDir,
      AI_LEARNING_DOCKER_BIN: fixture.docker,
      AI_LEARNING_FLOCK_BIN: fixture.flock,
      ...extraEnv,
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
    expect(files).toHaveLength(3);
    expect(files).toContain(".backup.lock");
    const backupName = files.find((file) => file.endsWith(".dump"));
    expect(backupName).toMatch(/^ai-learning-os-\d{8}T\d{6}Z-[A-Za-z0-9]+\.dump$/);
    const backup = join(fixture.backupDir, backupName!);
    const checksum = `${backup}.sha256`;
    expect(readFileSync(backup, "utf8")).toBe("valid custom archive");
    expect(readFileSync(checksum, "utf8")).toBe(
      `${createHash("sha256").update("valid custom archive").digest("hex")}  ${backupName}\n`,
    );
    expect(statSync(fixture.backupDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(fixture.backupDir, ".backup.lock")).mode & 0o777).toBe(0o600);
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
    expect(readdirSync(fixture.backupDir)).toEqual([".backup.lock"]);
  });

  it("rejects an empty dump without publishing an artifact", () => {
    const fixture = makeFixture();
    executable(fixture.docker, "#!/bin/sh\nexit 0\n");

    const result = runBackup(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Database backup is empty");
    expect(readdirSync(fixture.backupDir)).toEqual([".backup.lock"]);
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
    expect(readdirSync(fixture.backupDir)).toHaveLength(3);
  });

  it("does not let a stale lock artifact block a later backup", () => {
    const fixture = makeFixture();
    mkdirSync(fixture.backupDir);
    writeFileSync(join(fixture.backupDir, ".backup.lock"), "stale owner\n");

    const result = runBackup(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(fixture.backupDir).filter((file) => file.endsWith(".dump"))).toHaveLength(1);
  });

  it("refuses a concurrent backup before starting PostgreSQL work", () => {
    const fixture = makeFixture();
    const dockerMarker = join(dirname(fixture.docker), "docker-called");
    executable(fixture.docker, "#!/bin/sh\ntouch \"$FAKE_DOCKER_MARKER\"\nexit 2\n");

    const result = runBackup(fixture, {
      FAKE_DOCKER_MARKER: dockerMarker,
      FAKE_FLOCK_AVAILABLE: "false",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Another database backup is already running");
    expect(existsSync(dockerMarker)).toBe(false);
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
  }, 15_000);

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

  it("removes failed uploads and stale deployment artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-incoming-"));
    temporaryDirectories.push(root);
    const baseDir = join(root, "service");
    const incoming = join(baseDir, "incoming");
    const releases = join(baseDir, "releases");
    const fakeBin = join(root, "bin");
    const revision = "e".repeat(40);
    mkdirSync(incoming, { recursive: true });
    mkdirSync(releases, { recursive: true });
    mkdirSync(fakeBin);
    const requestedArchive = join(incoming, `${revision}.tar.gz`);
    const staleUpload = join(incoming, `${"f".repeat(40)}.tar.gz.uploading`);
    const recentUpload = join(incoming, `${"a".repeat(40)}.tar.gz.uploading`);
    const staleWorkspace = join(releases, `.deploy-${"b".repeat(40)}.abandoned`);
    const recentWorkspace = join(releases, `.deploy-${"c".repeat(40)}.active`);
    writeFileSync(requestedArchive, "corrupt archive");
    writeFileSync(staleUpload, "abandoned partial archive");
    writeFileSync(recentUpload, "active partial archive");
    mkdirSync(staleWorkspace);
    mkdirSync(recentWorkspace);
    const staleAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
    utimesSync(staleUpload, staleAt, staleAt);
    utimesSync(staleWorkspace, staleAt, staleAt);
    executable(join(fakeBin, "flock"), "#!/bin/sh\nexit 0\n");

    const result = spawnSync("sh", [deployScript, revision, requestedArchive, "0".repeat(64)], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        AI_LEARNING_DEPLOY_DIR: baseDir,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Uploaded archive checksum does not match");
    expect(existsSync(requestedArchive)).toBe(false);
    expect(existsSync(staleUpload)).toBe(false);
    expect(existsSync(recentUpload)).toBe(true);
    expect(existsSync(staleWorkspace)).toBe(false);
    expect(existsSync(recentWorkspace)).toBe(true);
  });

  it("reconciles remote runners when the application revision is already current", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-publisher-"));
    temporaryDirectories.push(root);
    const checkout = join(root, "checkout");
    const fakeBin = join(root, "bin");
    const sshLog = join(root, "ssh.log");
    const revision = "b".repeat(40);
    mkdirSync(join(checkout, ".git"), { recursive: true, mode: 0o700 });
    mkdirSync(fakeBin);
    executable(join(fakeBin, "shlock"), "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$4\" > \"$2\"\n");
    executable(join(fakeBin, "git"), `#!/bin/sh\nset -eu\ncase "$1" in\n  remote) printf '%s\\n' 'https://github.com/chanchan0391/ai-learning-os.git' ;;\n  fetch) exit 0 ;;\n  rev-parse) printf '%s\\n' '${revision}' ;;\n  *) exit 2 ;;\nesac\n`);
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
        AI_LEARNING_PUBLISH_LOG: join(root, "publisher.log"),
        FAKE_SSH_LOG: sshLog,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(sshLog, "utf8")).toBe(
      `-o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 dev-host '/srv/ai-learning-os/deploy-main.sh' '${revision}'\n`,
    );
    expect(existsSync(join(root, "ai-learning-os-publish-main.lock"))).toBe(false);
  });

  it("stops before repository access when another publisher owns the lock", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-publisher-locked-"));
    temporaryDirectories.push(root);
    const fakeBin = join(root, "bin");
    const gitMarker = join(root, "git-called");
    mkdirSync(fakeBin);
    executable(join(fakeBin, "shlock"), "#!/bin/sh\nexit 1\n");
    executable(join(fakeBin, "git"), "#!/bin/sh\ntouch \"$FAKE_GIT_MARKER\"\nexit 2\n");

    const result = spawnSync("sh", [publishScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        TMPDIR: root,
        AI_LEARNING_SHLOCK_BIN: join(fakeBin, "shlock"),
        AI_LEARNING_PUBLISH_LOG: join(root, "publisher.log"),
        FAKE_GIT_MARKER: gitMarker,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Another publisher is already running");
    expect(existsSync(gitMarker)).toBe(false);
  });

  it("rotates a bounded number of publisher logs after acquiring the lock", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-publisher-logs-"));
    temporaryDirectories.push(root);
    const checkout = join(root, "checkout");
    const fakeBin = join(root, "bin");
    const log = join(root, "publisher.log");
    const revision = "e".repeat(40);
    mkdirSync(join(checkout, ".git"), { recursive: true, mode: 0o700 });
    mkdirSync(fakeBin);
    writeFileSync(log, "current log exceeds limit\n");
    writeFileSync(`${log}.1`, "previous one\n");
    writeFileSync(`${log}.3`, "previous three\n");
    writeFileSync(`${log}.4`, "expired oldest\n");
    executable(join(fakeBin, "shlock"), "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$4\" > \"$2\"\n");
    executable(join(fakeBin, "git"), `#!/bin/sh\nset -eu\ncase "$1" in\n  remote) printf '%s\\n' 'https://github.com/chanchan0391/ai-learning-os.git' ;;\n  fetch) exit 0 ;;\n  rev-parse) printf '%s\\n' '${revision}' ;;\n  *) exit 2 ;;\nesac\n`);
    executable(join(fakeBin, "ssh"), `#!/bin/sh\ncase "$*" in\n  *DEPLOYED_COMMIT*) printf '%s\\n' '${revision}' ;;\n  *) exit 0 ;;\nesac\n`);

    const result = spawnSync("sh", [publishScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        TMPDIR: root,
        AI_LEARNING_CHECKOUT_DIR: checkout,
        AI_LEARNING_PUBLISH_LOG: log,
        AI_LEARNING_PUBLISH_LOG_MAX_BYTES: "10",
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(log)).toBe(false);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("current log exceeds limit\n");
    expect(readFileSync(`${log}.2`, "utf8")).toBe("previous one\n");
    expect(readFileSync(`${log}.4`, "utf8")).toBe("previous three\n");
  });

  it("leaves a publisher log below the capacity threshold in place", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-publisher-log-small-"));
    temporaryDirectories.push(root);
    const checkout = join(root, "checkout");
    const fakeBin = join(root, "bin");
    const log = join(root, "publisher.log");
    const revision = "f".repeat(40);
    mkdirSync(join(checkout, ".git"), { recursive: true, mode: 0o700 });
    mkdirSync(fakeBin);
    writeFileSync(log, "small\n");
    executable(join(fakeBin, "shlock"), "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$4\" > \"$2\"\n");
    executable(join(fakeBin, "git"), `#!/bin/sh\nset -eu\ncase "$1" in\n  remote) printf '%s\\n' 'https://github.com/chanchan0391/ai-learning-os.git' ;;\n  fetch) exit 0 ;;\n  rev-parse) printf '%s\\n' '${revision}' ;;\n  *) exit 2 ;;\nesac\n`);
    executable(join(fakeBin, "ssh"), `#!/bin/sh\ncase "$*" in\n  *DEPLOYED_COMMIT*) printf '%s\\n' '${revision}' ;;\n  *) exit 0 ;;\nesac\n`);

    const result = spawnSync("sh", [publishScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        TMPDIR: root,
        AI_LEARNING_CHECKOUT_DIR: checkout,
        AI_LEARNING_PUBLISH_LOG: log,
        AI_LEARNING_PUBLISH_LOG_MAX_BYTES: "10",
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("small\n");
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  it("rejects a cached checkout whose origin differs from the configured repository", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-publisher-origin-"));
    temporaryDirectories.push(root);
    const checkout = join(root, "checkout");
    const fakeBin = join(root, "bin");
    const fetchMarker = join(root, "fetch-called");
    mkdirSync(join(checkout, ".git"), { recursive: true, mode: 0o700 });
    mkdirSync(fakeBin);
    executable(join(fakeBin, "shlock"), "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$4\" > \"$2\"\n");
    executable(join(fakeBin, "git"), `#!/bin/sh\nset -eu\ncase "$1" in\n  remote) printf '%s\\n' 'https://example.invalid/untrusted.git' ;;\n  fetch) touch "$FAKE_FETCH_MARKER" ;;\n  *) exit 2 ;;\nesac\n`);

    const result = spawnSync("sh", [publishScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        TMPDIR: root,
        AI_LEARNING_CHECKOUT_DIR: checkout,
        AI_LEARNING_PUBLISH_LOG: join(root, "publisher.log"),
        FAKE_FETCH_MARKER: fetchMarker,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Cached deployment repository origin does not match configuration");
    expect(existsSync(fetchMarker)).toBe(false);
    expect(existsSync(join(root, "ai-learning-os-publish-main.lock"))).toBe(false);
  });

  it("rejects a cached checkout redirected through a symlink before repository access", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-publisher-symlink-"));
    temporaryDirectories.push(root);
    const actualCheckout = join(root, "actual-checkout");
    const checkout = join(root, "checkout");
    const fakeBin = join(root, "bin");
    const gitMarker = join(root, "git-called");
    mkdirSync(join(actualCheckout, ".git"), { recursive: true });
    symlinkSync(actualCheckout, checkout);
    mkdirSync(fakeBin);
    executable(join(fakeBin, "shlock"), "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$4\" > \"$2\"\n");
    executable(join(fakeBin, "git"), "#!/bin/sh\ntouch \"$FAKE_GIT_MARKER\"\nexit 2\n");

    const result = spawnSync("sh", [publishScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        TMPDIR: root,
        AI_LEARNING_CHECKOUT_DIR: checkout,
        AI_LEARNING_PUBLISH_LOG: join(root, "publisher.log"),
        FAKE_GIT_MARKER: gitMarker,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Cached deployment checkout must be a real directory, not a symlink");
    expect(existsSync(gitMarker)).toBe(false);
    expect(existsSync(join(root, "ai-learning-os-publish-main.lock"))).toBe(false);
  });

  it("rejects cached Git metadata redirected through a symlink before repository access", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-publisher-git-symlink-"));
    temporaryDirectories.push(root);
    const checkout = join(root, "checkout");
    const fakeBin = join(root, "bin");
    const gitMarker = join(root, "git-called");
    mkdirSync(checkout, { mode: 0o700 });
    mkdirSync(join(root, "actual-git"));
    symlinkSync(join(root, "actual-git"), join(checkout, ".git"));
    mkdirSync(fakeBin);
    executable(join(fakeBin, "shlock"), "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$4\" > \"$2\"\n");
    executable(join(fakeBin, "git"), "#!/bin/sh\ntouch \"$FAKE_GIT_MARKER\"\nexit 2\n");

    const result = spawnSync("sh", [publishScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        TMPDIR: root,
        AI_LEARNING_CHECKOUT_DIR: checkout,
        AI_LEARNING_PUBLISH_LOG: join(root, "publisher.log"),
        FAKE_GIT_MARKER: gitMarker,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Cached deployment Git metadata must be a real directory, not a symlink");
    expect(existsSync(gitMarker)).toBe(false);
    expect(existsSync(join(root, "ai-learning-os-publish-main.lock"))).toBe(false);
  });

  it("rejects cached Git metadata not owned by the publisher before fetch", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-publisher-owner-"));
    temporaryDirectories.push(root);
    const checkout = join(root, "checkout");
    const fakeBin = join(root, "bin");
    const fetchMarker = join(root, "fetch-called");
    mkdirSync(join(checkout, ".git"), { recursive: true, mode: 0o700 });
    mkdirSync(fakeBin);
    executable(join(fakeBin, "shlock"), "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$4\" > \"$2\"\n");
    executable(join(fakeBin, "stat"), `#!/bin/sh\nset -eu\ncase "$3" in\n  */.git) printf '%s\\n' '0' ;;\n  *) printf '%s\\n' "$FAKE_CURRENT_UID" ;;\nesac\n`);
    executable(join(fakeBin, "git"), `#!/bin/sh\ncase "$1" in\n  fetch) touch "$FAKE_FETCH_MARKER" ;;\nesac\nexit 2\n`);

    const result = spawnSync("sh", [publishScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        TMPDIR: root,
        AI_LEARNING_CHECKOUT_DIR: checkout,
        AI_LEARNING_PUBLISH_LOG: join(root, "publisher.log"),
        FAKE_CURRENT_UID: String(process.getuid!()),
        FAKE_FETCH_MARKER: fetchMarker,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Cached deployment Git metadata must be owned by the publisher user");
    expect(existsSync(fetchMarker)).toBe(false);
    expect(existsSync(join(root, "ai-learning-os-publish-main.lock"))).toBe(false);
  });

  it("rejects a group-writable cached checkout before repository access", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-publisher-mode-"));
    temporaryDirectories.push(root);
    const checkout = join(root, "checkout");
    const fakeBin = join(root, "bin");
    const gitMarker = join(root, "git-called");
    mkdirSync(join(checkout, ".git"), { recursive: true, mode: 0o700 });
    chmodSync(checkout, 0o775);
    mkdirSync(fakeBin);
    executable(join(fakeBin, "shlock"), "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$4\" > \"$2\"\n");
    executable(join(fakeBin, "git"), "#!/bin/sh\ntouch \"$FAKE_GIT_MARKER\"\nexit 2\n");

    const result = spawnSync("sh", [publishScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        TMPDIR: root,
        AI_LEARNING_CHECKOUT_DIR: checkout,
        AI_LEARNING_PUBLISH_LOG: join(root, "publisher.log"),
        FAKE_GIT_MARKER: gitMarker,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Cached deployment checkout must not be writable by group or other users");
    expect(existsSync(gitMarker)).toBe(false);
    expect(existsSync(join(root, "ai-learning-os-publish-main.lock"))).toBe(false);
  });

  it("rejects a writable cache parent on a reused checkout before repository access", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-publisher-parent-mode-"));
    temporaryDirectories.push(root);
    const cacheParent = join(root, "cache");
    const checkout = join(cacheParent, "checkout");
    const fakeBin = join(root, "bin");
    const gitMarker = join(root, "git-called");
    mkdirSync(join(checkout, ".git"), { recursive: true, mode: 0o700 });
    chmodSync(cacheParent, 0o777);
    mkdirSync(fakeBin);
    executable(join(fakeBin, "shlock"), "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$4\" > \"$2\"\n");
    executable(join(fakeBin, "git"), "#!/bin/sh\ntouch \"$FAKE_GIT_MARKER\"\nexit 2\n");

    const result = spawnSync("sh", [publishScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        TMPDIR: root,
        AI_LEARNING_CHECKOUT_DIR: checkout,
        AI_LEARNING_PUBLISH_LOG: join(root, "publisher.log"),
        FAKE_GIT_MARKER: gitMarker,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Deployment cache parent must not be writable by group or other users");
    expect(existsSync(gitMarker)).toBe(false);
    expect(existsSync(join(root, "ai-learning-os-publish-main.lock"))).toBe(false);
  });

  it("falls back to GNU stat when validating cache ownership", () => {
    const publisher = readFileSync(publishScript, "utf8");

    expect(publisher).toContain("stat -f '%u'");
    expect(publisher).toContain("stat -c '%u'");
    expect(publisher).toContain("stat -f '%Lp'");
    expect(publisher).toContain("stat -c '%a'");
  });

  it("bounds deployment network operations so a partial outage cannot wedge the publisher", () => {
    const deployment = readFileSync(deployScript, "utf8");
    const publisher = readFileSync(publishScript, "utf8");

    expect(deployment).toContain(
      "curl --fail --silent --show-error --connect-timeout 2 --max-time 5 http://127.0.0.1:8088/",
    );
    expect(deployment).toContain(
      "--connect-timeout 10 --max-time 120 --speed-limit 1024 --speed-time 30",
    );
    expect(publisher).toContain(
      'ssh_options="-o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"',
    );
    expect(publisher).toContain('scp -q $ssh_options');
    expect(publisher).toContain('"$shlock_bin" -f "$lock_file" -p $$');
  });
});
