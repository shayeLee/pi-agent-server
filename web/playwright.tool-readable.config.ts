import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", testMatch: ["tool-readable.spec.ts", "rich-content.spec.ts"], workers: 1, timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:5222", browserName: "chromium",
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: { command: "VITE_API_TARGET=http://127.0.0.1:8122 volta run pnpm dev --port 5222 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5222", reuseExistingServer: false },
});
