import { defineConfig } from "@playwright/test";

// Read-only comparison with existing dist is opt-in; never rebuild or touch live services.
const compiledWeb = process.env.RESUME_DIAGNOSTIC_FRONTEND === "dist";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "resume-http-local.spec.ts",
  timeout: 30_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5197",
    browserName: "chromium",
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  },
  webServer: {
    command: `VITE_API_TARGET=http://127.0.0.1:8097 volta run pnpm exec vite ${compiledWeb ? "preview" : ""} --port 5197 --strictPort --host 127.0.0.1`,
    url: "http://127.0.0.1:5197",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
