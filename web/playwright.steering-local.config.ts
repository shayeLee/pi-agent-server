import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: ["steering-confirmation-http-local.spec.ts", "steering-abort-pending.spec.ts", "control-queue.spec.ts"], timeout: 45000, workers: 1, reporter: "list",
  outputDir: "/tmp/steering-confirmation/playwright-results",
  use: { baseURL: "http://127.0.0.1:5269", browserName: "chromium", launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: { command: "volta run pnpm exec vite --config vite.steering-local.config.ts --port 5269 --strictPort --host 127.0.0.1", url: "http://127.0.0.1:5269", reuseExistingServer: false, timeout: 30000 },
});
