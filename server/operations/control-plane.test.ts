import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const controlPlaneScript = join(repositoryRoot, "deploy/dev/control-plane.sh");
const temporaryDirectories: string[] = [];

interface Fixture {
  baseDir: string;
  env: NodeJS.ProcessEnv;
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
  const fakeLog = join(root, "systemctl.log");
  const pid = String(process.pid);

  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(unitDir, { recursive: true });
  mkdirSync(join(procRoot, pid), { recursive: true });
  symlinkSync(process.execPath, join(procRoot, pid, "exe"));

  for (const unit of ["ai-learning-os-api.service", "ai-learning-os-web.service"]) {
    writeFileSync(join(sourceDir, unit), `[Service]\nExecStart=${process.execPath} app.js\n`);
    writeFileSync(join(unitDir, unit), `[Service]\nExecStart=/old/node app.js\n`);
  }

  writeFileSync(fakeSystemctl, `#!/bin/sh\nset -eu\nprintf '%s\\n' "$*" >> "$FAKE_SYSTEMCTL_LOG"\ncase "$*" in\n  *" show "*) printf '%s\\n' "$FAKE_MAIN_PID" ;;\n  *" is-active "*) [ "\${FAKE_ACTIVE:-true}" = true ] ;;\n  *) exit 0 ;;\nesac\n`);
  chmodSync(fakeSystemctl, 0o755);

  return {
    baseDir,
    unitDir,
    env: {
      ...process.env,
      AI_LEARNING_DEPLOY_DIR: baseDir,
      AI_LEARNING_CONTROL_PLANE_SOURCE_DIR: sourceDir,
      AI_LEARNING_SYSTEMD_USER_DIR: unitDir,
      AI_LEARNING_NODE_BIN: process.execPath,
      AI_LEARNING_SYSTEMCTL_BIN: fakeSystemctl,
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
      expect(readFileSync(join(fixture.unitDir, unit), "utf8")).toContain(process.execPath);
    }
    const backupRoot = join(fixture.baseDir, "control-plane-backups");
    const backups = readdirSync(backupRoot);
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(backupRoot, backups[0], "ai-learning-os-api.service"), "utf8")).toContain("/old/node");
  });

  it("reports installed unit drift without changing files", () => {
    const fixture = makeFixture();

    const result = runControlPlane(fixture, "status");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ai-learning-os-api.service: drifted");
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
      expect(readFileSync(installed, "utf8")).toContain("/old/node");
    }
  });
});
