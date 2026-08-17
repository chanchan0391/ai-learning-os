import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const crashEvidenceScript = join(repositoryRoot, "deploy/dev/crash-evidence.sh");
const temporaryDirectories: string[] = [];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-learning-crash-evidence-"));
  temporaryDirectories.push(root);
  const baseDir = join(root, "service");
  const stateDir = join(baseDir, "operations-state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, "crash-evidence.lock"), "", { mode: 0o600 });
  const flock = join(root, "flock");
  writeFileSync(flock, `#!/usr/bin/python3
import fcntl
import sys
fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_UN if "-u" in sys.argv else fcntl.LOCK_EX)
`, { mode: 0o755 });
  chmodSync(flock, 0o755);
  return { baseDir, flock, stateDir };
}

function runRecorder(baseDir: string, service: string, result: string, flock?: string) {
  return spawnSync("sh", [crashEvidenceScript, service], {
    encoding: "utf8",
    env: { ...process.env, AI_LEARNING_DEPLOY_DIR: baseDir, AI_LEARNING_FLOCK_BIN: flock, SERVICE_RESULT: result },
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

    const result = runRecorder(fixture.baseDir, "ai-learning-os-api.service", "success", fixture.flock);

    expect(result.status, result.stderr).toBe(0);
    expect(() => readFileSync(join(fixture.stateDir, "ai-learning-os-api.service.crash-count"))).toThrow();
  });

  it("atomically increments a privacy-safe counter for each unexpected exit", () => {
    const fixture = makeFixture();

    expect(runRecorder(fixture.baseDir, "ai-learning-os-api.service", "signal", fixture.flock).status).toBe(0);
    expect(runRecorder(fixture.baseDir, "ai-learning-os-api.service", "oom-kill", fixture.flock).status).toBe(0);

    expect(readFileSync(join(fixture.stateDir, "ai-learning-os-api.service.crash-count"), "utf8")).toBe("2\n");
  });

  it("serializes concurrent increments without losing crash evidence", async () => {
    const fixture = makeFixture();
    const results = await Promise.all(Array.from({ length: 12 }, () => new Promise<{ code: number | null; stderr: string }>((resolveResult) => {
      const child = spawn("sh", [crashEvidenceScript, "ai-learning-os-api.service"], {
        env: {
          ...process.env,
          AI_LEARNING_DEPLOY_DIR: fixture.baseDir,
          AI_LEARNING_FLOCK_BIN: fixture.flock,
          SERVICE_RESULT: "signal",
        },
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("close", (code) => resolveResult({ code, stderr }));
    })));

    expect(results, results.map(({ stderr }) => stderr).join("\n")).toEqual(
      Array.from({ length: 12 }, () => ({ code: 0, stderr: "ai-learning-os-api.service recorded an unexpected process exit\n" })),
    );
    expect(readFileSync(join(fixture.stateDir, "ai-learning-os-api.service.crash-count"), "utf8")).toBe("12\n");
  }, 15_000);

  it("rejects unmanaged service names", () => {
    const fixture = makeFixture();

    const result = runRecorder(fixture.baseDir, "untrusted.service", "signal", fixture.flock);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("service is not managed");
  });

  it("rejects shared-writable or redirected state before recording", () => {
    const fixture = makeFixture();
    chmodSync(fixture.stateDir, 0o770);
    const sharedResult = runRecorder(fixture.baseDir, "ai-learning-os-web.service", "exit-code", fixture.flock);
    expect(sharedResult.status).toBe(1);
    expect(sharedResult.stderr).toContain("directory must be private");

    rmSync(fixture.stateDir, { recursive: true });
    const redirected = join(fixture.baseDir, "redirected");
    mkdirSync(redirected);
    symlinkSync(redirected, fixture.stateDir);
    const linkResult = runRecorder(fixture.baseDir, "ai-learning-os-web.service", "exit-code", fixture.flock);
    expect(linkResult.status).toBe(1);
    expect(linkResult.stderr).toContain("directory must be a real directory");
  });

  it("rejects a symlinked counter without changing its target", () => {
    const fixture = makeFixture();
    const target = join(fixture.baseDir, "outside-counter");
    writeFileSync(target, "41\n");
    symlinkSync(target, join(fixture.stateDir, "ai-learning-os-web.service.crash-count"));

    const result = runRecorder(fixture.baseDir, "ai-learning-os-web.service", "exit-code", fixture.flock);

    expect(result.status).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("41\n");
  });

  it("rejects a redirected lock before reading or changing counters", () => {
    const fixture = makeFixture();
    const lock = join(fixture.stateDir, "crash-evidence.lock");
    const target = join(fixture.baseDir, "outside-lock");
    rmSync(lock);
    writeFileSync(target, "preserve me");
    symlinkSync(target, lock);

    const result = runRecorder(fixture.baseDir, "ai-learning-os-api.service", "signal", fixture.flock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("lock must be a regular file");
    expect(readFileSync(target, "utf8")).toBe("preserve me");
  });

  it("preserves the existing counter when lock acquisition times out", () => {
    const fixture = makeFixture();
    const counter = join(fixture.stateDir, "ai-learning-os-api.service.crash-count");
    writeFileSync(counter, "3\n", { mode: 0o600 });
    writeFileSync(fixture.flock, "#!/bin/sh\nexit 1\n");
    chmodSync(fixture.flock, 0o755);

    const result = runRecorder(fixture.baseDir, "ai-learning-os-api.service", "signal", fixture.flock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("lock timed out");
    expect(readFileSync(counter, "utf8")).toBe("3\n");
  });

  it("rejects a non-private or oversized counter", () => {
    const fixture = makeFixture();
    const counter = join(fixture.stateDir, "ai-learning-os-api.service.crash-count");
    writeFileSync(counter, "1\n");
    chmodSync(counter, 0o644);
    expect(runRecorder(fixture.baseDir, "ai-learning-os-api.service", "signal", fixture.flock).status).toBe(1);

    chmodSync(counter, 0o600);
    writeFileSync(counter, "1".repeat(18), { mode: 0o600 });
    const oversizedResult = runRecorder(fixture.baseDir, "ai-learning-os-api.service", "signal", fixture.flock);
    expect(oversizedResult.status).toBe(1);
    expect(oversizedResult.stderr).toContain("counter is invalid");
  });
});
