import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertFrontendBuildBudget,
  measureFrontendBuild,
  verifyFrontendBuild,
} from "./frontend-build-budget.js";

const temporaryDirectories: string[] = [];

function buildDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "ai-learning-os-build-budget-"));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, "assets"));
  writeFileSync(join(directory, "index.html"), "<main>AI Learning OS</main>");
  writeFileSync(join(directory, "assets", "app.js"), "console.log('ready')");
  writeFileSync(join(directory, "assets", "app.css"), "main { display: block; }");
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("frontend build budget", () => {
  it("measures raw and gzip bytes by asset type", () => {
    const result = verifyFrontendBuild(buildDirectory());

    expect(result.files).toBe(3);
    expect(result.html.rawBytes).toBeGreaterThan(0);
    expect(result.javascript.rawBytes).toBeGreaterThan(0);
    expect(result.css.rawBytes).toBeGreaterThan(0);
    expect(result.total.rawBytes).toBe(
      result.html.rawBytes + result.javascript.rawBytes + result.css.rawBytes,
    );
    expect(result.total.gzipBytes).toBe(
      result.html.gzipBytes + result.javascript.gzipBytes + result.css.gzipBytes,
    );
  });

  it("reports every exceeded category without exposing asset contents", () => {
    const result = measureFrontendBuild(buildDirectory());

    expect(() => assertFrontendBuildBudget(result, {
      html: { rawBytes: 1 },
      javascript: { rawBytes: 1, gzipBytes: 1 },
      css: { rawBytes: 1, gzipBytes: 1 },
      total: { rawBytes: 1, gzipBytes: 1 },
    })).toThrow(/html\.rawBytes is \d+ bytes; limit is 1 bytes[\s\S]*total\.gzipBytes/);
  });

  it("rejects incomplete or linked build output", () => {
    const missingIndex = buildDirectory();
    rmSync(join(missingIndex, "index.html"));
    expect(() => measureFrontendBuild(missingIndex)).toThrow("missing index.html");

    const linkedOutput = buildDirectory();
    symlinkSync(join(linkedOutput, "assets", "app.js"), join(linkedOutput, "linked.js"));
    expect(() => measureFrontendBuild(linkedOutput)).toThrow("must not contain symbolic links");
  });
});
