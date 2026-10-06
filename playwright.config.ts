import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: { ...devices["Desktop Chrome"], channel: "chrome", baseURL, ignoreHTTPSErrors: baseURL.startsWith("https:") },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: "node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3100",
    url: `${baseURL}/login`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
