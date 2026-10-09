import { defineConfig } from "@playwright/test";
// Browser-fulfilled API only. No backend, database, model or live service.
export default defineConfig({
  testDir: "./e2e", testMatch: "session-list-refine.spec.ts", workers: 1,
  outputDir: "/tmp/session-list-refine/results",
  use: { baseURL: "http://127.0.0.1:5216", launchOptions: {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  } },
  webServer: { command: "VITE_API_TARGET=http://127.0.0.1:1 volta run pnpm dev --port 5216 --strictPort --host 127.0.0.1", url: "http://127.0.0.1:5216", reuseExistingServer: false },
});
