import { defineConfig } from "@playwright/test";

// Isolated local mock + installed Chrome; never reuses a live web or API port.
export default defineConfig({
  testDir: "./e2e", testMatch: "rich-app.spec.ts", timeout: 30_000, workers: 1,
  use: { baseURL: "http://127.0.0.1:5226", browserName: "chromium",
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: [
    { command: "PORT=8126 MAX_SSE_PER_USER=3 MAX_SSE_GLOBAL=10 CORS_ORIGINS=http://127.0.0.1:5226 volta run npx tsx ../scripts/mock-server.ts",
      url: "http://127.0.0.1:8126/health", reuseExistingServer: false, timeout: 30_000 },
    { command: "VITE_API_TARGET=http://127.0.0.1:8126 volta run pnpm dev --port 5226 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:5226", reuseExistingServer: false, timeout: 30_000 },
  ],
});
