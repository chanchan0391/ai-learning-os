import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const crashEvidenceScript = join(repositoryRoot, "deploy/dev/crash-evidence.sh");
const temporaryDirectories: string[] = [];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-learning-crash-evidence-"));
  temporaryDirectories.push(root);
  const baseDir = join(root, "service");
  const stateDir = join(baseDir, "operations-state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return { baseDir, stateDir };
}

function runRecorder(baseDir: string, service: string, result: string) {
  return spawnSync("sh", [crashEvidenceScript, service], {
    encoding: "utf8",
    env: { ...process.env, AI_LEARNING_DEPLOY_DIR: baseDir, SERVICE_RESULT: result },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("durable dev crash evidence", () => {
  it("does not count deliberate service stops", () => {
    const fixture = makeFixture();

    const result = runRecorder(fixture.baseDir, "ai-learning-os-api.service", "success");

    expect(result.status, result.stderr).toBe(0);
    expect(() => readFileSync(join(fixture.stateDir, "ai-learning-os-api.service.crash-count"))).toThrow();
  });

  it("atomically increments a privacy-safe counter for each unexpected exit", () => {
    const fixture = makeFixture();

    expect(runRecorder(fixture.baseDir, "ai-learning-os-api.service", "signal").status).toBe(0);
    expect(runRecorder(fixture.baseDir, "ai-learning-os-api.service", "oom-kill").status).toBe(0);

    expect(readFileSync(join(fixture.stateDir, "ai-learning-os-api.service.crash-count"), "utf8")).toBe("2\n");
  });

  it("rejects unmanaged service names", () => {
    const fixture = makeFixture();

    const result = runRecorder(fixture.baseDir, "untrusted.service", "signal");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("service is not managed");
  });

  it("rejects shared-writable or redirected state before recording", () => {
    const fixture = makeFixture();
    chmodSync(fixture.stateDir, 0o770);
    const sharedResult = runRecorder(fixture.baseDir, "ai-learning-os-web.service", "exit-code");
    expect(sharedResult.status).toBe(1);
    expect(sharedResult.stderr).toContain("directory must be private");

    rmSync(fixture.stateDir, { recursive: true });
    const redirected = join(fixture.baseDir, "redirected");
    mkdirSync(redirected);
    symlinkSync(redirected, fixture.stateDir);
    const linkResult = runRecorder(fixture.baseDir, "ai-learning-os-web.service", "exit-code");
    expect(linkResult.status).toBe(1);
    expect(linkResult.stderr).toContain("directory must be a real directory");
  });

  it("rejects a symlinked counter without changing its target", () => {
    const fixture = makeFixture();
    const target = join(fixture.baseDir, "outside-counter");
    writeFileSync(target, "41\n");
    symlinkSync(target, join(fixture.stateDir, "ai-learning-os-web.service.crash-count"));

    const result = runRecorder(fixture.baseDir, "ai-learning-os-web.service", "exit-code");

    expect(result.status).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("41\n");
  });

  it("rejects a non-private or oversized counter", () => {
    const fixture = makeFixture();
    const counter = join(fixture.stateDir, "ai-learning-os-api.service.crash-count");
    writeFileSync(counter, "1\n");
    chmodSync(counter, 0o644);
    expect(runRecorder(fixture.baseDir, "ai-learning-os-api.service", "signal").status).toBe(1);

    chmodSync(counter, 0o600);
    writeFileSync(counter, "1".repeat(18), { mode: 0o600 });
    const oversizedResult = runRecorder(fixture.baseDir, "ai-learning-os-api.service", "signal");
    expect(oversizedResult.status).toBe(1);
    expect(oversizedResult.stderr).toContain("counter is invalid");
  });
});
