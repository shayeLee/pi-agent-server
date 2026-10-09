// Verify the actual npm exports without installing dependencies in the consumer.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const directory = mkdtempSync(path.join(tmpdir(), "pi-client-package-"));
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function assertBoundary(files) {
  for (const file of files) {
    if (!file.includes("/package/dist/")) continue;
    if (!/\/dist\/(client|shared|public-api)\//.test(file) && !file.includes("/dist/core/usage-snapshot.")) {
      throw new Error(`client crossed public boundary: ${file}`);
    }
  }
  if (files.some(file => /node_modules\/(?:@types\/node|fastify|@earendil-works)\//.test(file))) {
    throw new Error("consumer requires server dependencies");
  }
}
try {
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--cache", path.join(directory, "npm-cache"), "--pack-destination", directory]));
  run("tar", ["-xzf", path.join(directory, packed[0].filename), "-C", directory]);
  mkdirSync(path.join(directory, "node_modules"));
  // A local package link is not a dependency install; the extracted tarball has no node_modules.
  run("ln", ["-s", "../package", path.join(directory, "node_modules/pi-agent-server")]);
  writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(path.join(directory, "consumer.ts"), `
import { ApiClient, createChatStore, SseParser } from "pi-agent-server/client";
import type { Export, ExportTimelineItem, SseEvent, ModelOutputProgress, UsageSnapshot } from "pi-agent-server/client";
import { SSE_EVENT_TYPES, TURN_ERROR_CODES } from "pi-agent-server/contract";
import type { Access, Model, Project, Session, MessageInput, SseEvent as ContractEvent } from "pi-agent-server/contract";
export type Consumer = [Export, ExportTimelineItem, ModelOutputProgress, UsageSnapshot, Access, Model, Project, Session, MessageInput];
export const assignEvent = (event: ContractEvent): SseEvent => event;
export const reverseEvent = (event: SseEvent): ContractEvent => event;
export const runtime = { ApiClient, createChatStore, SseParser, SSE_EVENT_TYPES, TURN_ERROR_CODES };
`);
  const compiler = path.join(root, "node_modules/typescript/bin/tsc");
  for (const module of ["NodeNext", "ESNext"]) {
    writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022", module, moduleResolution: module === "NodeNext" ? "NodeNext" : "Bundler",
        lib: ["ES2022", "DOM", "DOM.Iterable"], types: [], strict: true,
        skipLibCheck: false, noEmit: true,
      }, files: ["consumer.ts"],
    }));
    const files = run(process.execPath, [compiler, "-p", path.join(directory, "tsconfig.json"), "--listFiles"]).trim().split(/\r?\n/);
    assertBoundary(files);
    console.log(`packed client + contract declarations (${module}, no server dependencies): ok`);
  }
  const webRequire = createRequire(path.join(root, "web/package.json"));
  const { build } = await import(pathToFileURL(webRequire.resolve("vite")).href);
  await build({
    configFile: false, root: directory, logLevel: "error",
    plugins: [{ name: "client-boundary", generateBundle() { assertBoundary([...this.getModuleIds()]); } }],
    build: { outDir: path.join(directory, "bundle"), lib: { entry: path.join(directory, "consumer.ts"), formats: ["es"], fileName: "client" } },
  });
  const bundle = readFileSync(path.join(directory, "bundle/client.js"), "utf8");
  if (/\b(?:from|import)\s*["'](?:node:|fastify|@earendil-works)/.test(bundle)) throw new Error("server imports in browser bundle");
  await import(pathToFileURL(path.join(directory, "bundle/client.js")).href);
  console.log("packed browser bundle boundary + runtime import: ok");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
