import { defineConfig } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
// Run existing regressions without overwriting their earlier screenshot evidence.
const testDir = resolve("test-results/tool-list-refine-specs");
mkdirSync(testDir, {recursive: true});
for (const name of ["tool-list-refine", "rich-content", "code-block-highlight", "unified-tool-codeblock", "tool-status-hover", "collapsed-tool-live"]) {
 const source = readFileSync(resolve(`e2e/${name}.spec.ts`), "utf8");
 writeFileSync(resolve(testDir, `${name}.spec.ts`), name === "tool-list-refine" ? source : source.replaceAll('/tmp/', '/tmp/tool-list-refine/regression/').replaceAll('8098', '8097'));
}
export default defineConfig({
 testDir, outputDir: "/tmp/tool-list-refine/results", workers: 1,
 use: {baseURL: "http://127.0.0.1:5197", launchOptions: {executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}},
 webServer: {command: "VITE_API_TARGET=http://127.0.0.1:8097 volta run pnpm dev --port 5197 --strictPort --host 127.0.0.1", url: "http://127.0.0.1:5197", reuseExistingServer: false},
});
