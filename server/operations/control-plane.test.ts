import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
const monitorSandboxDirectives = sandboxDirectives.map((directive) =>
  directive.startsWith("RestrictAddressFamilies=") ? "RestrictAddressFamilies=AF_UNIX" : directive,
);

function unitContents(execStart: string) {
  return `[Service]\nExecStart=${execStart} app.js\n${sandboxDirectives.join("\n")}\n`;
}

function backupServiceContents() {
  return `[Unit]\nOnSuccess=ai-learning-os-backup-monitor.service\nOnFailure=ai-learning-os-backup-monitor.service\n[Service]\nType=oneshot\nExecStart=%h/services/ai-learning-os/backup.sh\nReadWritePaths=-%h/backups/ai-learning-os\n${sandboxDirectives.join("\n")}\n`;
}

function backupTimerContents() {
  return `[Timer]\nOnCalendar=*-*-* 03:00:00 UTC\nRandomizedDelaySec=30m\nPersistent=true\nUnit=ai-learning-os-backup.service\n[Install]\nWantedBy=timers.target\n`;
}

function backupMonitorServiceContents() {
  return `[Service]\nType=oneshot\nExecStart=%h/services/ai-learning-os/backup-health.sh\n${monitorSandboxDirectives.join("\n")}\n`;
}

function backupMonitorTimerContents() {
  return `[Timer]\nOnBootSec=5m\nOnUnitActiveSec=15m\nUnit=ai-learning-os-backup-monitor.service\n[Install]\nWantedBy=timers.target\n`;
}

function applicationMonitorServiceContents() {
  return `[Unit]\nAfter=ai-learning-os-api.service ai-learning-os-web.service\n[Service]\nType=oneshot\nExecStart=%h/services/ai-learning-os/application-health.sh\n${sandboxDirectives.join("\n")}\n`;
}

function applicationMonitorTimerContents() {
  return `[Timer]\nOnBootSec=2m\nOnUnitActiveSec=5m\nUnit=ai-learning-os-application-monitor.service\n[Install]\nWantedBy=timers.target\n`;
}

function restoreDrillServiceContents() {
  return `[Unit]\nAfter=ai-learning-os-backup.service\n[Service]\nType=oneshot\nExecStart=%h/services/ai-learning-os/restore-drill.sh\nTimeoutStartSec=15m\n${monitorSandboxDirectives.join("\n")}\n`;
}

function restoreDrillTimerContents() {
  return `[Timer]\nOnCalendar=Sun *-*-* 04:00:00 UTC\nRandomizedDelaySec=2h\nPersistent=true\nUnit=ai-learning-os-restore-drill.service\n[Install]\nWantedBy=timers.target\n`;
}

function capacityMonitorServiceContents() {
  return `[Service]\nType=oneshot\nExecStart=%h/services/ai-learning-os/host-capacity.sh\n${monitorSandboxDirectives.join("\n")}\n`;
}

function capacityMonitorTimerContents() {
  return `[Timer]\nOnBootSec=5m\nOnUnitActiveSec=15m\nUnit=ai-learning-os-host-capacity-monitor.service\n[Install]\nWantedBy=timers.target\n`;
}

const managedUnits = [
  "ai-learning-os-api.service",
  "ai-learning-os-web.service",
  "ai-learning-os-backup.service",
  "ai-learning-os-backup.timer",
  "ai-learning-os-backup-monitor.service",
  "ai-learning-os-backup-monitor.timer",
  "ai-learning-os-application-monitor.service",
  "ai-learning-os-application-monitor.timer",
  "ai-learning-os-restore-drill.service",
  "ai-learning-os-restore-drill.timer",
  "ai-learning-os-host-capacity-monitor.service",
  "ai-learning-os-host-capacity-monitor.timer",
];

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
  writeFileSync(join(sourceDir, "ai-learning-os-backup.service"), backupServiceContents());
  writeFileSync(join(sourceDir, "ai-learning-os-backup.timer"), backupTimerContents());
  writeFileSync(join(sourceDir, "ai-learning-os-backup-monitor.service"), backupMonitorServiceContents());
  writeFileSync(join(sourceDir, "ai-learning-os-backup-monitor.timer"), backupMonitorTimerContents());
  writeFileSync(join(sourceDir, "ai-learning-os-application-monitor.service"), applicationMonitorServiceContents());
  writeFileSync(join(sourceDir, "ai-learning-os-application-monitor.timer"), applicationMonitorTimerContents());
  writeFileSync(join(sourceDir, "ai-learning-os-restore-drill.service"), restoreDrillServiceContents());
  writeFileSync(join(sourceDir, "ai-learning-os-restore-drill.timer"), restoreDrillTimerContents());
  writeFileSync(join(sourceDir, "ai-learning-os-host-capacity-monitor.service"), capacityMonitorServiceContents());
  writeFileSync(join(sourceDir, "ai-learning-os-host-capacity-monitor.timer"), capacityMonitorTimerContents());
  writeFileSync(join(unitDir, "ai-learning-os-backup.service"), "[Service]\nExecStart=/old/backup.sh\n");
  writeFileSync(join(unitDir, "ai-learning-os-backup.timer"), "[Timer]\nOnCalendar=weekly\n");
  writeFileSync(join(unitDir, "ai-learning-os-backup-monitor.service"), "[Service]\nExecStart=/old/monitor.sh\n");
  writeFileSync(join(unitDir, "ai-learning-os-backup-monitor.timer"), "[Timer]\nOnUnitActiveSec=weekly\n");

  writeFileSync(fakeSystemctl, `#!/bin/sh\nset -eu\nprintf '%s\\n' "$*" >> "$FAKE_SYSTEMCTL_LOG"\ncase "$*" in\n  *"reset-failed"*"application-monitor"*) exit 2 ;;\n  *" show "*) printf '%s\\n' "$FAKE_MAIN_PID" ;;\n  *" is-active "*) [ "\${FAKE_ACTIVE:-true}" = true ] ;;\n  *" is-failed "*) [ "\${FAKE_FAILED:-false}" = true ] ;;\n  *) exit 0 ;;\nesac\n`);
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

describe("dev control-plane management", { timeout: 15_000 }, () => {
  it("backs up and atomically installs verified user units", () => {
    const fixture = makeFixture();

    const result = runControlPlane(fixture, "install");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("selected runtime");
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-api.service"), "utf8")).toBe(unitContents(process.execPath));
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-web.service"), "utf8")).toBe(unitContents(process.execPath));
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-backup.service"), "utf8")).toBe(backupServiceContents());
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-backup.timer"), "utf8")).toBe(backupTimerContents());
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-backup-monitor.service"), "utf8")).toBe(backupMonitorServiceContents());
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-backup-monitor.timer"), "utf8")).toBe(backupMonitorTimerContents());
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-application-monitor.service"), "utf8")).toBe(applicationMonitorServiceContents());
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-application-monitor.timer"), "utf8")).toBe(applicationMonitorTimerContents());
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-restore-drill.service"), "utf8")).toBe(restoreDrillServiceContents());
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-restore-drill.timer"), "utf8")).toBe(restoreDrillTimerContents());
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-host-capacity-monitor.service"), "utf8")).toBe(capacityMonitorServiceContents());
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-host-capacity-monitor.timer"), "utf8")).toBe(capacityMonitorTimerContents());
    const backupRoot = join(fixture.baseDir, "control-plane-backups");
    const backups = readdirSync(backupRoot);
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(backupRoot, backups[0], "ai-learning-os-api.service"), "utf8")).toContain("/old/node");
    expect(result.stdout).toContain("ai-learning-os-backup.timer: current, enabled, active");
    expect(readFileSync(fixture.env.FAKE_SYSTEMCTL_LOG!, "utf8")).toContain(
      "enable --now ai-learning-os-backup.timer ai-learning-os-backup-monitor.timer ai-learning-os-application-monitor.timer ai-learning-os-restore-drill.timer ai-learning-os-host-capacity-monitor.timer",
    );
    expect(readFileSync(fixture.env.FAKE_SYSTEMCTL_LOG!, "utf8")).toContain(
      "reset-failed ai-learning-os-backup.service ai-learning-os-backup-monitor.service ai-learning-os-restore-drill.service",
    );
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

  it("rejects a hard-linked control-plane lock without changing the shared inode", () => {
    const fixture = makeFixture();
    mkdirSync(fixture.baseDir, { recursive: true });
    const target = join(dirname(fixture.baseDir), "operator-lock-target");
    writeFileSync(target, "preserve me", { mode: 0o640 });
    const initialMode = statSync(target).mode & 0o777;
    linkSync(target, join(fixture.baseDir, "control-plane.lock"));

    const result = runControlPlane(fixture, "install");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Control-plane lock must not be hard-linked");
    expect(readFileSync(target, "utf8")).toBe("preserve me");
    expect(statSync(target).mode & 0o777).toBe(initialMode);
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-api.service"), "utf8")).toContain("/old/node");
  });

  it("rejects hard-linked installed units without modifying their shared inode", () => {
    const fixture = makeFixture();
    const installed = join(fixture.unitDir, "ai-learning-os-api.service");
    const shared = join(dirname(fixture.baseDir), "operator-unit");
    rmSync(installed);
    writeFileSync(shared, "preserve me", { mode: 0o640 });
    const initialMode = statSync(shared).mode & 0o777;
    linkSync(shared, installed);

    const result = runControlPlane(fixture, "install");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Installed ai-learning-os-api.service must not be hard-linked");
    expect(readFileSync(shared, "utf8")).toBe("preserve me");
    expect(statSync(shared).mode & 0o777).toBe(initialMode);
  });

  it("rejects hard-linked control-plane source units", () => {
    const fixture = makeFixture();
    const source = join(fixture.sourceDir, "ai-learning-os-api.service");
    const shared = join(dirname(fixture.baseDir), "shared-source-unit");
    linkSync(source, shared);

    const result = runControlPlane(fixture, "install");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Control-plane source ai-learning-os-api.service must not be hard-linked");
    expect(readFileSync(shared, "utf8")).toBe(unitContents(process.execPath));
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-api.service"), "utf8")).toContain("/old/node");
  });

  it("rejects control-plane directories not owned by the current user", () => {
    const fixture = makeFixture();
    const fakeStat = join(dirname(fixture.baseDir), "stat");
    writeFileSync(fakeStat, "#!/bin/sh\ncase \"$2:$3\" in\n  %u:*/source/*) printf '%s\\n' \"$FAKE_CURRENT_UID\" ;;\n  %l:*/source/*) printf '%s\\n' 1 ;;\n  *) printf '%s\\n' 999999 ;;\nesac\n");
    chmodSync(fakeStat, 0o755);

    const result = runControlPlane(fixture, "install", {
      AI_LEARNING_STAT_BIN: fakeStat,
      FAKE_CURRENT_UID: String(process.getuid!()),
    });

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

  it("preserves hard-linked abandoned unit stages", () => {
    const fixture = makeFixture();
    const shared = join(dirname(fixture.baseDir), "operator-stage");
    const linked = join(fixture.unitDir, ".ai-learning-os-api.service.next.1234");
    writeFileSync(shared, "preserve me");
    linkSync(shared, linked);

    const result = runControlPlane(fixture, "install");

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(shared, "utf8")).toBe("preserve me");
    expect(readFileSync(linked, "utf8")).toBe("preserve me");
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
    writeFileSync(join(fixture.unitDir, "ai-learning-os-backup.service"), backupServiceContents());
    writeFileSync(join(fixture.unitDir, "ai-learning-os-backup.timer"), backupTimerContents());
    writeFileSync(join(fixture.unitDir, "ai-learning-os-backup-monitor.service"), backupMonitorServiceContents());
    writeFileSync(join(fixture.unitDir, "ai-learning-os-backup-monitor.timer"), backupMonitorTimerContents());
    writeFileSync(join(fixture.unitDir, "ai-learning-os-application-monitor.service"), applicationMonitorServiceContents());
    writeFileSync(join(fixture.unitDir, "ai-learning-os-application-monitor.timer"), applicationMonitorTimerContents());
    writeFileSync(join(fixture.unitDir, "ai-learning-os-restore-drill.service"), restoreDrillServiceContents());
    writeFileSync(join(fixture.unitDir, "ai-learning-os-restore-drill.timer"), restoreDrillTimerContents());
    writeFileSync(join(fixture.unitDir, "ai-learning-os-host-capacity-monitor.service"), capacityMonitorServiceContents());
    writeFileSync(join(fixture.unitDir, "ai-learning-os-host-capacity-monitor.timer"), capacityMonitorTimerContents());

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

  it("rejects a backup timer missing its persistent daily schedule", () => {
    const fixture = makeFixture();
    const timer = join(fixture.sourceDir, "ai-learning-os-backup.timer");
    writeFileSync(timer, readFileSync(timer, "utf8").replace("Persistent=true\n", ""));

    const result = runControlPlane(fixture, "install");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "ai-learning-os-backup.timer is missing required schedule directive: Persistent=true",
    );
    expect(readFileSync(join(fixture.unitDir, "ai-learning-os-backup.timer"), "utf8")).toContain("OnCalendar=weekly");
  });

  it("reports a failed backup monitor without changing installed units", () => {
    const fixture = makeFixture();
    for (const unit of managedUnits) {
      writeFileSync(join(fixture.unitDir, unit), readFileSync(join(fixture.sourceDir, unit), "utf8"));
    }

    const result = runControlPlane(fixture, "status", { FAKE_FAILED: "true" });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ai-learning-os-backup-monitor.service: failed");
  });

  it("restores prior units when post-install verification fails", () => {
    const fixture = makeFixture();

    const result = runControlPlane(fixture, "install", { FAKE_ACTIVE: "false" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("restoring");
    for (const unit of managedUnits) {
      const installed = join(fixture.unitDir, unit);
      if (unit.startsWith("ai-learning-os-application-monitor.") || unit.startsWith("ai-learning-os-restore-drill.") || unit.startsWith("ai-learning-os-host-capacity-monitor.")) {
        expect(existsSync(installed)).toBe(false);
        continue;
      }
      expect(existsSync(installed)).toBe(true);
      const expectedPriorDirective = unit === "ai-learning-os-backup.timer"
        ? "OnCalendar=weekly"
        : unit === "ai-learning-os-backup-monitor.timer"
          ? "OnUnitActiveSec=weekly"
          : "ExecStart=/old/";
      expect(readFileSync(installed, "utf8")).toContain(expectedPriorDirective);
    }
  }, 10_000);
});
