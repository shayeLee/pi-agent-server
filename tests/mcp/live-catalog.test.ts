import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LiveMcpCatalog } from "../../src/mcp/live-catalog.js";

describe("LiveMcpCatalog", () => {
  let root: string;
  let path: string;
  let warnings: string[];
  let tick = 0;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-live-"));
    path = join(root, "mcp.json");
    warnings = [];
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** 写文件并把修改时间往后推，保证同一毫秒里的两次写入也能被看出来。 */
  function write(content: unknown) {
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    const time = new Date(Date.now() + ++tick * 1000);
    utimesSync(path, time, time);
  }

  const live = () => new LiveMcpCatalog({ piConfigPath: path, context: { env: {}, oauthEnabled: false }, warn: message => warnings.push(message) });
  const names = (catalog: LiveMcpCatalog) => [...catalog.servers.keys()];

  it("picks up servers added after start and keeps a snapshot stable", () => {
    const catalog = live();
    expect(names(catalog)).toEqual([]);
    expect(catalog.piConfigStatus).toEqual({ path, unavailable: [] });
    write({ mcpServers: { docs: { url: "https://docs.example.com/mcp" } } });
    const snapshot = catalog.snapshot();
    expect(names(catalog)).toEqual(["docs"]);
    write({ mcpServers: {} });
    expect(names(catalog)).toEqual([]);
    expect([...snapshot.servers.keys()]).toEqual(["docs"]);
  });

  it("keeps the last good servers while the file is broken, without echoing its content", () => {
    write({ mcpServers: { docs: { url: "https://docs.example.com/mcp" } } });
    const catalog = live();
    expect(names(catalog)).toEqual(["docs"]);
    write('{"mcpServers": {"docs": {"headers": {"Authorization": "Bearer sk-secret"');
    expect(names(catalog)).toEqual(["docs"]);
    expect(catalog.piConfigStatus?.error).toBe(`${path} is not valid JSON`);
    expect(warnings.join("\n")).not.toContain("sk-secret");
    // 没改文件时不重复提示。
    const count = warnings.length;
    void catalog.servers;
    expect(warnings).toHaveLength(count);
    write({ mcpServers: { other: { command: "srv" } } });
    expect(names(catalog)).toEqual(["other"]);
    expect(catalog.piConfigStatus?.error).toBeUndefined();
  });

  it("reports unusable entries and keeps the rest", () => {
    write({ mcpServers: { secret: { command: "srv", env: { T: "!pass show t" } }, notes: { command: "srv" } } });
    const catalog = live();
    expect(names(catalog)).toEqual(["notes"]);
    expect(catalog.piConfigStatus.unavailable).toEqual([{ name: "secret", reason: expect.stringMatching(/!命令/) }]);
    expect(warnings).toHaveLength(1);
  });

  it("treats a deleted file as having no servers", () => {
    write({ mcpServers: { docs: { url: "https://docs.example.com/mcp" } } });
    const catalog = live();
    expect(names(catalog)).toEqual(["docs"]);
    rmSync(path);
    expect(names(catalog)).toEqual([]);
  });
});
