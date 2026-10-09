import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "attachments-local.spec.ts",
  workers: 1,
  timeout: 30000,
  use: { baseURL: "http://127.0.0.1:5199", browserName: "chromium",
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: {
    command: "VITE_API_TARGET=http://127.0.0.1:5198 volta run pnpm dev --port 5199 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5199", reuseExistingServer: false, timeout: 30000,
  },
});
