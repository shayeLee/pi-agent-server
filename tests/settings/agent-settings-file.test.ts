import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSettingsError, AgentSettingsFile, parseAgentSettings } from "../../src/settings/agent-settings-file.js";

const files: AgentSettingsFile[] = [];

function setup(content?: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-agent-settings-"));
  const settingsPath = path.join(dir, "agent", "settings.json");
  if (content !== undefined) {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  const warn = vi.fn();
  const file = new AgentSettingsFile(settingsPath, { warn, pollMs: 10 });
  files.push(file);
  const read = () => JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  /** 写入并把修改时间往后挪，同一毫秒内的两次写入也能被看出来。 */
  const writeExternally = (value: unknown) => {
    writeFileSync(settingsPath, JSON.stringify(value, null, 2));
    const later = new Date(statSync(settingsPath).mtimeMs + 5000);
    utimesSync(settingsPath, later, later);
  };
  return { file, settingsPath, read, writeExternally, warn };
}

afterEach(() => {
  for (const file of files.splice(0)) file.close();
});

describe("parseAgentSettings", () => {
  it("uses Pi's defaults for fields the file leaves out and passes on only fields it has", () => {
    expect(parseAgentSettings({ theme: "dark" })).toEqual({
      values: { autoCompaction: true, autoRetry: true, maxRetries: 3, modelThinkingLevels: {} }, piSettings: {}, problems: [],
    });
    expect(parseAgentSettings({ compaction: { enabled: false, reserveTokens: 1 }, retry: { maxRetries: 0 }, modelThinkingLevels: { "openrouter/openai/gpt-6": "low" } })).toEqual({
      values: { autoCompaction: false, autoRetry: true, maxRetries: 0, modelThinkingLevels: { "openrouter/openai/gpt-6": "low" } },
      piSettings: { compaction: { enabled: false, reserveTokens: 1 }, retry: { maxRetries: 0 }, modelThinkingLevels: { "openrouter/openai/gpt-6": "low" } },
      problems: [],
    });
  });

  it("passes compaction thresholds and per-model overrides through like the CLI", () => {
    const parsed = parseAgentSettings({ compaction: {
      reserveTokens: 65536, keepRecentTokens: -1,
      modelOverrides: { "a/b": { keepRecentTokens: 8000, reserveTokens: "big" }, "c/d": { other: 1 }, nomodel: { reserveTokens: 1 } },
    } });
    expect(parsed.values.autoCompaction).toBe(true);
    expect(parsed.piSettings).toEqual({ compaction: { reserveTokens: 65536, modelOverrides: { "a/b": { keepRecentTokens: 8000 } } } });
    expect(parsed.problems).toEqual([
      "compaction.keepRecentTokens 不是非负整数",
      'compaction.modelOverrides["a/b"].reserveTokens 不是非负整数',
      'compaction.modelOverrides["nomodel"] 不是有效的模型设置',
    ]);
  });

  it("treats wrongly typed fields as left out and says which", () => {
    const parsed = parseAgentSettings({ compaction: { enabled: "no" }, retry: { maxRetries: 99 }, modelThinkingLevels: { "a/b": "extreme", nomodel: "low", "c/d": "high" } });
    expect(parsed.values).toEqual({ autoCompaction: true, autoRetry: true, maxRetries: 3, modelThinkingLevels: { "c/d": "high" } });
    expect(parsed.piSettings).toEqual({ modelThinkingLevels: { "c/d": "high" } });
    expect(parsed.problems).toHaveLength(4);
  });
});

describe("AgentSettingsFile", () => {
  it("creates the file on first save and keeps Pi's other fields on later saves", async () => {
    const { file, settingsPath, read, writeExternally } = setup();
    expect(file.view(true)).toMatchObject({ canEdit: true, values: { autoCompaction: true }, file: { path: settingsPath, hash: "absent" } });
    await file.update("absent", { autoCompaction: false, maxRetries: 5 });
    expect(read()).toEqual({ compaction: { enabled: false }, retry: { maxRetries: 5 } });
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);

    writeExternally({ ...read(), compaction: { enabled: false, reserveTokens: 65536 }, theme: "light", retry: { maxRetries: 5, baseDelayMs: 100 }, modelThinkingLevels: { "a/b": "low" } });
    await file.update(file.view(true).file!.hash, { autoRetry: false, modelThinkingLevels: {} });
    expect(read()).toEqual({ compaction: { enabled: false, reserveTokens: 65536 }, retry: { maxRetries: 5, baseDelayMs: 100, enabled: false }, theme: "light" });
    expect(file.values).toEqual({ autoCompaction: false, autoRetry: false, maxRetries: 5, modelThinkingLevels: {} });
  });

  it("refuses to overwrite a file changed since its hash was read", async () => {
    const { file, read, writeExternally } = setup({ theme: "dark" });
    const hash = file.view(true).file!.hash;
    writeExternally({ theme: "light" });
    await expect(file.update(hash, { autoCompaction: false })).rejects.toMatchObject({ code: "conflict" });
    expect(read()).toEqual({ theme: "light" });
  });

  it("rejects invalid values and a broken file, keeping the values read before", async () => {
    const { file, settingsPath, writeExternally, warn } = setup({ compaction: { enabled: false } });
    const hash = file.view(true).file!.hash;
    await expect(file.update(hash, { maxRetries: 11 })).rejects.toBeInstanceOf(AgentSettingsError);
    await expect(file.update(hash, { modelThinkingLevels: { nomodel: "low" } })).rejects.toMatchObject({ code: "invalid" });
    writeFileSync(settingsPath, "{ broken");
    utimesSync(settingsPath, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    expect(file.values.autoCompaction).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not valid JSON|不是有效的 JSON/));
    const view = file.view(true);
    expect(view.file!.error).toMatch(/不是有效的 JSON/);
    await expect(file.update(view.file!.hash, { autoRetry: false })).rejects.toMatchObject({ code: "invalid" });
    writeExternally({});
    expect(file.view(true).file!.error).toBeUndefined();
  });

  it("shows others the values without the file", () => {
    const { file } = setup({ retry: { enabled: false } });
    expect(file.view(false)).toEqual({
      canEdit: false, values: { autoCompaction: true, autoRetry: false, maxRetries: 3, modelThinkingLevels: {} },
      defaults: { autoCompaction: true, autoRetry: true, maxRetries: 3 },
    });
  });

  it("gives sessions a settings manager that follows the file and never writes to it", async () => {
    const { file, read, writeExternally } = setup({ theme: "dark", compaction: { enabled: false, reserveTokens: 65536, modelOverrides: { "a/b": { keepRecentTokens: 8000 } } }, modelThinkingLevels: { "a/b": "high" } });
    const { manager, release } = file.createSettingsManager();
    expect(manager.getCompactionEnabled()).toBe(false);
    expect(manager.getCompactionSettings()).toEqual({ enabled: false, reserveTokens: 65536, keepRecentTokens: 20000 });
    expect(manager.getCompactionSettings({ provider: "a", id: "b" })).toEqual({ enabled: false, reserveTokens: 65536, keepRecentTokens: 8000 });
    expect(manager.getRetrySettings()).toMatchObject({ enabled: true, maxRetries: 3 });
    expect(manager.getModelThinkingLevel("a", "b")).toBe("high");
    // Only Agent settings reach the session.
    expect(manager.getSettings()).not.toHaveProperty("theme");

    // Pi's own setters (an extension, /settings-like calls) stay in the session.
    manager.setCompactionEnabled(true);
    manager.setDefaultThinkingLevel("max");
    await manager.flush();
    expect(read()).toEqual({ theme: "dark", compaction: { enabled: false, reserveTokens: 65536, modelOverrides: { "a/b": { keepRecentTokens: 8000 } } }, modelThinkingLevels: { "a/b": "high" } });

    writeExternally({ retry: { enabled: false, maxRetries: 1 } });
    await vi.waitFor(() => expect(manager.getRetrySettings()).toMatchObject({ enabled: false, maxRetries: 1 }));
    expect(manager.getCompactionSettings()).toEqual({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
    expect(manager.getModelThinkingLevel("a", "b")).toBeUndefined();

    release();
    writeExternally({ retry: { enabled: true } });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(manager.getRetrySettings().enabled).toBe(false);
  });

  it("layers a trusted project's settings.json over the global one and follows trust changes", async () => {
    const { settingsPath, writeExternally } = setup({ compaction: { reserveTokens: 65536 }, retry: { maxRetries: 2 }, modelThinkingLevels: { "a/b": "high", "c/d": "low" } });
    const project = mkdtempSync(path.join(tmpdir(), "pi-agent-settings-project-"));
    mkdirSync(path.join(project, ".pi"));
    const projectFile = path.join(project, ".pi", "settings.json");
    writeFileSync(projectFile, JSON.stringify({ compaction: { enabled: false }, retry: { maxRetries: "many" }, modelThinkingLevels: { "a/b": "off" }, defaultModel: "x" }));
    let trusted = true;
    const warn = vi.fn();
    const file = new AgentSettingsFile(settingsPath, { warn, pollMs: 10, isProjectTrusted: cwd => cwd === project && trusted });
    files.push(file);
    const { manager } = file.createSettingsManager(project);
    expect(manager.getCompactionSettings()).toEqual({ enabled: false, reserveTokens: 65536, keepRecentTokens: 20000 });
    expect(manager.getRetrySettings()).toMatchObject({ maxRetries: 2 });
    expect(manager.getModelThinkingLevel("a", "b")).toBe("off");
    expect(manager.getModelThinkingLevel("c", "d")).toBe("low");
    expect(manager.getSettings()).not.toHaveProperty("defaultModel");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${projectFile}: retry.maxRetries`));
    // The service's own view stays global.
    expect(file.values.autoCompaction).toBe(true);
    expect(file.createSettingsManager().manager.getCompactionEnabled()).toBe(true);

    trusted = false;
    await vi.waitFor(() => expect(manager.getCompactionEnabled()).toBe(true));
    expect(manager.getModelThinkingLevel("a", "b")).toBe("high");
    trusted = true;
    await vi.waitFor(() => expect(manager.getCompactionEnabled()).toBe(false));
    writeExternally({ modelThinkingLevels: { "c/d": "xhigh" } });
    await vi.waitFor(() => expect(manager.getModelThinkingLevel("c", "d")).toBe("xhigh"));
    expect(manager.getModelThinkingLevel("a", "b")).toBe("off");
  });

  it("reads defaultProjectTrust like Pi: only always and never count", () => {
    const { file, writeExternally } = setup({ defaultProjectTrust: "always" });
    expect(file.defaultProjectTrust).toBe("always");
    writeExternally({ defaultProjectTrust: "sometimes" });
    expect(file.defaultProjectTrust).toBe("ask");
    writeExternally({ defaultProjectTrust: "never" });
    expect(file.defaultProjectTrust).toBe("never");
  });

  it("writes what Pi's own SettingsManager reads", async () => {
    const { file, settingsPath } = setup({ defaultThinkingLevel: "low" });
    await file.update(file.view(true).file!.hash, { autoCompaction: false, autoRetry: false, maxRetries: 2, modelThinkingLevels: { "a/b": "xhigh" } });
    const pi = SettingsManager.create(path.dirname(settingsPath), path.dirname(settingsPath), { projectTrusted: false });
    expect(pi.getCompactionEnabled()).toBe(false);
    expect(pi.getRetrySettings()).toMatchObject({ enabled: false, maxRetries: 2 });
    expect(pi.getModelThinkingLevel("a", "b")).toBe("xhigh");
    expect(pi.getDefaultThinkingLevel()).toBe("low");
  });
});
