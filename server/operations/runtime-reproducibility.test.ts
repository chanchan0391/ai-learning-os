import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repositoryRoot, path), "utf8");

describe("runtime reproducibility", () => {
  it("keeps the verified Node release aligned across executable environments", () => {
    const nodeVersion = read(".nvmrc").trim();
    const packageManifest = JSON.parse(read("package.json")) as { engines?: { node?: string } };

    expect(nodeVersion).toMatch(/^22\.\d+\.\d+$/);
    expect(packageManifest.engines?.node).toBe(`>=${nodeVersion} <23`);
    expect(read(".github/workflows/ci.yml")).toContain(`node-version: ${nodeVersion}`);

    for (const path of [
      "deploy/dev/deploy-main.sh",
      "deploy/dev/control-plane.sh",
      "deploy/dev/application-health.sh",
      "deploy/dev/ai-learning-os-api.service",
      "deploy/dev/ai-learning-os-web.service",
    ]) {
      expect(read(path), `${path} must select the verified Node release`).toContain(`/node/v${nodeVersion}/bin/node`);
    }
  });

  it("pins every container base image to an immutable sha256 manifest", () => {
    const baseImages = read("Dockerfile")
      .split("\n")
      .filter((line) => line.startsWith("FROM "));

    expect(baseImages).toHaveLength(3);
    for (const baseImage of baseImages) {
      expect(baseImage).toMatch(/^FROM [a-z0-9./:-]+@sha256:[0-9a-f]{64} AS [a-z]+$/);
    }
    expect(baseImages[0]).toContain(`node:${read(".nvmrc").trim()}-alpine@sha256:`);
    expect(baseImages[1]).toContain(`node:${read(".nvmrc").trim()}-alpine@sha256:`);
  });
});
