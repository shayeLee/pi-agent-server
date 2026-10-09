import { defineConfig } from "@playwright/test";
import startLocal from "./playwright.start-local.config";

// Dedicated local mock/Vite ports, no live services or model calls.
export default defineConfig({
  ...startLocal,
  testMatch: "theme-toggle.spec.ts",
  outputDir: "test-results/theme-toggle",
});
