import { defineConfig } from "@playwright/test";
import { accountsEnv } from "./e2e/accounts.fixture";

// Accounts-mode login (docs/login-design.md §13): its own mock with test accounts, on dedicated ports.
const web = "http://127.0.0.1:5231";
const mock = "http://127.0.0.1:8131";

export default defineConfig({
  testDir: "./e2e", testMatch: "accounts-login.spec.ts", timeout: 30_000, workers: 1,
  use: { baseURL: web, browserName: "chromium", channel: "chrome" },
  webServer: [
    {
      // Short SSE recheck so an ended login reaches the open stream within the test.
      command: `PORT=8131 MOCK_AUTH_MODE=accounts MOCK_PUBLIC_URL=${web} MOCK_AUTH_RECHECK_MS=500 MOCK_ACCOUNTS='${accountsEnv()}' volta run npx tsx ../scripts/mock-server.ts`,
      url: `${mock}/health`, reuseExistingServer: false, timeout: 30_000,
    },
    {
      command: `VITE_API_TARGET=${mock} volta run pnpm dev --port 5231 --strictPort --host 127.0.0.1`,
      url: web, reuseExistingServer: false, timeout: 30_000,
    },
  ],
});
