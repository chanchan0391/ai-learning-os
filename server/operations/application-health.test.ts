import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const applicationHealthScript = join(repositoryRoot, "deploy/dev/application-health.sh");
const temporaryDirectories: string[] = [];
const revision = "a".repeat(40);

function executable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
  return path;
}

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeFixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ai-learning-application-health-"));
  temporaryDirectories.push(root);
  const baseDir = join(root, "managed", "service");
  const release = join(baseDir, "releases", revision);
  const current = join(baseDir, "current");
  const curlMarker = join(root, "curl-called");
  const node = executable(join(root, "node"), `#!/bin/sh
exec ${shellSingleQuote(process.execPath)} "$@"
`);
  const systemctl = executable(join(root, "systemctl"), `#!/bin/sh
set -eu
case "$*" in
  *"is-enabled"*"${"${FAKE_DISABLED_TIMER:-none}"}"*) exit 1 ;;
  *"is-failed"*"${"${FAKE_FAILED_OPERATIONAL_SERVICE:-none}"}"*) exit 0 ;;
  *"is-failed"*) exit 1 ;;
  *"${"${FAKE_INACTIVE_SERVICE:-none}"}"*) exit 1 ;;
  *) exit 0 ;;
esac
`);
  const curl = executable(join(root, "curl"), `#!/bin/sh
set -eu
touch "$FAKE_CURL_MARKER"
case "$*" in
  *"--output /dev/null"*) [ "${"${FAKE_WEB_HEALTHY:-true}"}" = true ] && printf '%s' "$*" | grep -Fq 'http://127.0.0.1:8088/' ;;
  *"/api/health"*) printf '%s\n' "${"${FAKE_HEALTH_BODY}"}" ;;
  *) exit 2 ;;
esac
`);
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "DEPLOYED_COMMIT"), `${revision}\n`);
  symlinkSync(release, current);
  return { baseDir, curl, curlMarker, node, systemctl };
}

function runHealth(fixture: ReturnType<typeof makeFixture>, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("sh", [applicationHealthScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      AI_LEARNING_DEPLOY_DIR: fixture.baseDir,
      AI_LEARNING_SYSTEMCTL_BIN: fixture.systemctl,
      AI_LEARNING_CURL_BIN: fixture.curl,
      AI_LEARNING_NODE_BIN: fixture.node,
      FAKE_CURL_MARKER: fixture.curlMarker,
      FAKE_HEALTH_BODY: JSON.stringify({
        status: "ok",
        releaseRevision: revision,
        aiEnabled: true,
        syncEnabled: true,
        dependencies: { database: "ready" },
        databasePool: { limit: 10, total: 3, idle: 2, inUse: 1, waiting: 0, saturated: false },
      }),
      ...extraEnv,
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("dev application health monitoring", () => {
  it("limits systemd-mapped root deployment ancestors to the root and home paths", () => {
    const script = readFileSync(applicationHealthScript, "utf8");

    expect(script).toContain('[ "$mapped_ancestor_path" = / ] || [ "$mapped_ancestor_path" = /home ]');
    expect(script).toContain('[ -n "${INVOCATION_ID:-}" ]');
  });

  it("proves active services and schedules, Web reachability, database capacity, and the deployed revision", () => {
    const fixture = makeFixture();

    const result = runHealth(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Application healthy at revision ${revision}`);
  });

  it("fails before network probes when a required operational timer is disabled", () => {
    const fixture = makeFixture();

    const result = runHealth(fixture, { FAKE_DISABLED_TIMER: "ai-learning-os-application-monitor.timer" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ai-learning-os-application-monitor.timer is not enabled");
  });

  it("rejects a relative systemctl path before any network probe", () => {
    const fixture = makeFixture();

    const result = runHealth(fixture, { AI_LEARNING_SYSTEMCTL_BIN: "./systemctl" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("systemctl executable path must be absolute");
    expect(() => statSync(fixture.curlMarker)).toThrow();
  });

  it("rejects a user-owned systemctl resolved from PATH before any network probe", () => {
    const fixture = makeFixture();

    const result = runHealth(fixture, {
      AI_LEARNING_SYSTEMCTL_BIN: "systemctl",
      PATH: `${dirname(fixture.systemctl)}:/usr/bin:/bin`,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("systemctl resolved from PATH must be owned by root");
    expect(() => statSync(fixture.curlMarker)).toThrow();
  });

  it("rejects a symlinked systemctl executable before any network probe", () => {
    const fixture = makeFixture();
    const systemctlLink = join(dirname(fixture.systemctl), "systemctl-link");
    symlinkSync(fixture.systemctl, systemctlLink);

    const result = runHealth(fixture, { AI_LEARNING_SYSTEMCTL_BIN: systemctlLink });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("systemctl executable is missing or unsafe");
    expect(() => statSync(fixture.curlMarker)).toThrow();
  });

  it("rejects a hard-linked curl executable before any network probe", () => {
    const fixture = makeFixture();
    linkSync(fixture.curl, join(dirname(fixture.curl), "curl-shared"));

    const result = runHealth(fixture);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("curl executable must not be hard-linked");
    expect(() => statSync(fixture.curlMarker)).toThrow();
  });

  it("rejects a group-writable curl executable before any network probe", () => {
    const fixture = makeFixture();
    chmodSync(fixture.curl, 0o775);

    const result = runHealth(fixture);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("curl executable must not be group or other writable");
    expect(() => statSync(fixture.curlMarker)).toThrow();
  });

  it("rejects a user-owned curl resolved from PATH before any network probe", () => {
    const fixture = makeFixture();

    const result = runHealth(fixture, {
      AI_LEARNING_CURL_BIN: "curl",
      PATH: `${dirname(fixture.curl)}:/usr/bin:/bin`,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("curl resolved from PATH must be owned by root");
    expect(() => statSync(fixture.curlMarker)).toThrow();
  });

  it("does not execute identity or revision helpers injected through PATH", () => {
    const fixture = makeFixture();
    const helperMarker = join(dirname(fixture.curl), "path-helper-called");
    for (const helper of ["id", "cat"]) {
      executable(join(dirname(fixture.curl), helper), `#!/bin/sh\ntouch "${helperMarker}"\nexit 2\n`);
    }

    const result = runHealth(fixture, { PATH: `${dirname(fixture.curl)}:/usr/bin:/bin` });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(helperMarker)).toBe(false);
  });

  it("aggregates failed timer-triggered operational services before network probes", () => {
    const fixture = makeFixture();

    const result = runHealth(fixture, {
      FAKE_FAILED_OPERATIONAL_SERVICE: "ai-learning-os-host-capacity-monitor.service",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ai-learning-os-host-capacity-monitor.service is failed");
  });

  it("fails before network probes when an application service is inactive", () => {
    const fixture = makeFixture();

    const result = runHealth(fixture, { FAKE_INACTIVE_SERVICE: "ai-learning-os-api.service" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ai-learning-os-api.service is not active");
  });

  it("rejects an oversized deployed revision before reading it", () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.baseDir, "current", "DEPLOYED_COMMIT"), `${revision}\nextra\n`);

    const result = runHealth(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must contain exactly one full Git commit SHA");
  });

  it("rejects a hard-linked deployed revision artifact", () => {
    const fixture = makeFixture();
    const revisionFile = join(fixture.baseDir, "current", "DEPLOYED_COMMIT");
    linkSync(revisionFile, join(fixture.baseDir, "shared-revision"));

    const result = runHealth(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not be hard-linked");
  });

  it("rejects a current release that is not a deployment-managed symlink", () => {
    const fixture = makeFixture();
    const current = join(fixture.baseDir, "current");
    unlinkSync(current);
    mkdirSync(current);
    writeFileSync(join(current, "DEPLOYED_COMMIT"), `${revision}\n`);

    const result = runHealth(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be a deployment-managed symlink");
  });

  it("rejects a current release target that does not match its revision", () => {
    const fixture = makeFixture();
    const current = join(fixture.baseDir, "current");
    const unexpectedRelease = join(fixture.baseDir, "releases", "unexpected");
    mkdirSync(unexpectedRelease);
    writeFileSync(join(unexpectedRelease, "DEPLOYED_COMMIT"), `${revision}\n`);
    unlinkSync(current);
    symlinkSync(unexpectedRelease, current);

    const result = runHealth(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match the deployed revision");
  });

  it("rejects a shared-writable deployment directory before any network probe", () => {
    const fixture = makeFixture();
    chmodSync(fixture.baseDir, 0o770);

    const result = runHealth(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Deployment directory must not be group or other writable");
    expect(() => statSync(fixture.curlMarker)).toThrow();
  });

  it("rejects a shared-writable release root before any network probe", () => {
    const fixture = makeFixture();
    chmodSync(join(fixture.baseDir, "releases"), 0o770);

    const result = runHealth(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Release root must not be group or other writable");
    expect(() => statSync(fixture.curlMarker)).toThrow();
  });

  it("rejects a shared-writable active release before any network probe", () => {
    const fixture = makeFixture();
    chmodSync(join(fixture.baseDir, "releases", revision), 0o770);

    const result = runHealth(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Active release directory must not be group or other writable");
    expect(() => statSync(fixture.curlMarker)).toThrow();
  });

  it("rejects a shared-writable deployment ancestor without sticky protection", () => {
    const fixture = makeFixture();
    chmodSync(dirname(fixture.baseDir), 0o770);

    const result = runHealth(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Deployment path ancestor must not be shared writable without the sticky bit");
    expect(() => statSync(fixture.curlMarker)).toThrow();
  });

  it("rejects a deployment path that traverses a symlinked ancestor", () => {
    const fixture = makeFixture();
    const managedDirectory = dirname(fixture.baseDir);
    const linkedManagedDirectory = join(dirname(managedDirectory), "managed-link");
    symlinkSync(managedDirectory, linkedManagedDirectory);

    const result = runHealth({ ...fixture, baseDir: join(linkedManagedDirectory, "service") });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be canonical and contain no symlinked ancestors");
    expect(() => statSync(fixture.curlMarker)).toThrow();
  });

  it("rejects a health response for a different release", () => {
    const fixture = makeFixture();

    const result = runHealth(fixture, {
      FAKE_HEALTH_BODY: JSON.stringify({
        status: "ok",
        releaseRevision: "b".repeat(40),
        aiEnabled: true,
        syncEnabled: true,
        dependencies: { database: "ready" },
        databasePool: { limit: 10, total: 3, idle: 2, inUse: 1, waiting: 0, saturated: false },
      }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not prove the active release is ready");
  });

  it("rejects unavailable database readiness without printing the health body", () => {
    const fixture = makeFixture();

    const result = runHealth(fixture, {
      FAKE_HEALTH_BODY: JSON.stringify({
        status: "degraded",
        releaseRevision: revision,
        aiEnabled: true,
        syncEnabled: true,
        dependencies: { database: "unavailable" },
        databasePool: { limit: 10, total: 3, idle: 2, inUse: 1, waiting: 0, saturated: false },
        privateDetail: "must not be reflected",
      }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not prove the active release is ready");
    expect(result.stderr).not.toContain("must not be reflected");
  });

  it("rejects database pool saturation without printing the health body", () => {
    const fixture = makeFixture();

    const result = runHealth(fixture, {
      FAKE_HEALTH_BODY: JSON.stringify({
        status: "ok",
        releaseRevision: revision,
        aiEnabled: true,
        syncEnabled: true,
        dependencies: { database: "ready" },
        databasePool: {
          limit: 10, total: 10, idle: 0, inUse: 10, waiting: 2, saturated: true,
        },
        privateDetail: "must not be reflected",
      }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not prove the active release is ready");
    expect(result.stderr).not.toContain("must not be reflected");
  });
});
