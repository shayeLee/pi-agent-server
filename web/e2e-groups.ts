import { readdirSync } from "node:fs";
import { resolve } from "node:path";

// Paths are relative to e2e, including subdirectories, in stable discovery order.
export function discoverSpecs(testDir: string): string[] {
  function visit(dir: string, prefix: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const file = `${prefix}${entry.name}`;
      if (entry.isDirectory()) return visit(resolve(dir, entry.name), `${file}/`);
      return entry.isFile() && entry.name.endsWith(".spec.ts") ? [file] : [];
    });
  }
  return visit(testDir, "").sort();
}

// Playwright matches absolute paths: anchor them so a nested namesake cannot leak in.
export function specMatch(testDir: string, spec: string): RegExp {
  return new RegExp(`^${resolve(testDir, spec).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

export interface E2EGroup { name: string; config: string; specs: string[] }
export const excludedSpecs = ["long-session-performance.spec.ts", "recent-session-restore.spec.ts"];
const group = (name: string, config: string, ...specs: string[]): E2EGroup => ({
  name, config, specs: specs.map(spec => `${spec}.spec.ts`),
});
export const specialGroups: E2EGroup[] = [
  group("ui-foundation", "playwright.ui-foundation.config.ts", "ui-foundation"),
  group("workspace", "playwright.workspace.config.ts", "workspace", "theme-menu"),
  group("control-queue", "playwright.control-queue.config.ts", "control-queue"),
  group("steps", "playwright.steps.config.ts", "steps", "inspector-app"),
  group("rich", "playwright.rich-local.config.ts", "rich-app", "start-state"),
  group("scroll-follow", "playwright.scroll-follow.config.ts", "chat-scroll-follow"),
  group("collapsed-tool", "playwright.collapsed-tool.config.ts", "collapsed-tool-live"),
  group("live-output", "playwright.live-output-local.config.ts", "live-output-http-local"),
  group("native-session", "playwright.native-session-local.config.ts", "native-session-http-local"),
  group("project-discovery", "playwright.project-discovery-local.config.ts", "project-discovery-http-local"),
  group("resume", "playwright.resume-local.config.ts", "resume-http-local"),
  group("sent-images", "playwright.sent-images.config.ts", "sent-images-local", "sent-images-http-local"),
  group("session-title", "playwright.session-title.config.ts", "session-title-http-local"),
  group("steering", "playwright.steering-local.config.ts", "steering-confirmation-http-local", "steering-abort-pending"),
  group("host-followup", "e2e/host-followup.config.ts", "subagent-notification-http-local", "subagent-host-followup-http-local"),
  group("subagent-markdown", "playwright.subagent-markdown.config.ts", "subagent-markdown-default"),
  group("subagent-parallel", "playwright.subagent-parallel.config.ts", "subagent-parallel"),
  group("stats", "playwright.stats-local.config.ts", "stats-expanded"),
  group("information-layout", "playwright.information-layout.config.ts", "tool-information-layout"),
  group("tool-readable", "playwright.tool-readable.config.ts", "tool-readable"),
  group("tool-streaming", "playwright.tool-streaming.config.ts", "tool-streaming-readable"),
  group("message-cursor", "playwright.message-cursor.config.ts", "message-cursor"),
  group("accounts", "playwright.accounts.config.ts", "accounts-login"),
  group("butler", "playwright.butler.config.ts", "butler"),
];

/**
 * Specs without a dedicated group share the general mock server, one at a time (it is a shared in-memory
 * store), so they are the longest group. They are dealt round-robin over these shards, each with its own
 * mock server and ports, so the shards run side by side.
 */
export const generalShards = ["playwright.config.ts", "playwright.general-2.config.ts", "playwright.general-3.config.ts"];
export const isGeneral = (name: string) => /^general-\d+$/.test(name);

export function buildGroups(files: string[], specials = specialGroups): E2EGroup[] {
  const assigned = new Set(excludedSpecs);
  const names = new Set(generalShards.map((_, index) => `general-${index + 1}`));
  for (const entry of specials) {
    if (names.has(entry.name)) throw new Error(`Duplicate group: ${entry.name}`);
    names.add(entry.name);
    for (const spec of entry.specs) {
      if (!files.includes(spec)) throw new Error(`Missing mapped spec: ${spec}`);
      if (assigned.has(spec)) throw new Error(`Duplicate mapped spec: ${spec}`);
      assigned.add(spec);
    }
  }
  const general = files.filter(file => !assigned.has(file)).sort();
  const shards = generalShards.map((config, shard) => ({
    name: `general-${shard + 1}`, config, specs: general.filter((_, index) => index % generalShards.length === shard),
  }));
  // Playwright fails a run that finds no tests.
  return [...shards.filter(shard => shard.specs.length), ...specials];
}

// Never let a caller's rich scenario leak into the general shards, baseline discovery or other groups.
export function groupEnvironment(name: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, MOCK_SCENARIO: name === "rich" ? "rich" : "" };
}

export function findGroup(groups: E2EGroup[], name: string): E2EGroup {
  const found = groups.find(group => group.name === name);
  if (!found) throw new Error(`Unknown E2E group: ${name}`);
  return found;
}
