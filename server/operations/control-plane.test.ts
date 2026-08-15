import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const controlPlaneScript = join(repositoryRoot, "deploy/dev/control-plane.sh");
const temporaryDirectories: string[] = [];
const sandboxDirectives = [
  "UMask=0077",
  "NoNewPrivileges=true",
  "PrivateTmp=true",
  "ProtectSystem=strict",
  "ProtectHome=read-only",
  "ProtectControlGroups=true",
  "ProtectKernelTunables=true",
  "RestrictSUIDSGID=true",
  "RestrictRealtime=true",
  "LockPersonality=true",
  "RemoveIPC=true",
  "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
  "SystemCallArchitectures=native",
];

function unitContents(execStart: string) {
  return `[Service]\nExecStart=${execStart} app.js\n${sandboxDirectives.join("\n")}\n`;
}

interface Fixture {
  baseDir: string;
  env: NodeJS.ProcessEnv;
  sourceDir: string;
  unitDir: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ai-learning-control-plane-"));
  temporaryDirectories.push(root);
  const baseDir = join(root, "service");
  const sourceDir = join(root, "source");
  const unitDir = join(root, "units");
  const procRoot = join(root, "proc");
  const fakeSystemctl = join(root, "systemctl");
  const fakeFlock = join(root, "flock");
  const fakeLog = join(root, "systemctl.log");
  const pid = String(process.pid);

  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(unitDir, { recursive: true });
  mkdirSync(join(procRoot, pid), { recursive: true });
  symlinkSync(process.execPath, join(procRoot, pid, "exe"));

  for (const unit of ["ai-learning-os-api.service", "ai-learning-os-web.service"]) {
    writeFileSync(join(sourceDir, unit), unitContents(process.execPath));
    writeFileSync(join(unitDir, unit), `[Service]\nExecStart=/old/node app.js\n`);
  }

  writeFileSync(fakeSystemctl, `#!/bin/sh\nset -eu\nprintf '%s\\n' "$*" >> "$FAKE_SYSTEMCTL_LOG"\ncase "$*" in\n  *" show "*) printf '%s\\n' "$FAKE_MAIN_PID" ;;\n  *" is-active "*) [ "\${FAKE_ACTIVE:-true}" = true ] ;;\n  *) exit 0 ;;\nesac\n`);
  chmodSync(fakeSystemctl, 0o755);
  writeFileSync(fakeFlock, "#!/bin/sh\n[ \"${FAKE_FLOCK_AVAILABLE:-true}\" = true ]\n");
  chmodSync(fakeFlock, 0o755);

  return {
    baseDir,
    sourceDir,
    unitDir,
    env: {
      ...process.env,
      AI_LEARNING_DEPLOY_DIR: baseDir,
      AI_LEARNING_CONTROL_PLANE_SOURCE_DIR: sourceDir,
      AI_LEARNING_SYSTEMD_USER_DIR: unitDir,
      AI_LEARNING_NODE_BIN: process.execPath,
      AI_LEARNING_SYSTEMCTL_BIN: fakeSystemctl,
      AI_LEARNING_FLOCK_BIN: fakeFlock,
      AI_LEARNING_PROC_ROOT: procRoot,
      FAKE_SYSTEMCTL_LOG: fakeLog,
      FAKE_MAIN_PID: pid,
    },
  };
}

function runControlPlane(fixture: Fixture, action: "install" | "status", extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("sh", [controlPlaneScript, action], {
    encoding: "utf8",
    env: { ...fixture.env, ...extraEnv },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("dev control-plane management", () => {
  it("backs up and atomically installs verified user units", () => {
    const fixture = makeFixture();

    const result = runControlPlane(fixture, "install");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("selected runtime");
    for (const unit of ["ai-learning-os-api.service", "ai-learning-os-web.service"]) {
      expect(readFileSync(join(fixture.unitDir, unit), "utf8")).toBe(unitContents(process.execPath));
    }
    const backupRoot = join(fixture.baseDir, "control-plane-backups");
    const backups = readdirSync(backupRoot);
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(backupRoot, backups[0], "ai-learning-os-api.service"), "utf8")).toContain("/old/node");
  });

  it("does not let a stale lock artifact block a later install", () => {
    const fixture = makeFixture();
    mkdirSync(fixture.baseDir, { recursive: true });
    writeFileSync(join(fixture.baseDir, "control-plane.lock"), "stale owner\n");

    const result = runControlPlane(fixture, "install");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("selected runtime");
    expect(statSync(join(fixture.baseDir, "control-plane.lock")).mode & 0o777).toBe(0o600);
  });

  it("rejects a symlinked control-plane backup directory before changing its target", () => {
    const fixture = makeFixture();
    const redirected = join(dirname(fixture.baseDir), "redirected-backups");
    mkdirSync(fixture.baseDir, { recursive: true });
    mkdirSync(redirected);
    writeFileSync(join(redirected, "operator-file"), "preserve me");
    symlinkSync(redirected, join(fixture.baseDir, "control-plane-backups"));

    const result = runControlPlane(fixture, "install");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Control-plane backup directory must be a real directory, not a symlink");
    expect(readFileSync(join(redirected, "operator-file"), "utf8")).toBe("preserve me");
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-api.service"), "utf8")).toContain("/old/node");
  });

  it("rejects a symlinked control-plane lock without truncating its target", () => {
    const fixture = makeFixture();
    mkdirSync(fixture.baseDir, { recursive: true });
    const target = join(dirname(fixture.baseDir), "operator-lock-target");
    writeFileSync(target, "preserve me");
    symlinkSync(target, join(fixture.baseDir, "control-plane.lock"));

    const result = runControlPlane(fixture, "install");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("lock must be a regular file, not a symlink");
    expect(readFileSync(target, "utf8")).toBe("preserve me");
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-api.service"), "utf8")).toContain("/old/node");
  });

  it("rejects control-plane directories not owned by the current user", () => {
    const fixture = makeFixture();
    const fakeStat = join(dirname(fixture.baseDir), "stat");
    writeFileSync(fakeStat, "#!/bin/sh\nprintf '%s\\n' 999999\n");
    chmodSync(fakeStat, 0o755);

    const result = runControlPlane(fixture, "install", { AI_LEARNING_STAT_BIN: fakeStat });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Deployment directory must be owned by the current user");
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-api.service"), "utf8")).toContain("/old/node");
  });

  it("keeps only the five newest managed control-plane backups", () => {
    const fixture = makeFixture();
    const backupRoot = join(fixture.baseDir, "control-plane-backups");
    mkdirSync(backupRoot, { recursive: true });
    for (let index = 0; index < 7; index += 1) {
      const backup = join(backupRoot, `2026080${index + 1}T000000Z.fixture`);
      mkdirSync(backup);
      writeFileSync(join(backup, "ai-learning-os-api.service"), `backup ${index}`);
      const modifiedAt = new Date(Date.UTC(2026, 7, index + 1));
      utimesSync(backup, modifiedAt, modifiedAt);
    }
    const unrelated = join(backupRoot, "operator-notes");
    mkdirSync(unrelated);

    const result = runControlPlane(fixture, "install");

    expect(result.status, result.stderr).toBe(0);
    const managed = readdirSync(backupRoot).filter((entry) => /^\d{8}T\d{6}Z\./.test(entry));
    expect(managed).toHaveLength(5);
    expect(managed).not.toContain("20260801T000000Z.fixture");
    expect(managed).not.toContain("20260802T000000Z.fixture");
    expect(managed).not.toContain("20260803T000000Z.fixture");
    expect(existsSync(unrelated)).toBe(true);
  });

  it("reclaims abandoned managed unit stages while preserving symlinks and unrelated files", () => {
    const fixture = makeFixture();
    const abandoned = join(fixture.unitDir, ".ai-learning-os-api.service.next.1234");
    const unrelated = join(fixture.unitDir, ".operator.next.1234");
    const linked = join(fixture.unitDir, ".ai-learning-os-web.service.next.1234");
    writeFileSync(abandoned, "partial unit");
    writeFileSync(unrelated, "operator file");
    symlinkSync(unrelated, linked);

    const result = runControlPlane(fixture, "install");

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(abandoned)).toBe(false);
    expect(readFileSync(unrelated, "utf8")).toBe("operator file");
    expect(existsSync(linked)).toBe(true);
  });

  it("refuses a concurrent control-plane install", () => {
    const fixture = makeFixture();

    const result = runControlPlane(fixture, "install", { FAKE_FLOCK_AVAILABLE: "false" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Another control-plane operation is already running");
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-api.service"), "utf8")).toContain("/old/node");
  });

  it("reports installed unit drift without changing files", () => {
    const fixture = makeFixture();

    const result = runControlPlane(fixture, "status");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ai-learning-os-api.service: drifted");
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-api.service"), "utf8")).toContain("/old/node");
  });

  it("accepts systemd home placeholders for the selected runtime", () => {
    const fixture = makeFixture();
    const fakeHome = dirname(process.execPath);
    const placeholderNode = `%h/${process.execPath.slice(fakeHome.length + 1)}`;
    for (const unit of ["ai-learning-os-api.service", "ai-learning-os-web.service"]) {
      writeFileSync(join(fixture.sourceDir, unit), unitContents(placeholderNode));
      writeFileSync(join(fixture.unitDir, unit), unitContents(placeholderNode));
    }

    const result = runControlPlane(fixture, "status", { HOME: fakeHome });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("selected runtime");
  });

  it("rejects source units missing a required sandbox directive", () => {
    const fixture = makeFixture();
    const apiUnit = join(fixture.sourceDir, "ai-learning-os-api.service");
    writeFileSync(apiUnit, readFileSync(apiUnit, "utf8").replace("NoNewPrivileges=true\n", ""));

    const result = runControlPlane(fixture, "install");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "ai-learning-os-api.service is missing required sandbox directive: NoNewPrivileges=true",
    );
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-api.service"), "utf8")).toContain("/old/node");
  });

  it("restores prior units when post-install verification fails", () => {
    const fixture = makeFixture();

    const result = runControlPlane(fixture, "install", { FAKE_ACTIVE: "false" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("restoring");
    for (const unit of ["ai-learning-os-api.service", "ai-learning-os-web.service"]) {
      const installed = join(fixture.unitDir, unit);
      expect(existsSync(installed)).toBe(true);
      expect(readFileSync(installed, "utf8")).toBe("[Service]\nExecStart=/old/node app.js\n");
    }
  });
});
