import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", testMatch: ["tool-readable.spec.ts", "rich-content.spec.ts"], workers: 1, timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:5196", browserName: "chromium",
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: { command: "VITE_API_TARGET=http://127.0.0.1:8096 volta run pnpm dev --port 5196 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5196", reuseExistingServer: false },
});
