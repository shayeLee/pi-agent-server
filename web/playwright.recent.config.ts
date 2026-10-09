import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "recent-session-restore.spec.ts", workers: 1, timeout: 90_000,
  outputDir: "/tmp/recent-session-restore/playwright", reporter: "list",
  use: { trace: "retain-on-failure", baseURL: "http://127.0.0.1:5279", browserName: "chromium", viewport: { width: 1280, height: 900 },
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: { command: "VITE_API_TARGET=http://127.0.0.1:5278 volta run pnpm exec vite --port 5279 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5279", reuseExistingServer: false },
});
