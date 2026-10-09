import { defineConfig } from "@playwright/test";

// Isolated P2 browser verification on dedicated local ports; page routes supply all API data.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "reading-first-p2.spec.ts",
  timeout: 45_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5192",
    browserName: "chromium",
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  },
  webServer: {
    command: "VITE_API_TARGET=http://127.0.0.1:8092 volta run pnpm dev --port 5192 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5192",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
