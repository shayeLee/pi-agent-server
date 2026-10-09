import { defineConfig } from "@playwright/test";
import notification from "../playwright.notification-local.config.js";

// Reuse the isolated Chrome/proxy/5249→5248 setup; no live server reuse.
export default defineConfig({
  ...notification,
  testDir: ".",
  testMatch: ["subagent-notification-http-local.spec.ts", "subagent-host-followup-http-local.spec.ts"],
  outputDir: "/tmp/subagent-host-followup/playwright-results",
});
