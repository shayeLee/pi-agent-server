import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "compaction.spec.ts", workers: 1,
  outputDir: "test-results/compaction-isolated",
  use: { baseURL: "http://127.0.0.1:5299", browserName: "chromium", launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: {
    command: "volta run pnpm exec vite --config vite.compaction.config.ts --port 5299 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5299/visual-fixtures/compaction.html", reuseExistingServer: false,
  },
});
