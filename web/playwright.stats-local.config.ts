import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "stats-expanded.spec.ts", workers: 1, timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:5211", browserName: "chromium",
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: { command: "VITE_API_TARGET=http://127.0.0.1:8111 volta run pnpm dev --port 5211 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5211", reuseExistingServer: false },
});
