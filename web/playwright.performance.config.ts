import { defineConfig } from "@playwright/test";
const production = process.env.PERF_MODE !== "dev";
export default defineConfig({
  testDir: "./e2e", testMatch: "long-session-performance.spec.ts", workers: 1, timeout: 180_000,
  outputDir: "/tmp/web-long-session-performance/playwright",
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5219", browserName: "chromium", viewport: { width: 1440, height: 900 },
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: { command: production
    ? "volta run pnpm exec vite preview --config vite.performance.config.ts --port 5219 --strictPort --host 127.0.0.1"
    : "volta run pnpm exec vite --config vite.performance.config.ts --port 5219 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5219", reuseExistingServer: false },
});
