import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ProjectTrust, type DefaultProjectTrust } from "../../src/settings/project-trust.js";

function setup(defaultTrust: DefaultProjectTrust = "ask") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-project-trust-")));
  const agentDir = path.join(root, "agent");
  mkdirSync(agentDir);
  const project = (name: string) => {
    const dir = path.join(root, ...name.split("/"));
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const warn = vi.fn();
  let fallback = defaultTrust;
  const trust = new ProjectTrust(agentDir, { defaultTrust: () => fallback, warn });
  /** 写入并把修改时间往后挪，同一毫秒内的两次写入也能被看出来。 */
  const writeTrust = (content: string | Record<string, unknown>) => {
    const file = path.join(agentDir, "trust.json");
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
    const later = new Date(statSync(file).mtimeMs + 5000);
    utimesSync(file, later, later);
  };
  return { root, trust, project, writeTrust, warn, setDefault: (value: DefaultProjectTrust) => { fallback = value; } };
}

describe("ProjectTrust", () => {
  it("uses the nearest trust.json entry, like Pi", () => {
    const { trust, project, writeTrust } = setup();
    const parent = project("work");
    const child = project("work/app");
    const blocked = project("work/blocked");
    writeTrust({ [parent]: true, [blocked]: false, [project("other")]: null });
    expect(trust.isTrusted(child)).toBe(true);
    expect(trust.isTrusted(blocked)).toBe(false);
    expect(trust.isTrusted(project("other"))).toBe(false);
  });

  it("falls back to defaultProjectTrust, where only always trusts", () => {
    const { trust, project, writeTrust, setDefault } = setup("always");
    const dir = project("app");
    expect(trust.isTrusted(dir)).toBe(true);
    setDefault("ask");
    expect(trust.isTrusted(dir)).toBe(false);
    setDefault("always");
    writeTrust({ [dir]: false });
    expect(trust.isTrusted(dir)).toBe(false);
  });

  it("compares real paths, so a symlinked project shares its target's decision", () => {
    const { root, trust, project, writeTrust } = setup();
    const dir = project("real");
    const link = path.join(root, "link");
    symlinkSync(dir, link);
    writeTrust({ [dir]: true });
    expect(trust.isTrusted(link)).toBe(true);
  });

  it("follows changes to trust.json and keeps the last good decisions when it breaks", () => {
    const { trust, project, writeTrust, warn } = setup();
    const dir = project("app");
    writeTrust({ [dir]: true });
    expect(trust.isTrusted(dir)).toBe(true);
    writeTrust("{ half written");
    expect(trust.isTrusted(dir)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("is not valid JSON"));
    writeTrust({ [dir]: "yes" });
    expect(trust.isTrusted(dir)).toBe(true);
    writeTrust({});
    expect(trust.isTrusted(dir)).toBe(false);
  });
});

describe("ProjectTrust status and set", () => {
  it("says where the decision comes from and lists the files trust loads", () => {
    const { trust, project, writeTrust } = setup("always");
    const parent = project("work");
    const child = project("work/app");
    mkdirSync(path.join(child, ".pi"));
    writeFileSync(path.join(child, ".pi", "mcp.json"), "{}");
    expect(trust.status(child, false)).toMatchObject({ trusted: true, source: "default", defaultTrust: "always", canEdit: false });
    writeTrust({ [parent]: false });
    const status = trust.status(child, true);
    expect(status).toMatchObject({ trusted: false, source: "parent", entryPath: parent, canEdit: true });
    expect(status.files.filter(file => file.exists).map(file => file.name)).toEqual([".pi/mcp.json"]);
  });

  it("writes the project's own entry the way Pi does, and reads it back at once", () => {
    const { root, trust, project, writeTrust } = setup();
    const parent = project("work");
    const child = project("work/app");
    writeTrust({ [parent]: true });
    trust.set(child, false);
    expect(trust.isTrusted(child)).toBe(false);
    expect(trust.isTrusted(parent)).toBe(true);
    // Pi's format: sorted keys, two-space indent, trailing newline; Pi's own store reads it.
    expect(readFileSync(path.join(root, "agent", "trust.json"), "utf8")).toBe(`${JSON.stringify({ [parent]: true, [child]: false }, null, 2)}\n`);
    expect(new ProjectTrustStore(path.join(root, "agent")).get(child)).toBe(false);
    trust.set(child, true);
    expect(trust.status(child, true)).toMatchObject({ trusted: true, source: "project" });
  });

  it("refuses to overwrite a broken trust.json", () => {
    const { trust, project, writeTrust } = setup();
    writeTrust("{ broken");
    expect(() => trust.set(project("app"), true)).toThrow(/trust/);
  });
});
