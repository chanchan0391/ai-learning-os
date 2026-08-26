import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const recorderScript = join(repositoryRoot, "deploy/dev/record-monitor-success.sh");
const temporaryDirectories: string[] = [];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-learning-monitor-success-"));
  temporaryDirectories.push(root);
  const baseDir = join(root, "service");
  const stateDir = join(baseDir, "operations-state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return { baseDir, stateDir };
}

function runRecorder(fixture: ReturnType<typeof makeFixture>, monitor: string) {
  return spawnSync("sh", [recorderScript, monitor], {
    encoding: "utf8",
    env: { ...process.env, AI_LEARNING_DEPLOY_DIR: fixture.baseDir },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("dev monitor success recording", () => {
  it.each([
    "backup-monitor",
    "restore-drill",
    "host-capacity-monitor",
  ])("atomically records a private bounded success time for %s", (monitor) => {
    const fixture = makeFixture();

    const result = runRecorder(fixture, monitor);

    expect(result.status, result.stderr).toBe(0);
    const successFile = join(fixture.stateDir, `${monitor}-last-success-unixtime`);
    expect(readFileSync(successFile, "utf8")).toMatch(/^\d+\n$/);
    expect(statSync(successFile).mode & 0o777).toBe(0o600);
  });

  it("rejects unsupported monitor names without creating state", () => {
    const fixture = makeFixture();

    const result = runRecorder(fixture, "../../operator-file");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("requires a supported monitor name");
    expect(readdirSync(fixture.stateDir)).toEqual([]);
  });

  it("rejects a redirected existing success file without changing its target", () => {
    const fixture = makeFixture();
    const outside = join(dirname(fixture.baseDir), "operator-file");
    writeFileSync(outside, "preserve me\n");
    symlinkSync(outside, join(fixture.stateDir, "backup-monitor-last-success-unixtime"));

    const result = runRecorder(fixture, "backup-monitor");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Monitor success file ownership is unsafe");
    expect(readFileSync(outside, "utf8")).toBe("preserve me\n");
  });

  it("rejects a hard-linked existing success file without changing the shared inode", () => {
    const fixture = makeFixture();
    const outside = join(dirname(fixture.baseDir), "operator-file");
    writeFileSync(outside, "preserve me\n", { mode: 0o600 });
    linkSync(outside, join(fixture.stateDir, "restore-drill-last-success-unixtime"));
    chmodSync(outside, 0o600);

    const result = runRecorder(fixture, "restore-drill");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Monitor success file ownership is unsafe");
    expect(readFileSync(outside, "utf8")).toBe("preserve me\n");
  });
});
