import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "project-discovery-http-local.spec.ts", workers: 1, timeout: 60000,
  outputDir: "/tmp/pi-project-discovery/playwright-results",
  use: { baseURL: "http://127.0.0.1:5261", browserName: "chromium", launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: { command: "volta run --node 22.19.0 pnpm dev --config vite.native-session-local.config.ts --port 5261 --strictPort --host 127.0.0.1", url: "http://127.0.0.1:5261", reuseExistingServer: false, timeout: 30000 },
});
