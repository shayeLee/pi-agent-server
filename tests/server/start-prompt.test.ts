// Real composition root and SDK, temporary SQLite/auth paths; buildApp is stopped before listen.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PiAgentSessionFactoryOptions, PiSessionResourceLoader } from "../../src/agent/pi-agent-session-factory.js";
import type { ServerDeps } from "../../src/server/app.js";

const probe = vi.hoisted(() => ({
  app: undefined as ServerDeps | undefined,
  factory: undefined as PiAgentSessionFactoryOptions | undefined,
  stop: new Error("prompt-probe-stop"),
}));
vi.mock("../../src/server/app.js", () => ({ buildApp: (options: ServerDeps) => { probe.app = options; throw probe.stop; } }));
vi.mock("../../src/agent/pi-agent-session-factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agent/pi-agent-session-factory.js")>();
  return { ...actual, PiAgentSessionFactory: class extends actual.PiAgentSessionFactory {
    constructor(options: PiAgentSessionFactoryOptions) { super(options); probe.factory = options; }
  } };
});
import { startServer, type StartConfig } from "../../src/server/start.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { makeTestIpAccess } from "../helpers/ip-access.js";
import { frozenPromptBase } from "../../src/server/frozen-system-prompt.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function inspect(config: Pick<StartConfig, "systemPrompt" | "appendSystemPrompt" | "appendSystemPromptFile"> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-prompt-test-")));
  dirs.push(dir);
  const project = join(dir, "project");
  const agentDir = join(dir, "agent");
  for (const root of [dir, project]) {
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "APPEND_SYSTEM.md"), "MUST_NOT_DISCOVER_PROJECT");
  }
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "MUST_NOT_DISCOVER_AGENT");
  const dbPath = join(dir, "server.db");
  const db = new DatabaseSync(dbPath);
  try { await runSqliteMigrations(db); } finally { db.close(); }
  await expect(startServer({
    port: 0, ipAccess: makeTestIpAccess(), cwd: dir, dataDir: dir, agentDir,
    dbPath, nativeSessionSourceDir: join(dir, "native-fixture"), authPath: join(dir, "unused-auth.json"), ...config,
    plugins: [{
      manifest: { id: "prompt-fixture", version: 1,
        promptFragments: [{ inline: "CAPABILITY_FRAGMENT" }],
      },
      register() {},
    }],
  })).rejects.toBe(probe.stop);
  return { dir, project, app: probe.app!, factory: probe.factory! };
}

async function sessionPrompt(factory: PiAgentSessionFactoryOptions, cwd: string, frozen: string | null) {
  const { loader } = await factory.createResourceLoader({ projectId: "test-project", projectCwd: cwd, systemPrompt: frozen, mcpCredentialOwner: null }) as PiSessionResourceLoader;
  const { session } = await createAgentSession({
    cwd, resourceLoader: loader, modelRuntime: factory.modelRuntime,
    sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory(),
  });
  try { return session.systemPrompt; } finally { session.dispose(); }
}

function assertAppend(prompt: string, text: string) {
  expect(prompt).toContain(text);
  expect(prompt.split(text)).toHaveLength(2);
  expect(prompt.indexOf(text)).toBeLessThan(prompt.indexOf("CAPABILITY_FRAGMENT"));
  expect(prompt).not.toContain("MUST_NOT_DISCOVER");
}

describe("PI_APPEND_SYSTEM composition", () => {
  it.each(["absolute", "relative"])("snapshots explicit %s UTF-8 file once across projects and frozen sessions", async (kind) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-file-prompt-"));
    dirs.push(dir);
    const file = join(dir, "append.txt");
    const text = "  文件追加\n\n第二行 🌍  \n";
    writeFileSync(file, text, "utf8");
    const { app, project, factory } = await inspect({
      systemPrompt: "WHOLE_OVERRIDE", appendSystemPrompt: "LITERAL_FIRST",
      appendSystemPromptFile: kind === "absolute" ? file : relative(process.cwd(), file),
    });
    writeFileSync(file, "CHANGED_MUST_NOT_READ", "utf8");
    // A project-local file cannot change resolution of the configured relative path.
    writeFileSync(join(project, "append.txt"), "PROJECT_MUST_NOT_READ", "utf8");
    for (const prompt of [app.systemPrompt!, await app.systemPromptResolver!.resolve(project),
      await sessionPrompt(factory, project, null)]) {
      assertAppend(prompt, text);
      expect(prompt.indexOf("WHOLE_OVERRIDE")).toBeLessThan(prompt.indexOf("LITERAL_FIRST"));
      expect(prompt.indexOf("LITERAL_FIRST")).toBeLessThan(prompt.indexOf(text));
      expect(prompt).not.toContain("MUST_NOT_READ");
    }
    rmSync(file);
    const frozen = await app.systemPromptResolver!.resolve(project);
    assertAppend(await sessionPrompt(factory, project, frozen), text);
    const { loader } = await factory.createResourceLoader({ projectId: "test-project", projectCwd: project, systemPrompt: "OLD_FROZEN", mcpCredentialOwner: null }) as PiSessionResourceLoader;
    expect(loader.getSystemPrompt()).toBe("OLD_FROZEN");
    expect(loader.getAppendSystemPrompt()).toEqual([]);
  });

  it("uses file text with SDK default and never interprets that text as another path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-file-literal-"));
    dirs.push(dir);
    const target = join(dir, "target.txt");
    const file = join(dir, "append.txt");
    writeFileSync(target, "NESTED_MUST_NOT_READ", "utf8");
    writeFileSync(file, target, "utf8");
    const { app, project, factory } = await inspect({ appendSystemPromptFile: file });
    for (const prompt of [app.systemPrompt!, await app.systemPromptResolver!.resolve(project),
      await sessionPrompt(factory, project, null)]) {
      assertAppend(prompt, target);
      expect(prompt).not.toContain("NESTED_MUST_NOT_READ");
    }
  });

  it.each([undefined, "", " \n\t "])("ignores unconfigured/blank file path %j", async (file) => {
    const { app } = await inspect({ appendSystemPrompt: "LITERAL_ONLY", appendSystemPromptFile: file });
    assertAppend(app.systemPrompt!, "LITERAL_ONLY");
  });

  it.each(["", " \n\t "])("ignores empty/blank file contents %j", async (text) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-empty-prompt-"));
    dirs.push(dir);
    const file = join(dir, "append.txt");
    writeFileSync(file, text, "utf8");
    const { app } = await inspect({ appendSystemPrompt: "LITERAL_ONLY", appendSystemPromptFile: file });
    assertAppend(app.systemPrompt!, "LITERAL_ONLY");
  });

  it.each(["missing", "directory", "invalid-utf8"])("fails before resources for %s file", async (kind) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-invalid-prompt-"));
    dirs.push(dir);
    const file = kind === "directory" ? dir : join(dir, "append.txt");
    if (kind === "invalid-utf8") writeFileSync(file, Buffer.from([0x53, 0x45, 0x43, 0x52, 0x45, 0x54, 0xc3, 0x28]));
    await expect(startServer({ port: 0, ipAccess: makeTestIpAccess(), appendSystemPromptFile: file }))
      .rejects.toThrow(`PI_APPEND_SYSTEM_FILE: cannot read regular UTF-8 file: ${file}`);
  });
  it("preserves multiline raw text once with SDK default, project cwd and unfrozen sessions", async () => {
    const text = "  ENV_APPEND_FIRST\nENV_APPEND_SECOND  ";
    const { dir, project, app, factory } = await inspect({ appendSystemPrompt: text });
    const defaultPrompt = app.systemPrompt!;
    assertAppend(defaultPrompt, text);
    expect(defaultPrompt).toContain(dir);
    expect(await app.systemPromptResolver!.resolve(dir)).toBe(defaultPrompt);
    const projectPrompt = await app.systemPromptResolver!.resolve(project);
    assertAppend(projectPrompt, text);
    expect(projectPrompt).toContain(project);
    expect(await sessionPrompt(factory, project, null)).toBe(projectPrompt);
    // The frozen loader returns the snapshot minus its own cwd section, with no current append sources;
    // the SDK adds the session cwd back, so the session prompt equals the snapshot byte-for-byte.
    for (const frozen of [projectPrompt, "OLD_FROZEN_PROMPT", ""]) {
      const { loader } = await factory.createResourceLoader({ projectId: "test-project", projectCwd: project, systemPrompt: frozen, mcpCredentialOwner: null }) as PiSessionResourceLoader;
      expect(loader.getSystemPrompt()).toBe(frozenPromptBase(frozen));
      expect(loader.getAppendSystemPrompt()).toEqual([]);
    }
    expect(await sessionPrompt(factory, project, projectPrompt)).toBe(projectPrompt);
    expect(await sessionPrompt(factory, project, "OLD_FROZEN_PROMPT")).not.toContain(text);
  });

  it("coexists with whole prompt override before capability fragments", async () => {
    const text = "ENV_APPEND_OVERRIDE";
    const { app, project, factory } = await inspect({ systemPrompt: "WHOLE_OVERRIDE", appendSystemPrompt: text });
    assertAppend(app.systemPrompt!, text);
    expect(app.systemPrompt!.indexOf("WHOLE_OVERRIDE")).toBeLessThan(app.systemPrompt!.indexOf(text));
    const projectPrompt = await app.systemPromptResolver!.resolve(project);
    assertAppend(projectPrompt, text);
    expect(projectPrompt).toContain("WHOLE_OVERRIDE");
    expect(projectPrompt).toContain(project);
    expect(await sessionPrompt(factory, project, null)).toBe(projectPrompt);
  });

  it.each([undefined, "", " \n\t "])("ignores unset/empty/blank %j without losing capability fragments", async (text) => {
    const { app, project, factory } = await inspect({ systemPrompt: "WHOLE_OVERRIDE", appendSystemPrompt: text });
    expect(app.systemPrompt).toContain("WHOLE_OVERRIDE");
    expect(app.systemPrompt).toContain("<addendum>\nCAPABILITY_FRAGMENT\n</addendum>");
    expect(app.systemPrompt).not.toContain("MUST_NOT_DISCOVER");
    const prompt = await sessionPrompt(factory, project, null);
    expect(prompt).toContain("WHOLE_OVERRIDE");
    expect(prompt).toContain("<addendum>\nCAPABILITY_FRAGMENT\n</addendum>");
    expect(prompt).not.toContain("MUST_NOT_DISCOVER");
  });

  it("treats an existing file path as literal text, not file contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-literal-prompt-"));
    dirs.push(dir);
    const file = join(dir, "literal.txt");
    writeFileSync(file, "MUST_NOT_READ_FILE");
    const { app } = await inspect({ appendSystemPrompt: file });
    assertAppend(app.systemPrompt!, file);
    expect(app.systemPrompt).not.toContain("MUST_NOT_READ_FILE");
  });
});
