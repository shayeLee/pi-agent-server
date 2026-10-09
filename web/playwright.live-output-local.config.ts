import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "live-output-http-local.spec.ts", timeout: 45000, workers: 1, reporter: "list",
  use: { baseURL: "http://127.0.0.1:5196", browserName: "chromium", launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: { command: "VITE_API_TARGET=http://127.0.0.1:8096 volta run pnpm exec vite --port 5196 --strictPort --host 127.0.0.1", url: "http://127.0.0.1:5196", reuseExistingServer: false, timeout: 30000 },
});
