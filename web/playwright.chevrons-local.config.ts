import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: ["rich-content.spec.ts", "svg-tools.spec.ts", "reading-first-p2.spec.ts"], workers: 1, timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:5193", launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: [
    { command: "PORT=8093 CORS_ORIGINS=http://127.0.0.1:5193 volta run npx tsx ../scripts/mock-server.ts", url: "http://127.0.0.1:8093/health", reuseExistingServer: false },
    { command: "VITE_API_TARGET=http://127.0.0.1:8093 volta run pnpm dev --port 5193 --strictPort --host 127.0.0.1", url: "http://127.0.0.1:5193", reuseExistingServer: false },
  ],
});
