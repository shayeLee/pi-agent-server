import { defineConfig } from "@playwright/test";

// The butler (docs/companion-butler.md §12): its own mock where 127.0.0.1 is an admin and butlers are stored.
const web = "http://127.0.0.1:5233";
const mock = "http://127.0.0.1:8133";

export default defineConfig({
  testDir: "./e2e", testMatch: "butler.spec.ts", timeout: 30_000, workers: 1,
  use: { baseURL: web, browserName: "chromium", channel: "chrome" },
  webServer: [
    { command: "PORT=8133 MOCK_BUTLER=1 volta run npx tsx ../scripts/mock-server.ts", url: `${mock}/health`, reuseExistingServer: false, timeout: 30_000 },
    { command: `VITE_API_TARGET=${mock} volta run pnpm dev --port 5233 --strictPort --host 127.0.0.1`, url: web, reuseExistingServer: false, timeout: 30_000 },
  ],
});
