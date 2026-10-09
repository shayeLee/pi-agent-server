import { defineConfig } from "@playwright/test";

// Entire Web E2E suite against a fresh mock server and installed local Chrome.
export default defineConfig({
  testIgnore: ["**/long-session-performance.spec.ts", "**/recent-session-restore.spec.ts"],
  testDir: "./e2e", timeout: 30_000, workers: 1,
  use: { baseURL: "http://127.0.0.1:5189", browserName: "chromium",
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: [
    { command: "PORT=8089 MAX_SSE_PER_USER=2 MAX_SSE_GLOBAL=10 CORS_ORIGINS=http://127.0.0.1:5189 volta run npx tsx ../scripts/mock-server.ts",
      url: "http://127.0.0.1:8089/health", reuseExistingServer: false, timeout: 30_000 },
    { command: "VITE_API_TARGET=http://127.0.0.1:8089 volta run pnpm dev --port 5189 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:5189", reuseExistingServer: false, timeout: 30_000 },
  ],
});
