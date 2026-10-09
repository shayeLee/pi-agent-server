import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "chat-scroll-follow.spec.ts", workers: 1, timeout: 40_000,
  use: { baseURL: "http://127.0.0.1:5203", browserName: "chromium",
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: { command: "VITE_API_TARGET=http://127.0.0.1:8103 volta run pnpm dev --port 5203 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5203", reuseExistingServer: false },
});
