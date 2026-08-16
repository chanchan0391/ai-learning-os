import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const backupScript = join(repositoryRoot, "deploy/dev/backup.sh");
const backupHealthScript = join(repositoryRoot, "deploy/dev/backup-health.sh");
const verifyBackupScript = join(repositoryRoot, "deploy/dev/verify-backup.sh");
const restoreDrillScript = join(repositoryRoot, "deploy/dev/restore-drill.sh");
const resolveDockerScript = join(repositoryRoot, "deploy/dev/resolve-docker-bin.sh");
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

describe("dev Docker client trust", () => {
  function mappedRootCheck(invocationId: string, dockerPath: string, dockerDir: string) {
    return spawnSync("sh", ["-c", `. "$1"; is_systemd_mapped_root_docker 65534 65534 "$2" "$3"` , "sh", resolveDockerScript, dockerPath, dockerDir], {
      encoding: "utf8",
      env: { ...process.env, INVOCATION_ID: invocationId },
    });
  }

  it("accepts root ownership remapped by a hardened user service only for the system Docker path", () => {
    expect(mappedRootCheck("systemd-invocation", "/usr/bin/docker", "/usr/bin").status).toBe(0);
    expect(mappedRootCheck("systemd-invocation", "/opt/docker", "/opt").status).toBe(1);
  });

  it("rejects mapped ownership outside a systemd invocation", () => {
    expect(mappedRootCheck("", "/usr/bin/docker", "/usr/bin").status).toBe(1);
  });

  it("does not execute Docker validation helpers injected through PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-docker-path-"));
    temporaryDirectories.push(root);
    const fakeBin = join(root, "bin");
    const marker = join(root, "injected-helper-called");
    const docker = executable(join(root, "docker"), "#!/bin/sh\nexit 0\n");
    mkdirSync(fakeBin);
    for (const helper of ["dirname", "stat", "id"]) {
      executable(join(fakeBin, helper), `#!/bin/sh\ntouch "${marker}"\nexit 2\n`);
    }

    const result = spawnSync("sh", ["-c", '. "$1"; AI_LEARNING_DOCKER_BIN="$2"; resolve_trusted_docker_bin', "sh", resolveDockerScript, docker], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
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

  it("rejects a relative backup lock helper before creating the backup directory", () => {
    const fixture = makeFixture();

    const result = runBackup(fixture, { AI_LEARNING_FLOCK_BIN: "./flock" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("flock executable path must be absolute");
    expect(existsSync(fixture.backupDir)).toBe(false);
  });

  it("rejects a shared-writable backup lock helper before creating the backup directory", () => {
    const fixture = makeFixture();
    chmodSync(fixture.flock, 0o775);

    const result = runBackup(fixture);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("flock executable must not be group or other writable");
    expect(existsSync(fixture.backupDir)).toBe(false);
  });

  it("rejects a hard-linked metadata helper before creating the backup directory", () => {
    const fixture = makeFixture();
    const fakeStat = executable(join(dirname(fixture.flock), "stat"), "#!/bin/sh\nexec /usr/bin/stat \"$@\"\n");
    linkSync(fakeStat, join(dirname(fakeStat), "stat-shared"));

    const result = runBackup(fixture, { AI_LEARNING_STAT_BIN: fakeStat });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("stat executable must not be hard-linked unless it is a root-managed system tool");
    expect(existsSync(fixture.backupDir)).toBe(false);
  });

  it("removes the temporary artifact when archive verification fails", () => {
    const fixture = makeFixture();
    executable(fixture.docker, "#!/bin/sh\nset -eu\ncase \"$*\" in\n  *pg_dump*) printf 'invalid archive' ;;\n  *) exit 1 ;;\nesac\n");

    const result = runBackup(fixture);

    expect(result.status, result.stderr).toBe(1);
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

  it("reclaims abandoned temporary files and orphan checksums without traversing nested directories", () => {
    const fixture = makeFixture();
    mkdirSync(fixture.backupDir);
    const abandonedDump = join(fixture.backupDir, ".ai-learning-os-20260801T000000Z.abandoned");
    const abandonedChecksum = `${abandonedDump}.sha256`;
    const orphanChecksum = join(fixture.backupDir, "ai-learning-os-20260801T000000Z-orphan.dump.sha256");
    const nestedDir = join(fixture.backupDir, "nested");
    const nestedBackup = join(nestedDir, "ai-learning-os-20260801T000000Z-nested.dump");
    writeFileSync(abandonedDump, "partial archive");
    writeFileSync(abandonedChecksum, "partial checksum");
    writeFileSync(orphanChecksum, "orphan checksum");
    mkdirSync(nestedDir);
    writeFileSync(nestedBackup, "nested archive");
    const expiredAt = new Date(Date.now() - 9 * 24 * 60 * 60 * 1_000);
    for (const file of [abandonedDump, abandonedChecksum, orphanChecksum, nestedBackup]) {
      utimesSync(file, expiredAt, expiredAt);
    }

    const result = runBackup(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(abandonedDump)).toBe(false);
    expect(existsSync(abandonedChecksum)).toBe(false);
    expect(existsSync(orphanChecksum)).toBe(false);
    expect(readFileSync(nestedBackup, "utf8")).toBe("nested archive");
  });

  it("does not let a stale lock artifact block a later backup", () => {
    const fixture = makeFixture();
    mkdirSync(fixture.backupDir);
    writeFileSync(join(fixture.backupDir, ".backup.lock"), "stale owner\n");

    const result = runBackup(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(fixture.backupDir).filter((file) => file.endsWith(".dump"))).toHaveLength(1);
  });

  it("rejects a symlinked backup lock without truncating its target or accessing PostgreSQL", () => {
    const fixture = makeFixture();
    const lockTarget = join(dirname(fixture.backupDir), "operator-lock-target");
    const dockerMarker = join(dirname(fixture.docker), "docker-called");
    mkdirSync(fixture.backupDir);
    writeFileSync(lockTarget, "preserve me");
    symlinkSync(lockTarget, join(fixture.backupDir, ".backup.lock"));
    executable(fixture.docker, "#!/bin/sh\ntouch \"$FAKE_DOCKER_MARKER\"\nexit 2\n");

    const result = runBackup(fixture, { FAKE_DOCKER_MARKER: dockerMarker });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Backup lock must be a regular file, not a symlink");
    expect(readFileSync(lockTarget, "utf8")).toBe("preserve me");
    expect(existsSync(dockerMarker)).toBe(false);
  });

  it("rejects a hard-linked backup lock without changing the shared inode or accessing PostgreSQL", () => {
    const fixture = makeFixture();
    const lockTarget = join(dirname(fixture.backupDir), "operator-lock-target");
    const dockerMarker = join(dirname(fixture.docker), "docker-called");
    mkdirSync(fixture.backupDir);
    writeFileSync(lockTarget, "preserve me", { mode: 0o640 });
    const initialMode = statSync(lockTarget).mode & 0o777;
    linkSync(lockTarget, join(fixture.backupDir, ".backup.lock"));
    executable(fixture.docker, "#!/bin/sh\ntouch \"$FAKE_DOCKER_MARKER\"\nexit 2\n");

    const result = runBackup(fixture, { FAKE_DOCKER_MARKER: dockerMarker });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Backup lock must not be hard-linked");
    expect(readFileSync(lockTarget, "utf8")).toBe("preserve me");
    expect(statSync(lockTarget).mode & 0o777).toBe(initialMode);
    expect(existsSync(dockerMarker)).toBe(false);
  });

  it("rejects a symlinked Docker executable before accessing PostgreSQL", () => {
    const fixture = makeFixture();
    const dockerTarget = join(dirname(fixture.docker), "real-docker");
    const dockerLink = join(dirname(fixture.docker), "linked-docker");
    const dockerMarker = join(dirname(fixture.docker), "docker-called");
    executable(dockerTarget, "#!/bin/sh\ntouch \"$FAKE_DOCKER_MARKER\"\nexit 2\n");
    symlinkSync(dockerTarget, dockerLink);

    const result = runBackup(fixture, {
      AI_LEARNING_DOCKER_BIN: dockerLink,
      FAKE_DOCKER_MARKER: dockerMarker,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Docker executable is missing or unsafe");
    expect(existsSync(dockerMarker)).toBe(false);
  });

  it("preserves hard-linked stale backup artifacts during retention cleanup", () => {
    const fixture = makeFixture();
    const operatorFile = join(dirname(fixture.backupDir), "operator-archive");
    const managedLink = join(fixture.backupDir, "ai-learning-os-20260701T000000Z-linked.dump");
    mkdirSync(fixture.backupDir);
    writeFileSync(operatorFile, "preserve me");
    linkSync(operatorFile, managedLink);
    const expiredAt = new Date(Date.now() - 9 * 24 * 60 * 60 * 1_000);
    utimesSync(managedLink, expiredAt, expiredAt);

    const result = runBackup(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(operatorFile, "utf8")).toBe("preserve me");
    expect(readFileSync(managedLink, "utf8")).toBe("preserve me");
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

  it("rejects a symlinked backup directory before changing it or accessing PostgreSQL", () => {
    const fixture = makeFixture();
    const realBackupDir = join(dirname(fixture.backupDir), "redirected-backups");
    const dockerMarker = join(dirname(fixture.docker), "docker-called");
    mkdirSync(realBackupDir, { mode: 0o755 });
    const initialMode = statSync(realBackupDir).mode & 0o777;
    symlinkSync(realBackupDir, fixture.backupDir);
    executable(fixture.docker, "#!/bin/sh\ntouch \"$FAKE_DOCKER_MARKER\"\nexit 2\n");

    const result = runBackup(fixture, { FAKE_DOCKER_MARKER: dockerMarker });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be a real directory, not a symlink");
    expect(statSync(realBackupDir).mode & 0o777).toBe(initialMode);
    expect(readdirSync(realBackupDir)).toEqual([]);
    expect(existsSync(dockerMarker)).toBe(false);
  });

  it("rejects a relative backup directory before creating files or accessing PostgreSQL", () => {
    const fixture = makeFixture();
    const dockerMarker = join(dirname(fixture.docker), "docker-called");
    executable(fixture.docker, "#!/bin/sh\ntouch \"$FAKE_DOCKER_MARKER\"\nexit 2\n");

    const result = runBackup(fixture, {
      AI_LEARNING_BACKUP_DIR: "relative-backups",
      FAKE_DOCKER_MARKER: dockerMarker,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("path must be absolute");
    expect(existsSync(dockerMarker)).toBe(false);
  });
});

describe("dev database backup monitoring", () => {
  function makeHealthFixture() {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-backup-health-"));
    temporaryDirectories.push(root);
    const backupDir = join(root, "backups");
    const backup = join(backupDir, "ai-learning-os-20260815T120000Z-test.dump");
    const systemctl = executable(join(root, "systemctl"), "#!/bin/sh\nprintf '%s\\n' \"${FAKE_BACKUP_RESULT:-success}\"\n");
    mkdirSync(backupDir, { mode: 0o700 });
    writeFileSync(backup, "verified archive", { mode: 0o600 });
    writeFileSync(`${backup}.sha256`, `checksum  ${basename(backup)}\n`, { mode: 0o600 });
    return { backup, backupDir, systemctl };
  }

  function runBackupHealth(
    fixture: ReturnType<typeof makeHealthFixture>,
    extraEnv: NodeJS.ProcessEnv = {},
  ) {
    return spawnSync("sh", [backupHealthScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        AI_LEARNING_BACKUP_DIR: fixture.backupDir,
        AI_LEARNING_SYSTEMCTL_BIN: fixture.systemctl,
        ...extraEnv,
      },
    });
  }

  it("accepts a recent private backup after a successful job", () => {
    const fixture = makeHealthFixture();
    const legacyBackup = join(fixture.backupDir, "ai-learning-os-20260801T120000Z-legacy.dump");
    writeFileSync(legacyBackup, "legacy archive", { mode: 0o600 });
    const legacyTime = new Date(Date.now() - 86_400_000);
    utimesSync(legacyBackup, legacyTime, legacyTime);

    const result = runBackupHealth(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Database backup healthy");
  });

  it("reports the latest backup job failure immediately", () => {
    const fixture = makeHealthFixture();

    const result = runBackupHealth(fixture, { FAKE_BACKUP_RESULT: "exit-code" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Latest database backup job did not succeed: exit-code");
  });

  it("rejects a symlinked systemctl before querying backup state", () => {
    const fixture = makeHealthFixture();
    const marker = join(dirname(fixture.systemctl), "systemctl-called");
    const realSystemctl = executable(join(dirname(fixture.systemctl), "real-systemctl"), `#!/bin/sh\ntouch "${marker}"\n`);
    const linkedSystemctl = join(dirname(fixture.systemctl), "linked-systemctl");
    symlinkSync(realSystemctl, linkedSystemctl);

    const result = runBackupHealth(fixture, { AI_LEARNING_SYSTEMCTL_BIN: linkedSystemctl });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("systemctl executable is missing or unsafe");
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects a group-writable systemctl before querying backup state", () => {
    const fixture = makeHealthFixture();
    const marker = join(dirname(fixture.systemctl), "systemctl-called");
    executable(fixture.systemctl, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(fixture.systemctl, 0o775);

    const result = runBackupHealth(fixture);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("must not be group or other writable");
    expect(existsSync(marker)).toBe(false);
  });

  it("reports a stale backup even when the last job result was successful", () => {
    const fixture = makeHealthFixture();
    const staleTime = new Date(Date.now() - 3_600_000);
    utimesSync(fixture.backup, staleTime, staleTime);

    const result = runBackupHealth(fixture, { AI_LEARNING_BACKUP_MAX_AGE_SECONDS: "60" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Latest database backup is stale");
  });

  it("rejects an unsafe managed checksum before reporting health", () => {
    const fixture = makeHealthFixture();
    chmodSync(`${fixture.backup}.sha256`, 0o644);

    const result = runBackupHealth(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Latest managed backup checksum must not be accessible by group or other users");
  });
});

describe("dev backup restore preflight", () => {
  function makeBackupFixture() {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-verify-backup-"));
    temporaryDirectories.push(root);
    const backupDir = join(root, "backups");
    const backup = join(backupDir, "ai-learning-os-20260814T120000Z-test.dump");
    const docker = executable(join(root, "docker"), "#!/bin/sh\nset -eu\n[ \"$*\" = 'exec -i pg pg_restore --list' ]\n[ \"$(cat)\" = 'valid custom archive' ]\n");
    mkdirSync(backupDir, { mode: 0o700 });
    writeFileSync(backup, "valid custom archive", { mode: 0o600 });
    const checksum = createHash("sha256").update("valid custom archive").digest("hex");
    writeFileSync(`${backup}.sha256`, `${checksum}  ${basename(backup)}\n`, { mode: 0o600 });
    return { backup, backupDir, docker };
  }

  it("verifies a private managed backup without restoring it", () => {
    const fixture = makeBackupFixture();
    const result = spawnSync("sh", [verifyBackupScript, fixture.backup], {
      encoding: "utf8",
      env: { ...process.env, AI_LEARNING_DOCKER_BIN: fixture.docker },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Verified backup ai-learning-os-20260814T120000Z-test.dump");
  });

  it("does not execute checksum or parsing helpers injected through PATH", () => {
    const fixture = makeBackupFixture();
    const fakeBin = join(dirname(fixture.docker), "bin");
    const marker = join(dirname(fixture.docker), "injected-helper-called");
    mkdirSync(fakeBin);
    for (const helper of ["sha256sum", "shasum", "awk", "cat", "wc", "tr"]) {
      executable(join(fakeBin, helper), `#!/bin/sh\ntouch "${marker}"\nexit 2\n`);
    }

    const result = spawnSync("sh", [verifyBackupScript, fixture.backup], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        AI_LEARNING_DOCKER_BIN: fixture.docker,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects a tampered backup before PostgreSQL inspection", () => {
    const fixture = makeBackupFixture();
    writeFileSync(fixture.backup, "tampered archive", { mode: 0o600 });
    const dockerMarker = join(dirname(fixture.docker), "docker-called");
    executable(fixture.docker, "#!/bin/sh\ntouch \"$FAKE_DOCKER_MARKER\"\nexit 2\n");

    const result = spawnSync("sh", [verifyBackupScript, fixture.backup], {
      encoding: "utf8",
      env: { ...process.env, AI_LEARNING_DOCKER_BIN: fixture.docker, FAKE_DOCKER_MARKER: dockerMarker },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum verification failed");
    expect(existsSync(dockerMarker)).toBe(false);
  });

  it("rejects symlinked or non-private backup inputs", () => {
    const fixture = makeBackupFixture();
    const linkedBackup = join(fixture.backupDir, "ai-learning-os-20260814T120001Z-link.dump");
    symlinkSync(fixture.backup, linkedBackup);

    const linkedResult = spawnSync("sh", [verifyBackupScript, linkedBackup], {
      encoding: "utf8",
      env: { ...process.env, AI_LEARNING_DOCKER_BIN: fixture.docker },
    });
    expect(linkedResult.status).toBe(2);
    expect(linkedResult.stderr).toContain("regular file, not a symlink");

    chmodSync(fixture.backup, 0o644);
    const permissionResult = spawnSync("sh", [verifyBackupScript, fixture.backup], {
      encoding: "utf8",
      env: { ...process.env, AI_LEARNING_DOCKER_BIN: fixture.docker },
    });
    expect(permissionResult.status).toBe(2);
    expect(permissionResult.stderr).toContain("must not grant group or other access");
  });

  it("rejects a hard-linked backup before PostgreSQL inspection", () => {
    const fixture = makeBackupFixture();
    const externalLink = join(dirname(fixture.backupDir), "shared-backup.dump");
    const dockerMarker = join(dirname(fixture.docker), "docker-called");
    linkSync(fixture.backup, externalLink);
    executable(fixture.docker, "#!/bin/sh\ntouch \"$FAKE_DOCKER_MARKER\"\nexit 2\n");

    const result = spawnSync("sh", [verifyBackupScript, fixture.backup], {
      encoding: "utf8",
      env: { ...process.env, AI_LEARNING_DOCKER_BIN: fixture.docker, FAKE_DOCKER_MARKER: dockerMarker },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Backup must not be hard-linked");
    expect(readFileSync(externalLink, "utf8")).toBe("valid custom archive");
    expect(existsSync(dockerMarker)).toBe(false);
  });

  it("rejects a hard-linked checksum sidecar before PostgreSQL inspection", () => {
    const fixture = makeBackupFixture();
    const externalLink = join(dirname(fixture.backupDir), "shared-backup.sha256");
    const dockerMarker = join(dirname(fixture.docker), "docker-called");
    linkSync(`${fixture.backup}.sha256`, externalLink);
    executable(fixture.docker, "#!/bin/sh\ntouch \"$FAKE_DOCKER_MARKER\"\nexit 2\n");

    const result = spawnSync("sh", [verifyBackupScript, fixture.backup], {
      encoding: "utf8",
      env: { ...process.env, AI_LEARNING_DOCKER_BIN: fixture.docker, FAKE_DOCKER_MARKER: dockerMarker },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Backup checksum sidecar must not be hard-linked");
    expect(readFileSync(externalLink, "utf8")).toContain(basename(fixture.backup));
    expect(existsSync(dockerMarker)).toBe(false);
  });
});

describe("dev isolated restore drill", () => {
  function makeRestoreFixture() {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-restore-drill-"));
    temporaryDirectories.push(root);
    const backup = join(root, "ai-learning-os-20260814T120000Z-test.dump");
    const dockerLog = join(root, "docker.log");
    const verify = executable(join(root, "verify-backup.sh"), "#!/bin/sh\nset -eu\n[ \"$1\" = \"$FAKE_BACKUP\" ]\nprintf 'Verified backup\\n'\n");
    const docker = executable(join(root, "docker"), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *"psql -U postgres -d postgres -Atqc"*) exit 0 ;;
  *"createdb -U postgres ai_learning_os_restore_"*) exit 0 ;;
  *"pg_restore --exit-on-error"*) [ "$(cat)" = 'valid custom archive' ] ;;
  *"psql -U postgres -d ai_learning_os_restore_"*) printf '%s\\n' '11|4|1|2|3' ;;
  *"dropdb --if-exists --force -U postgres ai_learning_os_restore_"*) exit 0 ;;
  *) exit 2 ;;
esac
`);
    writeFileSync(backup, "valid custom archive");
    return { backup, docker, dockerLog, verify };
  }

  function runRestoreDrill(fixture: ReturnType<typeof makeRestoreFixture>) {
    return spawnSync("sh", [restoreDrillScript, fixture.backup], {
      encoding: "utf8",
      env: {
        ...process.env,
        AI_LEARNING_DOCKER_BIN: fixture.docker,
        AI_LEARNING_VERIFY_BACKUP_BIN: fixture.verify,
        FAKE_BACKUP: fixture.backup,
        FAKE_DOCKER_LOG: fixture.dockerLog,
      },
    });
  }

  it("restores into a new database, verifies non-sensitive metrics, and removes it", () => {
    const fixture = makeRestoreFixture();
    const result = runRestoreDrill(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Restore drill passed: 11 public tables, 4 migrations, 1 users, 2 plans, 3 daily records");
    const log = readFileSync(fixture.dockerLog, "utf8");
    expect(log).toContain("createdb -U postgres ai_learning_os_restore_");
    expect(log).toContain("dropdb --if-exists --force -U postgres ai_learning_os_restore_");
    expect(log).not.toContain("ai_learning_os -");
  });

  it("selects the newest managed backup for a scheduled drill", () => {
    const fixture = makeRestoreFixture();
    const newestBackup = join(dirname(fixture.backup), "ai-learning-os-20260815T120000Z-newest.dump");
    writeFileSync(newestBackup, "valid custom archive");
    writeFileSync(join(dirname(fixture.backup), "operator-notes.dump"), "do not restore");

    const result = spawnSync("sh", [restoreDrillScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        AI_LEARNING_BACKUP_DIR: dirname(fixture.backup),
        AI_LEARNING_DOCKER_BIN: fixture.docker,
        AI_LEARNING_VERIFY_BACKUP_BIN: fixture.verify,
        FAKE_BACKUP: newestBackup,
        FAKE_DOCKER_LOG: fixture.dockerLog,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Restore drill passed");
  });

  it("does not execute selection or result parsers injected through PATH", () => {
    const fixture = makeRestoreFixture();
    const fakeBin = join(dirname(fixture.docker), "bin");
    const marker = join(dirname(fixture.docker), "injected-helper-called");
    mkdirSync(fakeBin);
    for (const helper of ["dirname", "stat", "id", "find", "sort", "sed", "date", "tail"]) {
      executable(join(fakeBin, helper), `#!/bin/sh\ntouch "${marker}"\nexit 2\n`);
    }

    const result = spawnSync("sh", [restoreDrillScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        AI_LEARNING_BACKUP_DIR: dirname(fixture.backup),
        AI_LEARNING_DOCKER_BIN: fixture.docker,
        AI_LEARNING_VERIFY_BACKUP_BIN: fixture.verify,
        FAKE_BACKUP: fixture.backup,
        FAKE_DOCKER_LOG: fixture.dockerLog,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("removes the isolated database when restore fails", () => {
    const fixture = makeRestoreFixture();
    executable(fixture.docker, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *"psql -U postgres -d postgres -Atqc"*) exit 0 ;;
  *"createdb -U postgres ai_learning_os_restore_"*) exit 0 ;;
  *"pg_restore --exit-on-error"*) cat >/dev/null; exit 1 ;;
  *"dropdb --if-exists --force -U postgres ai_learning_os_restore_"*) exit 0 ;;
  *) exit 2 ;;
esac
`);

    const result = runRestoreDrill(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed isolated PostgreSQL restore");
    expect(readFileSync(fixture.dockerLog, "utf8")).toContain("dropdb --if-exists --force");
  });

  it("stops before database creation when the existence probe fails", () => {
    const fixture = makeRestoreFixture();
    executable(fixture.docker, "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$*\" >> \"$FAKE_DOCKER_LOG\"\nexit 1\n");

    const result = runRestoreDrill(fixture);

    expect(result.status).toBe(1);
    const log = readFileSync(fixture.dockerLog, "utf8");
    expect(log).toContain("psql -U postgres -d postgres -Atqc");
    expect(log).not.toContain("createdb");
    expect(log).not.toContain("dropdb");
  });

  it("rejects a hard-linked verification runner before executing it or accessing PostgreSQL", () => {
    const fixture = makeRestoreFixture();
    const sharedRunner = join(dirname(fixture.verify), "shared-verify-runner.sh");
    const verifyMarker = join(dirname(fixture.verify), "verify-called");
    linkSync(fixture.verify, sharedRunner);
    executable(fixture.verify, "#!/bin/sh\ntouch \"$FAKE_VERIFY_MARKER\"\nexit 2\n");

    const result = spawnSync("sh", [restoreDrillScript, fixture.backup], {
      encoding: "utf8",
      env: {
        ...process.env,
        AI_LEARNING_DOCKER_BIN: fixture.docker,
        AI_LEARNING_VERIFY_BACKUP_BIN: fixture.verify,
        FAKE_BACKUP: fixture.backup,
        FAKE_DOCKER_LOG: fixture.dockerLog,
        FAKE_VERIFY_MARKER: verifyMarker,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Backup verification runner must not be hard-linked");
    expect(readFileSync(sharedRunner, "utf8")).toContain("FAKE_VERIFY_MARKER");
    expect(existsSync(verifyMarker)).toBe(false);
    expect(existsSync(fixture.dockerLog)).toBe(false);
  });

  it("rejects a group-writable verification runner before executing it or accessing PostgreSQL", () => {
    const fixture = makeRestoreFixture();
    const verifyMarker = join(dirname(fixture.verify), "verify-called");
    executable(fixture.verify, "#!/bin/sh\ntouch \"$FAKE_VERIFY_MARKER\"\nexit 2\n");
    chmodSync(fixture.verify, 0o775);

    const result = spawnSync("sh", [restoreDrillScript, fixture.backup], {
      encoding: "utf8",
      env: {
        ...process.env,
        AI_LEARNING_DOCKER_BIN: fixture.docker,
        AI_LEARNING_VERIFY_BACKUP_BIN: fixture.verify,
        FAKE_BACKUP: fixture.backup,
        FAKE_DOCKER_LOG: fixture.dockerLog,
        FAKE_VERIFY_MARKER: verifyMarker,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Backup verification runner must not be group or other writable");
    expect(existsSync(verifyMarker)).toBe(false);
    expect(existsSync(fixture.dockerLog)).toBe(false);
  });

  it("rejects a verification runner in a group-writable directory before executing it or accessing PostgreSQL", () => {
    const fixture = makeRestoreFixture();
    const runnerDirectory = dirname(fixture.verify);
    const verifyMarker = join(runnerDirectory, "verify-called");
    executable(fixture.verify, "#!/bin/sh\ntouch \"$FAKE_VERIFY_MARKER\"\nexit 2\n");
    chmodSync(runnerDirectory, 0o770);

    const result = spawnSync("sh", [restoreDrillScript, fixture.backup], {
      encoding: "utf8",
      env: {
        ...process.env,
        AI_LEARNING_DOCKER_BIN: fixture.docker,
        AI_LEARNING_VERIFY_BACKUP_BIN: fixture.verify,
        FAKE_BACKUP: fixture.backup,
        FAKE_DOCKER_LOG: fixture.dockerLog,
        FAKE_VERIFY_MARKER: verifyMarker,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Backup verification runner directory must not be group or other writable");
    expect(existsSync(verifyMarker)).toBe(false);
    expect(existsSync(fixture.dockerLog)).toBe(false);
  });

  it("rejects a relative verification runner path before executing it or accessing PostgreSQL", () => {
    const fixture = makeRestoreFixture();
    const verifyMarker = join(dirname(fixture.verify), "verify-called");
    const relativeRunner = basename(fixture.verify);

    const result = spawnSync("sh", [restoreDrillScript, fixture.backup], {
      cwd: dirname(fixture.verify),
      encoding: "utf8",
      env: {
        ...process.env,
        AI_LEARNING_DOCKER_BIN: fixture.docker,
        AI_LEARNING_VERIFY_BACKUP_BIN: relativeRunner,
        FAKE_BACKUP: fixture.backup,
        FAKE_DOCKER_LOG: fixture.dockerLog,
        FAKE_VERIFY_MARKER: verifyMarker,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Backup verification runner path must be absolute");
    expect(existsSync(verifyMarker)).toBe(false);
    expect(existsSync(fixture.dockerLog)).toBe(false);
  });

  it("rejects a hard-linked Docker executable before verification or PostgreSQL access", () => {
    const fixture = makeRestoreFixture();
    const sharedDocker = join(dirname(fixture.docker), "shared-docker");
    const verifyMarker = join(dirname(fixture.verify), "verify-called");
    linkSync(fixture.docker, sharedDocker);
    executable(fixture.verify, "#!/bin/sh\ntouch \"$FAKE_VERIFY_MARKER\"\nexit 2\n");

    const result = spawnSync("sh", [restoreDrillScript, fixture.backup], {
      encoding: "utf8",
      env: {
        ...process.env,
        AI_LEARNING_DOCKER_BIN: fixture.docker,
        AI_LEARNING_VERIFY_BACKUP_BIN: fixture.verify,
        FAKE_BACKUP: fixture.backup,
        FAKE_DOCKER_LOG: fixture.dockerLog,
        FAKE_VERIFY_MARKER: verifyMarker,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Docker executable must not be hard-linked");
    expect(existsSync(verifyMarker)).toBe(false);
    expect(existsSync(fixture.dockerLog)).toBe(false);
  });
});

describe("dev operational runner updates", () => {
  it("rejects a symlinked deployment directory before writing managed state", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-deploy-base-symlink-"));
    temporaryDirectories.push(root);
    const redirected = join(root, "redirected");
    const baseDir = join(root, "service");
    mkdirSync(redirected);
    writeFileSync(join(redirected, "operator-file"), "preserve me");
    symlinkSync(redirected, baseDir);

    const result = spawnSync("sh", [deployScript, "a".repeat(40)], {
      encoding: "utf8",
      env: { ...process.env, AI_LEARNING_DEPLOY_DIR: baseDir },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Deployment directory must be a real directory, not a symlink");
    expect(readFileSync(join(redirected, "operator-file"), "utf8")).toBe("preserve me");
    expect(existsSync(join(redirected, "deploy.lock"))).toBe(false);
  });

  it("rejects a symlinked deployment lock without changing its target", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-deploy-lock-symlink-"));
    temporaryDirectories.push(root);
    const baseDir = join(root, "service");
    const lockTarget = join(root, "operator-lock-target");
    mkdirSync(join(baseDir, "releases"), { recursive: true });
    mkdirSync(join(baseDir, "deploy-logs"));
    mkdirSync(join(baseDir, "incoming"));
    writeFileSync(lockTarget, "preserve me", { mode: 0o644 });
    const initialMode = statSync(lockTarget).mode & 0o777;
    symlinkSync(lockTarget, join(baseDir, "deploy.lock"));

    const result = spawnSync("sh", [deployScript, "a".repeat(40)], {
      encoding: "utf8",
      env: { ...process.env, AI_LEARNING_DEPLOY_DIR: baseDir },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Deployment lock must be a regular file, not a symlink");
    expect(readFileSync(lockTarget, "utf8")).toBe("preserve me");
    expect(statSync(lockTarget).mode & 0o777).toBe(initialMode);
  });

  it("converges deployment-managed directories to private permissions before locking", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-deploy-directory-mode-"));
    temporaryDirectories.push(root);
    const baseDir = join(root, "service");
    const lockTarget = join(root, "operator-lock-target");
    mkdirSync(join(baseDir, "releases"), { recursive: true, mode: 0o775 });
    mkdirSync(join(baseDir, "deploy-logs"), { mode: 0o775 });
    mkdirSync(join(baseDir, "incoming"), { mode: 0o775 });
    chmodSync(baseDir, 0o775);
    writeFileSync(lockTarget, "preserve me", { mode: 0o644 });
    symlinkSync(lockTarget, join(baseDir, "deploy.lock"));

    const result = spawnSync("sh", [deployScript, "a".repeat(40)], {
      encoding: "utf8",
      env: { ...process.env, AI_LEARNING_DEPLOY_DIR: baseDir },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Deployment lock must be a regular file, not a symlink");
    for (const directory of [baseDir, join(baseDir, "releases"), join(baseDir, "deploy-logs"), join(baseDir, "incoming")]) {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects deployment directories not owned by the deployment user", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-deploy-owner-"));
    temporaryDirectories.push(root);
    const baseDir = join(root, "service");
    const fakeStat = executable(join(root, "stat"), "#!/bin/sh\nprintf '%s\\n' 999999\n");

    const result = spawnSync("sh", [deployScript, "a".repeat(40)], {
      encoding: "utf8",
      env: {
        ...process.env,
        AI_LEARNING_DEPLOY_DIR: baseDir,
        AI_LEARNING_STAT_BIN: fakeStat,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Deployment directory must be owned by the deployment user");
    expect(existsSync(join(baseDir, "deploy.lock"))).toBe(false);
  });

  it("rejects an existing deployment lock not owned by the deployment user", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-deploy-lock-owner-"));
    temporaryDirectories.push(root);
    const baseDir = join(root, "service");
    const deployLock = join(baseDir, "deploy.lock");
    const realStat = executable(join(root, "real-stat"), `#!/bin/sh\nexec stat "$@"\n`);
    const fakeStat = executable(join(root, "stat"), `#!/bin/sh
case "$3" in
  *deploy.lock) printf '%s\\n' 999999 ;;
  *) exec "${realStat}" "$@" ;;
esac
`);
    mkdirSync(join(baseDir, "releases"), { recursive: true });
    mkdirSync(join(baseDir, "deploy-logs"));
    mkdirSync(join(baseDir, "incoming"));
    writeFileSync(deployLock, "preserve me", { mode: 0o644 });
    const initialMode = statSync(deployLock).mode & 0o777;

    const result = spawnSync("sh", [deployScript, "a".repeat(40)], {
      encoding: "utf8",
      env: {
        ...process.env,
        AI_LEARNING_DEPLOY_DIR: baseDir,
        AI_LEARNING_STAT_BIN: fakeStat,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Deployment lock must be owned by the deployment user");
    expect(readFileSync(deployLock, "utf8")).toBe("preserve me");
    expect(statSync(deployLock).mode & 0o777).toBe(initialMode);
  });

  it("rejects a hard-linked deployment lock without changing the shared inode", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-deploy-lock-hardlink-"));
    temporaryDirectories.push(root);
    const baseDir = join(root, "service");
    const lockTarget = join(root, "operator-lock-target");
    mkdirSync(join(baseDir, "releases"), { recursive: true });
    mkdirSync(join(baseDir, "deploy-logs"));
    mkdirSync(join(baseDir, "incoming"));
    writeFileSync(lockTarget, "preserve me", { mode: 0o644 });
    const initialMode = statSync(lockTarget).mode & 0o777;
    linkSync(lockTarget, join(baseDir, "deploy.lock"));

    const result = spawnSync("sh", [deployScript, "a".repeat(40)], {
      encoding: "utf8",
      env: { ...process.env, AI_LEARNING_DEPLOY_DIR: baseDir },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Deployment lock must not be hard-linked");
    expect(readFileSync(lockTarget, "utf8")).toBe("preserve me");
    expect(statSync(lockTarget).mode & 0o777).toBe(initialMode);
    expect(statSync(lockTarget).nlink).toBe(2);
  });

  it("rejects hard-linked installed runners without replacing the shared inode", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-runner-hardlink-"));
    temporaryDirectories.push(root);
    const baseDir = join(root, "service");
    const current = join(baseDir, "current");
    const releaseOperations = join(current, "deploy/dev");
    const fakeBin = join(root, "bin");
    const runnerTarget = join(root, "operator-runner");
    const revision = "a".repeat(40);
    mkdirSync(releaseOperations, { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(join(current, "DEPLOYED_COMMIT"), `${revision}\n`);
    for (const runner of ["deploy-main.sh", "backup.sh", "backup-health.sh", "application-health.sh", "host-capacity.sh", "verify-backup.sh", "restore-drill.sh", "resolve-docker-bin.sh"]) {
      writeFileSync(join(releaseOperations, runner), `${runner} current\n`);
    }
    writeFileSync(runnerTarget, "preserve me", { mode: 0o755 });
    linkSync(runnerTarget, join(baseDir, "deploy-main.sh"));
    executable(join(fakeBin, "flock"), "#!/bin/sh\nexit 0\n");

    const result = spawnSync("sh", [deployScript, revision], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        AI_LEARNING_DEPLOY_DIR: baseDir,
        AI_LEARNING_NODE_BIN: process.execPath,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Installed deploy-main.sh must not be hard-linked");
    expect(readFileSync(runnerTarget, "utf8")).toBe("preserve me");
    expect(statSync(runnerTarget).nlink).toBe(2);
  });

  it("rejects hard-linked runner sources from the active release", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-runner-source-hardlink-"));
    temporaryDirectories.push(root);
    const baseDir = join(root, "service");
    const current = join(baseDir, "current");
    const releaseOperations = join(current, "deploy/dev");
    const fakeBin = join(root, "bin");
    const runnerTarget = join(root, "operator-runner-source");
    const revision = "a".repeat(40);
    mkdirSync(releaseOperations, { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(join(current, "DEPLOYED_COMMIT"), `${revision}\n`);
    writeFileSync(runnerTarget, "preserve me", { mode: 0o755 });
    linkSync(runnerTarget, join(releaseOperations, "deploy-main.sh"));
    for (const runner of ["backup.sh", "backup-health.sh", "application-health.sh", "host-capacity.sh", "verify-backup.sh", "restore-drill.sh", "resolve-docker-bin.sh"]) {
      writeFileSync(join(releaseOperations, runner), `${runner} current\n`);
    }
    executable(join(fakeBin, "flock"), "#!/bin/sh\nexit 0\n");

    const result = spawnSync("sh", [deployScript, revision], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        AI_LEARNING_DEPLOY_DIR: baseDir,
        AI_LEARNING_NODE_BIN: process.execPath,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Active release deploy-main.sh must not be hard-linked");
    expect(readFileSync(runnerTarget, "utf8")).toBe("preserve me");
    expect(statSync(runnerTarget).nlink).toBe(2);
  });

  it("rejects a symlinked existing release without removing its target", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-release-symlink-"));
    temporaryDirectories.push(root);
    const baseDir = join(root, "service");
    const incoming = join(baseDir, "incoming");
    const releases = join(baseDir, "releases");
    const fakeBin = join(root, "bin");
    const revision = "a".repeat(40);
    const archive = join(incoming, `${revision}.tar.gz`);
    const releaseTarget = join(root, "operator-release");
    mkdirSync(incoming, { recursive: true });
    mkdirSync(releases);
    mkdirSync(fakeBin);
    mkdirSync(releaseTarget);
    writeFileSync(join(releaseTarget, "operator-file"), "preserve me");
    writeFileSync(archive, "unused archive");
    symlinkSync(releaseTarget, join(releases, revision));
    executable(join(fakeBin, "flock"), "#!/bin/sh\nexit 0\n");

    const result = spawnSync("sh", [deployScript, revision, archive, "0".repeat(64)], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        AI_LEARNING_DEPLOY_DIR: baseDir,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Existing release directory must be a real directory, not a symlink");
    expect(readFileSync(join(releaseTarget, "operator-file"), "utf8")).toBe("preserve me");
    expect(existsSync(releaseTarget)).toBe(true);
  });

  it("refreshes deployment, backup, and verification runners for an already deployed revision", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-runners-"));
    temporaryDirectories.push(root);
    const baseDir = join(root, "service");
    const current = join(baseDir, "current");
    const releaseOperations = join(current, "deploy/dev");
    const fakeBin = join(root, "bin");
    const controlPlaneLog = join(root, "control-plane.log");
    const revision = "a".repeat(40);
    mkdirSync(releaseOperations, { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(join(current, "DEPLOYED_COMMIT"), `${revision}\n`);
    writeFileSync(join(releaseOperations, "deploy-main.sh"), "new deploy runner\n");
    writeFileSync(join(releaseOperations, "backup.sh"), "new backup runner\n");
    writeFileSync(join(releaseOperations, "backup-health.sh"), "new backup monitor\n");
    writeFileSync(join(releaseOperations, "application-health.sh"), "new application monitor\n");
    writeFileSync(join(releaseOperations, "host-capacity.sh"), "new capacity monitor\n");
    writeFileSync(join(releaseOperations, "verify-backup.sh"), "new verify runner\n");
    writeFileSync(join(releaseOperations, "restore-drill.sh"), "new restore runner\n");
    writeFileSync(join(releaseOperations, "resolve-docker-bin.sh"), "new Docker resolver\n");
    executable(join(releaseOperations, "control-plane.sh"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FAKE_CONTROL_PLANE_LOG\"\n");
    writeFileSync(join(baseDir, "deploy-main.sh"), "old deploy runner\n");
    writeFileSync(join(baseDir, "backup.sh"), "old backup runner\n");
    writeFileSync(join(baseDir, "backup-health.sh"), "old backup monitor\n");
    writeFileSync(join(baseDir, "application-health.sh"), "old application monitor\n");
    writeFileSync(join(baseDir, "host-capacity.sh"), "old capacity monitor\n");
    writeFileSync(join(baseDir, "verify-backup.sh"), "old verify runner\n");
    writeFileSync(join(baseDir, "restore-drill.sh"), "old restore runner\n");
    writeFileSync(join(baseDir, "resolve-docker-bin.sh"), "old Docker resolver\n");
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
        FAKE_CONTROL_PLANE_LOG: controlPlaneLog,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Revision ${revision} is already deployed`);
    expect(readFileSync(join(baseDir, "deploy-main.sh"), "utf8")).toBe("new deploy runner\n");
    expect(readFileSync(join(baseDir, "backup.sh"), "utf8")).toBe("new backup runner\n");
    expect(readFileSync(join(baseDir, "backup-health.sh"), "utf8")).toBe("new backup monitor\n");
    expect(readFileSync(join(baseDir, "application-health.sh"), "utf8")).toBe("new application monitor\n");
    expect(readFileSync(join(baseDir, "host-capacity.sh"), "utf8")).toBe("new capacity monitor\n");
    expect(readFileSync(join(baseDir, "verify-backup.sh"), "utf8")).toBe("new verify runner\n");
    expect(readFileSync(join(baseDir, "restore-drill.sh"), "utf8")).toBe("new restore runner\n");
    expect(readFileSync(join(baseDir, "resolve-docker-bin.sh"), "utf8")).toBe("new Docker resolver\n");
    expect(statSync(join(baseDir, "deploy-main.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(baseDir, "backup.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(baseDir, "backup-health.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(baseDir, "application-health.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(baseDir, "host-capacity.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(baseDir, "verify-backup.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(baseDir, "restore-drill.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(baseDir, "resolve-docker-bin.sh")).mode & 0o777).toBe(0o755);
    expect(readFileSync(controlPlaneLog, "utf8")).toBe("install\n");
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
    for (const runner of ["deploy-main.sh", "backup.sh", "backup-health.sh", "application-health.sh", "host-capacity.sh", "verify-backup.sh", "restore-drill.sh", "resolve-docker-bin.sh"]) {
      writeFileSync(join(releaseOperations, runner), `${runner} current\n`);
      executable(join(baseDir, runner), `${runner} current\n`);
      utimesSync(join(baseDir, runner), fixedTime, fixedTime);
    }
    executable(join(releaseOperations, "control-plane.sh"), "#!/bin/sh\nexit 0\n");
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
    for (const runner of ["deploy-main.sh", "backup.sh", "backup-health.sh", "application-health.sh", "host-capacity.sh", "verify-backup.sh", "restore-drill.sh", "resolve-docker-bin.sh"]) {
      expect(statSync(join(baseDir, runner)).mtimeMs).toBe(fixedTime.getTime());
    }
  }, 15_000);

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
    for (const runner of ["deploy-main.sh", "backup.sh", "backup-health.sh", "application-health.sh", "host-capacity.sh", "verify-backup.sh", "restore-drill.sh", "resolve-docker-bin.sh"]) {
      writeFileSync(join(releaseOperations, runner), `${runner} current\n`);
      executable(join(baseDir, runner), `${runner} current\n`);
    }
    executable(join(releaseOperations, "control-plane.sh"), "#!/bin/sh\nexit 0\n");
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

  it("verifies the previous release after a failed deployment rolls back", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-learning-rollback-"));
    temporaryDirectories.push(root);
    const baseDir = join(root, "service");
    const incoming = join(baseDir, "incoming");
    const oldRelease = join(baseDir, "releases", "old");
    const archiveRoot = join(root, "archive");
    const fakeBin = join(root, "bin");
    const systemctlLog = join(root, "systemctl.log");
    const oldRevision = "a".repeat(40);
    const newRevision = "b".repeat(40);
    const archive = join(incoming, `${newRevision}.tar.gz`);
    mkdirSync(incoming, { recursive: true });
    mkdirSync(oldRelease, { recursive: true });
    mkdirSync(join(archiveRoot, "deploy/dev"), { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(join(oldRelease, "DEPLOYED_COMMIT"), `${oldRevision}\n`);
    symlinkSync(oldRelease, join(baseDir, "current"));
    writeFileSync(join(baseDir, "app.env"), "");
    executable(join(baseDir, "backup.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(archiveRoot, "package.json"), "{}\n");
    writeFileSync(join(archiveRoot, "deploy/dev/deploy-main.sh"), "new deploy runner\n");
    writeFileSync(join(archiveRoot, "deploy/dev/backup.sh"), "new backup runner\n");
    writeFileSync(join(archiveRoot, "deploy/dev/backup-health.sh"), "new backup monitor\n");
    writeFileSync(join(archiveRoot, "deploy/dev/application-health.sh"), "new application monitor\n");
    writeFileSync(join(archiveRoot, "deploy/dev/host-capacity.sh"), "new capacity monitor\n");
    writeFileSync(join(archiveRoot, "deploy/dev/verify-backup.sh"), "new verify runner\n");
    writeFileSync(join(archiveRoot, "deploy/dev/restore-drill.sh"), "new restore runner\n");
    writeFileSync(join(archiveRoot, "deploy/dev/resolve-docker-bin.sh"), "new Docker resolver\n");
    const tarResult = spawnSync("tar", ["-czf", archive, "-C", archiveRoot, "."], { encoding: "utf8" });
    expect(tarResult.status, tarResult.stderr).toBe(0);
    const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");

    executable(join(fakeBin, "flock"), "#!/bin/sh\nexit 0\n");
    executable(join(fakeBin, "mv"), "#!/bin/sh\nif [ \"\${1:-}\" = \"-Tf\" ]; then shift; exec /bin/mv -f \"$@\"; fi\nexec /bin/mv \"$@\"\n");
    executable(join(fakeBin, "npm"), "#!/bin/sh\nexit 0\n");
    executable(join(fakeBin, "sha256sum"), "#!/bin/sh\nprintf '%s  %s\\n' \"$FAKE_ARCHIVE_CHECKSUM\" \"$1\"\n");
    const fakeNode = executable(join(fakeBin, "node"), `#!/bin/sh
set -eu
if [ "\${1:-}" = "-e" ]; then
  body=$(cat)
  expected=$3
  printf '%s' "$body" | grep -Fq "\\\"releaseRevision\\\":\\\"$expected\\\""
fi
`);
    executable(join(fakeBin, "systemctl"), `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_SYSTEMCTL_LOG"
case "$*" in
  *" show "*) printf '%s\n' "$FAKE_MAIN_PID" ;;
  *) exit 0 ;;
esac
`);
    executable(join(fakeBin, "curl"), `#!/bin/sh
set -eu
case "$*" in
  *8787/api/health*) printf '%s\n' '{"status":"ok","releaseRevision":"${oldRevision}","aiEnabled":true,"syncEnabled":true}' ;;
  *) exit 0 ;;
esac
`);
    executable(join(fakeBin, "readlink"), `#!/bin/sh
if [ "\${1:-}" = "-f" ]; then
  case "\${2:-}" in
    /proc/*/exe|"$FAKE_NODE_BIN") printf '%s\n' "$FAKE_NODE_BIN"; exit 0 ;;
  esac
fi
exec /usr/bin/readlink "$@"
`);
    executable(join(fakeBin, "sleep"), "#!/bin/sh\nexit 0\n");

    const result = spawnSync("sh", [deployScript, newRevision, archive, checksum], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        AI_LEARNING_DEPLOY_DIR: baseDir,
        AI_LEARNING_NODE_BIN: fakeNode,
        AI_LEARNING_NPM_BIN: join(fakeBin, "npm"),
        FAKE_MAIN_PID: String(process.pid),
        FAKE_NODE_BIN: fakeNode,
        FAKE_ARCHIVE_CHECKSUM: checksum,
        FAKE_SYSTEMCTL_LOG: systemctlLog,
      },
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`Health check failed for ${newRevision}; rolling back`);
    expect(result.stderr).toContain(`Rolled back to ${oldRevision} and verified service health`);
    expect(readFileSync(join(baseDir, "current", "DEPLOYED_COMMIT"), "utf8")).toBe(`${oldRevision}\n`);
    expect(existsSync(join(baseDir, "releases", newRevision))).toBe(false);
    expect(existsSync(oldRelease)).toBe(true);
    expect(readFileSync(systemctlLog, "utf8").match(/--user restart/g)).toHaveLength(2);
  }, 15_000);

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
