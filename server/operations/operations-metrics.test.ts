import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const metricsScript = join(repositoryRoot, "deploy/dev/operations-metrics.sh");
const temporaryDirectories: string[] = [];

function executable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
  return path;
}

function makeFixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ai-learning-operations-metrics-"));
  temporaryDirectories.push(root);
  const baseDir = join(root, "service");
  const stateDir = join(baseDir, "operations-state");
  const flock = executable(join(root, "flock"), "#!/bin/sh\n[ \"$*\" = \"-s -w 5 8\" ]\n");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, "crash-evidence.lock"), "", { mode: 0o600 });
  return { baseDir, flock, stateDir };
}

function runExporter(fixture: ReturnType<typeof makeFixture>) {
  return spawnSync("sh", [metricsScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      AI_LEARNING_DEPLOY_DIR: fixture.baseDir,
      AI_LEARNING_FLOCK_BIN: fixture.flock,
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("dev operations metrics export", () => {
  it("exports bounded zero-valued Prometheus counters before the first crash", () => {
    const fixture = makeFixture();

    const result = runExporter(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "# HELP ai_learning_os_service_unexpected_exits_total Unexpected process exits recorded for a managed service.\n"
      + "# TYPE ai_learning_os_service_unexpected_exits_total counter\n"
      + "ai_learning_os_service_unexpected_exits_total{service=\"api\"} 0\n"
      + "ai_learning_os_service_unexpected_exits_total{service=\"web\"} 0\n"
      + "# HELP ai_learning_os_service_unobserved_exits Unexpected process exits not yet observed by the application monitor.\n"
      + "# TYPE ai_learning_os_service_unobserved_exits gauge\n"
      + "ai_learning_os_service_unobserved_exits{service=\"api\"} 0\n"
      + "ai_learning_os_service_unobserved_exits{service=\"web\"} 0\n"
      + "# HELP ai_learning_os_application_monitor_last_success_unixtime Unix time of the last fully successful application health check.\n"
      + "# TYPE ai_learning_os_application_monitor_last_success_unixtime gauge\n"
      + "ai_learning_os_application_monitor_last_success_unixtime 0\n",
    );
  });

  it("exports cumulative counters without changing evidence or observation cursors", () => {
    const fixture = makeFixture();
    const apiCounter = join(fixture.stateDir, "ai-learning-os-api.service.crash-count");
    const webCounter = join(fixture.stateDir, "ai-learning-os-web.service.crash-count");
    const observed = join(fixture.stateDir, "ai-learning-os-api.service.observed-crash-count");
    writeFileSync(apiCounter, "7\n", { mode: 0o600 });
    writeFileSync(webCounter, "3\n", { mode: 0o600 });
    writeFileSync(observed, "5\n", { mode: 0o600 });
    writeFileSync(join(fixture.stateDir, "application-monitor-last-success-unixtime"), "1787587200\n", { mode: 0o600 });

    const result = runExporter(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('{service="api"} 7');
    expect(result.stdout).toContain('{service="web"} 3');
    expect(result.stdout).toContain('ai_learning_os_service_unobserved_exits{service="api"} 2');
    expect(result.stdout).toContain('ai_learning_os_service_unobserved_exits{service="web"} 3');
    expect(result.stdout).toContain("ai_learning_os_application_monitor_last_success_unixtime 1787587200");
    expect(readFileSync(apiCounter, "utf8")).toBe("7\n");
    expect(readFileSync(webCounter, "utf8")).toBe("3\n");
    expect(readFileSync(observed, "utf8")).toBe("5\n");
  });

  it("fails closed on a redirected monitor success time without emitting partial metrics", () => {
    const fixture = makeFixture();
    const outside = join(fixture.baseDir, "outside-success-time");
    writeFileSync(outside, "1787587200\n");
    symlinkSync(outside, join(fixture.stateDir, "application-monitor-last-success-unixtime"));

    const result = runExporter(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Application monitor last success time must be a regular file");
    expect(result.stdout).toBe("");
  });

  it("fails closed without partial metrics when an observation cursor exceeds recorded evidence", () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.stateDir, "ai-learning-os-api.service.crash-count"), "2\n", { mode: 0o600 });
    writeFileSync(join(fixture.stateDir, "ai-learning-os-api.service.observed-crash-count"), "3\n", { mode: 0o600 });

    const result = runExporter(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Observed crash counter exceeds recorded evidence");
    expect(result.stdout).toBe("");
  });

  it("fails closed on redirected counters without disclosing their contents", () => {
    const fixture = makeFixture();
    const outside = join(fixture.baseDir, "outside-counter");
    writeFileSync(outside, "private detail\n");
    symlinkSync(outside, join(fixture.stateDir, "ai-learning-os-api.service.crash-count"));

    const result = runExporter(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("API crash counter must be a regular file");
    expect(result.stderr).not.toContain("private detail");
    expect(result.stdout).toBe("");
  });

  it("emits no partial snapshot when shared lock acquisition times out", () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.stateDir, "ai-learning-os-api.service.crash-count"), "4\n", { mode: 0o600 });
    writeFileSync(fixture.flock, "#!/bin/sh\nexit 1\n");
    chmodSync(fixture.flock, 0o755);

    const result = runExporter(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Operations metrics lock timed out");
    expect(result.stdout).toBe("");
    expect(existsSync(join(fixture.stateDir, "ai-learning-os-api.service.observed-crash-count"))).toBe(false);
  });

  it("rejects a relative lock helper before emitting metrics", () => {
    const fixture = makeFixture();

    const result = runExporter({ ...fixture, flock: "./flock" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Operations metrics lock helper path must be absolute");
    expect(result.stdout).toBe("");
  });

  it("rejects a hard-linked lock helper before emitting metrics", () => {
    const fixture = makeFixture();
    linkSync(fixture.flock, join(dirname(fixture.flock), "shared-flock"));

    const result = runExporter(fixture);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Operations metrics lock helper ownership is unsafe");
    expect(result.stdout).toBe("");
  });

  it("rejects a lock helper in a shared writable directory before emitting metrics", () => {
    const fixture = makeFixture();
    chmodSync(dirname(fixture.flock), 0o770);

    const result = runExporter(fixture);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Operations metrics lock helper directory ownership is unsafe");
    expect(result.stdout).toBe("");
  });
});
