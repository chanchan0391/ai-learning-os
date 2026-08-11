import { readFileSync } from "node:fs";

const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;

export function parseReleaseRevision(value: string): string {
  const revision = value.trim();
  if (!GIT_REVISION_PATTERN.test(revision)) {
    throw new Error("DEPLOYED_COMMIT must contain one full lowercase Git commit SHA");
  }
  return revision;
}

/** Returns null for source checkouts and fails closed for malformed deployed metadata. */
export function readReleaseRevision(path = "DEPLOYED_COMMIT"): string | null {
  try {
    return parseReleaseRevision(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
