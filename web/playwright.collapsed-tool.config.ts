import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: ["collapsed-tool-live.spec.ts", "rich-content.spec.ts", "code-block-highlight.spec.ts", "unified-tool-codeblock.spec.ts", "tool-display-refinement.spec.ts"], workers: 1, timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:5198", browserName: "chromium", launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: { command: "VITE_API_TARGET=http://127.0.0.1:8098 volta run --node 22 pnpm dev --port 5198 --strictPort --host 127.0.0.1", url: "http://127.0.0.1:5198", reuseExistingServer: false },
});
