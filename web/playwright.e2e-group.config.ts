import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import { buildGroups, discoverSpecs, excludedSpecs, findGroup, groupEnvironment, specMatch } from "./e2e-groups.js";

const web = dirname(fileURLToPath(import.meta.url));
const testDir = resolve(web, "e2e");
const groups = buildGroups(discoverSpecs(testDir));
const group = findGroup(groups, process.env.PI_E2E_GROUP ?? "general");
const scenario = groupEnvironment(process.env.PI_E2E_DISCOVERY_ALL ? "general" : group.name, process.env).MOCK_SCENARIO!;
// Test workers inherit this environment, including during --list.
process.env.MOCK_SCENARIO = scenario;
const original = (await import(pathToFileURL(resolve(web, group.config)).href)).default as PlaywrightTestConfig;
const { executablePath: _ignored, ...launchOptions } = original.use?.launchOptions ?? {};
const servers = original.webServer ? (Array.isArray(original.webServer) ? original.webServer : [original.webServer]) : [];
if (!process.env.PI_E2E_GROUP_OUTPUT) throw new Error("Use pnpm run e2e (or pnpm run e2e -- --list)");
export default defineConfig({
  ...original,
  testDir,
  testMatch: process.env.PI_E2E_DISCOVERY_ALL ? "**/*.spec.ts" : group.specs.map(spec => specMatch(testDir, spec)),
  testIgnore: process.env.PI_E2E_DISCOVERY_ALL ? excludedSpecs.map(spec => specMatch(testDir, spec)) : [],
  outputDir: resolve(process.env.PI_E2E_GROUP_OUTPUT, "artifacts"),
  reporter: [["list"], ["json", { outputFile: resolve(process.env.PI_E2E_GROUP_OUTPUT, "report.json") }]],
  use: { ...original.use, browserName: "chromium", channel: "chrome", launchOptions },
  webServer: servers.map(server => ({ ...server, env: { ...server.env, MOCK_SCENARIO: scenario },
    cwd: server.cwd ? resolve(dirname(resolve(web, group.config)), server.cwd) : web })),
});
