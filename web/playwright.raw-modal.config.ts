import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "tool-raw-modal.spec.ts", workers: 1, timeout: 30000,
  use: { baseURL: "http://127.0.0.1:5207", launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: { command: "VITE_API_TARGET=http://127.0.0.1:8107 volta run pnpm dev --port 5207 --strictPort --host 127.0.0.1", url: "http://127.0.0.1:5207", reuseExistingServer: false },
});
