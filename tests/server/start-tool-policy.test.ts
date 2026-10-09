// 真实 composition root + SDK，只创建内存探针；在存储/监听前停止，不请求模型。
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const probe = vi.hoisted(() => ({
  options: {} as Record<string, unknown>,
  active: [] as string[],
  available: [] as string[],
  stop: new Error("tool-policy-probe-complete"),
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...sdk,
    createAgentSession: async (options: Parameters<typeof sdk.createAgentSession>[0]) => {
      probe.options = options as unknown as Record<string, unknown>;
      const { session } = await sdk.createAgentSession(options);
      try {
        probe.active = session.getActiveToolNames();
        probe.available = session.getActiveToolNames();
        // 白名单必须连扩展主动激活也不能绕过。
        session.setActiveToolsByName(["read", "bash", "ls", "find", "grep", "fixture_extension_tool", "fixture_plugin_tool"]);
        probe.active = session.getActiveToolNames();
      } finally {
        session.dispose();
      }
      throw probe.stop;
    },
  };
});

import { startServer } from "../../src/server/start.js";
import { makeTestIpAccess } from "../helpers/ip-access.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function inspect(tools?: string[], invalid = false): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-tool-policy-")));
  dirs.push(dir);
  const extension = join(dir, "extension.ts");
  writeFileSync(extension, `export default function (pi) {
    pi.registerTool({
      name: "fixture_extension_tool", label: "Fixture", description: "Offline fixture",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [] }),
    });
    pi.registerTool({
      name: "fixture_inactive_tool", label: "Inactive", description: "Explicitly inactive",
      defaultActive: false, parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [] }),
    });
  }`);
  probe.options = {};
  const started = startServer({
    port: 0, ipAccess: makeTestIpAccess(), cwd: dir, dataDir: dir,
    nativeSessionSourceDir: join(dir, "native-fixture"), authPath: join(dir, "auth.json"), extensionPaths: [extension], tools,
    plugins: [{
      manifest: { id: "fixture-tools", version: 1, tools: [{ name: "fixture_plugin_tool" }] },
      tools: [{
        name: "fixture_plugin_tool", label: "Fixture", description: "Offline plugin fixture",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [] }),
      } as unknown as ToolDefinition],
      register() {},
    }],
  });
  if (invalid) {
    await expect(started).rejects.toThrow("repeated modifier");
    expect(probe.options).toEqual({}); // SDK was never reached.
  } else await expect(started).rejects.toBe(probe.stop);
}

describe("startServer 工具策略 → 真实 SDK", () => {
  it("未配置允许全部：不传受限工具列表，扩展工具可见且可激活", async () => {
    await inspect();
    expect(probe.options).not.toHaveProperty("tools");
    expect(probe.options).not.toHaveProperty("noTools");
    expect(probe.available).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "fixture_extension_tool", "fixture_plugin_tool"]));
    expect(probe.available).not.toContain("fixture_inactive_tool");
    expect(probe.active).toEqual(["read", "bash", "ls", "find", "grep", "fixture_extension_tool", "fixture_plugin_tool"]);
  });

  it("显式白名单严格限制内置与扩展工具，不能主动扩大", async () => {
    await inspect(["read"]);
    expect(probe.options.tools).toEqual(["read"]);
    expect(probe.available).toEqual(["read"]);
    expect(probe.active).toEqual(["read"]);
  });

  it("扩展工具显式列入白名单才开放", async () => {
    await inspect(["fixture_extension_tool"]);
    expect(probe.available).toEqual(["fixture_extension_tool"]);
    expect(probe.active).toEqual(["fixture_extension_tool"]);
  });

  it("插件 manifest 不扩大白名单，显式列出插件工具才开放", async () => {
    await inspect(["fixture_plugin_tool"]);
    expect(probe.options.tools).toEqual(["fixture_plugin_tool"]);
    expect(probe.available).toEqual(["fixture_plugin_tool"]);
    expect(probe.active).toEqual(["fixture_plugin_tool"]);
  });

  it("modifier selection becomes a strict host allowlist including custom extension names", async () => {
    await inspect(["-bash", "+fixture_extension_tool"]);
    expect(probe.options.tools).toEqual(["read", "edit", "write", "fixture_extension_tool"]);
    expect(probe.available).toEqual(["read", "edit", "write", "fixture_extension_tool"]);
    expect(probe.active).toEqual(["read", "fixture_extension_tool"]);
  });

  it.each(["++bash", "+-read", "-+read", "--bash"])("raw %s cannot widen the startup probe", async name => {
    await inspect(["-read", "-bash", "-edit", "-write", name], true);
  });

  it("unknown legal exact names retain SDK unavailable behavior without widening", async () => {
    await inspect(["unknown_legal_name"]);
    expect(probe.options.tools).toEqual(["unknown_legal_name"]);
    expect(probe.available).toEqual([]);
    expect(probe.active).toEqual([]);
  });

  it("normal modifiers removing defaults stay disabled in the probe", async () => {
    await inspect(["+read", "-read", "-bash", "-edit", "-write"]);
    expect(probe.options.tools).toEqual([]);
    expect(probe.available).toEqual([]);
    expect(probe.active).toEqual([]);
  });

  it("显式空数组禁用全部，不当作 all", async () => {
    await inspect([]);
    expect(probe.options.noTools).toBe("all");
    expect(probe.available).toEqual([]);
    expect(probe.active).toEqual([]);
  });
});
