import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "ui-foundation.spec.ts",
  timeout: 30_000,
  workers: 1,
  outputDir: "test-results/ui-foundation",
  use: {
    baseURL: "http://127.0.0.1:5190",
    browserName: "chromium",
    launchOptions: existsSync(systemChrome) ? { executablePath: systemChrome } : {},
    trace: "retain-on-failure",
  },
  // All APIs are intercepted by the test fixture; no mock/live backend is needed.
  webServer: {
    command: "VITE_API_TARGET=http://127.0.0.1:1 volta run pnpm dev --port 5190 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5190",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
