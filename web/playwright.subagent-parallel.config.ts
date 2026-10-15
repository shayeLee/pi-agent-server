import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "subagent-parallel.spec.ts", workers: 1, timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:5223", browserName: "chromium", launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: { command: "VITE_API_TARGET=http://127.0.0.1:8123 volta run pnpm dev --port 5223 --strictPort --host 127.0.0.1", url: "http://127.0.0.1:5223", reuseExistingServer: false },
});
