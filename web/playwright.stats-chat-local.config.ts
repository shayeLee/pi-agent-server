import { defineConfig } from "@playwright/test";
import local from "./playwright.config";
export default defineConfig({
  ...local,
  testMatch: ["chat.spec.ts", "sse.spec.ts"],
  use: { ...local.use, browserName: "chromium", launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
});
