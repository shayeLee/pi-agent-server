import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", testMatch: ["sent-images-local.spec.ts", "sent-images-http-local.spec.ts"], workers: 1, timeout: 30000,
  outputDir: "/tmp/sent-image-fix/playwright-results",
  use: { baseURL: "http://127.0.0.1:5209", browserName: "chromium",
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: {
    command: "VITE_API_TARGET=http://127.0.0.1:5208 volta run pnpm dev --port 5209 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5209", reuseExistingServer: false, timeout: 30000,
  },
});
