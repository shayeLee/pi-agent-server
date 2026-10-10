import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "message-cursor.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5298",
    browserName: "chromium",
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  },
  webServer: {
    command: "volta run pnpm exec vite --config vite.message-cursor.config.ts --port 5298 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5298/visual-fixtures/message-cursor.html",
    reuseExistingServer: false,
  },
});
