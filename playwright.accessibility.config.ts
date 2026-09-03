import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();

export default defineConfig({
  testDir: "./tests/accessibility",
  testMatch: "**/*.accessibility.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8088",
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  projects: [{
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      launchOptions: executablePath ? { executablePath } : undefined,
    },
  }],
  webServer: {
    command: "npm run preview -- --strictPort",
    url: "http://127.0.0.1:8088",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
