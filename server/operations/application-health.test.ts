import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-learning-application-health-"));
  temporaryDirectories.push(root);
  const baseDir = join(root, "service");
  const current = join(baseDir, "current");
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
case "$*" in
  *"--output /dev/null"*) [ "${"${FAKE_WEB_HEALTHY:-true}"}" = true ] && printf '%s' "$*" | grep -Fq 'http://127.0.0.1:8088/' ;;
  *"/api/health"*) printf '%s\n' "${"${FAKE_HEALTH_BODY}"}" ;;
  *) exit 2 ;;
esac
`);
  mkdirSync(current, { recursive: true });
  writeFileSync(join(current, "DEPLOYED_COMMIT"), `${revision}\n`);
  return { baseDir, curl, systemctl };
}

function runHealth(fixture: ReturnType<typeof makeFixture>, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("sh", [applicationHealthScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      AI_LEARNING_DEPLOY_DIR: fixture.baseDir,
      AI_LEARNING_SYSTEMCTL_BIN: fixture.systemctl,
      AI_LEARNING_CURL_BIN: fixture.curl,
      AI_LEARNING_NODE_BIN: process.execPath,
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
