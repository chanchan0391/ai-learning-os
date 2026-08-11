import { describe, expect, it } from "vitest";
import { parseReleaseRevision, readReleaseRevision } from "./release-provenance";

describe("release provenance", () => {
  const revision = "a".repeat(40);

  it("accepts a deployed full lowercase Git revision", () => {
    expect(parseReleaseRevision(`${revision}\n`)).toBe(revision);
  });

  it("rejects ambiguous or malformed deployed revisions", () => {
    expect(() => parseReleaseRevision("abc123")).toThrow(/full lowercase Git commit SHA/);
    expect(() => parseReleaseRevision("A".repeat(40))).toThrow(/full lowercase Git commit SHA/);
    expect(() => parseReleaseRevision(`${revision}\nsecond-line`)).toThrow(/full lowercase Git commit SHA/);
  });

  it("reports no revision for an undeployed source checkout", () => {
    expect(readReleaseRevision("definitely-missing-deployed-commit-file")).toBeNull();
  });
});
