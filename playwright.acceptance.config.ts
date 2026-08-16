import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.AI_LEARNING_ACCEPTANCE_BASE_URL ?? "http://127.0.0.1:8088";
const listingOnly = process.argv.includes("--list");

function requireLoopbackOrigin(value: string, name: string): void {
  const url = new URL(value);
  if (url.origin !== value || url.protocol !== "http:"
    || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error(`${name} must be an exact HTTP loopback origin without credentials, path, query, or fragment.`);
  }
}

requireLoopbackOrigin(baseURL, "AI_LEARNING_ACCEPTANCE_BASE_URL");
requireLoopbackOrigin(
  process.env.AI_LEARNING_ACCEPTANCE_ISSUER_ORIGIN ?? "http://127.0.0.1:5556",
  "AI_LEARNING_ACCEPTANCE_ISSUER_ORIGIN",
);

if (!listingOnly && (!process.env.AI_LEARNING_ACCEPTANCE_EMAIL
  || !process.env.AI_LEARNING_ACCEPTANCE_PASSWORD
  || process.env.AI_LEARNING_ACCEPTANCE_DISPOSABLE_ACCOUNT !== "true")) {
  throw new Error(
    "OIDC acceptance requires runtime email/password and AI_LEARNING_ACCEPTANCE_DISPOSABLE_ACCOUNT=true for a dedicated disposable dev account.",
  );
}

export default defineConfig({
  testDir: "./tests/acceptance",
  testMatch: "**/*.acceptance.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
