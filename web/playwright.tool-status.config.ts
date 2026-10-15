import { defineConfig } from "@playwright/test";
import local from "./playwright.chevrons-local.config.js";
export default defineConfig(local, { testMatch: ["tool-status-hover.spec.ts"] });
