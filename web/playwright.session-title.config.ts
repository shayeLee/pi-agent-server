import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "session-title-http-local.spec.ts", workers: 1, timeout: 30000,
  outputDir: "/tmp/session-title-fallback/playwright-results",
  use: { baseURL: "http://127.0.0.1:5239", browserName: "chromium", launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: { command: "VITE_API_TARGET=http://127.0.0.1:5238 volta run pnpm dev --port 5239 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5239", reuseExistingServer: false, timeout: 30000 },
});
