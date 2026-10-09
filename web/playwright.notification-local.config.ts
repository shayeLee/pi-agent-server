import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "subagent-notification-http-local.spec.ts", workers: 1, timeout: 40000,
  outputDir: "/tmp/subagent-notification/playwright-results",
  use: { baseURL: "http://127.0.0.1:5249", browserName: "chromium", launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: { command: "VITE_API_TARGET=http://127.0.0.1:5248 volta run --node 22.19.0 pnpm dev --port 5249 --strictPort --host 127.0.0.1", url: "http://127.0.0.1:5249", reuseExistingServer: false, timeout: 30000 },
});
