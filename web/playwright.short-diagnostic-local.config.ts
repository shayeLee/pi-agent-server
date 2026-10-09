import { defineConfig } from "@playwright/test";

// Isolated browser diagnostic. Page routes provide every API fixture; these ports are
// dedicated to this run and deliberately do not touch the live 8080/5173 ports.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "short-conversation-diagnostic.spec.ts",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5191",
    browserName: "chromium",
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  },
  webServer: {
    command: "VITE_API_TARGET=http://127.0.0.1:8091 volta run pnpm dev --port 5191 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5191",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
