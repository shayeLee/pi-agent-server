import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PluginLoader } from "../../../src/application/plugins/loader.js";
import {
  BUILTIN_TOOL_NAMES,
  type PluginDispose,
  type PluginManifest,
  type PluginModeProfile,
  type PluginModule,
  type PluginRegister,
} from "../../../src/plugin/index.js";

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-plugin-loader-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 最小可用 ToolDefinition 桩：loader 只做结构校验，不执行工具。 */
function tool(name: string, description = `${name} tool`): ToolDefinition {
  return {
    name,
    label: name,
    description,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [] }),
  } as unknown as ToolDefinition;
}

function mode(id: string, overrides: Partial<PluginModeProfile> = {}): PluginModeProfile {
  return {
    id,
    modelProvider: "anthropic",
    modelId: "claude-sonnet-4",
    appendSystemPrompt: `${id} 追加提示词`,
    ...overrides,
  };
}

function pluginModule(
  id: string,
  overrides: Partial<Omit<PluginModule, "manifest">> & { manifest?: Partial<PluginManifest> } = {},
): PluginModule {
  const { manifest, ...rest } = overrides;
  return {
    manifest: { id, version: 1, tools: [], ...manifest },
    tools: [],
    ...rest,
  };
}

describe("显式插件加载器（公开插件契约）", () => {
  it("加载内联插件并规范化 manifest、工具、提示词片段与 mode profile", async () => {
    const promptFile = path.join(tempRoot(), "sample.md");
    writeFileSync(promptFile, "仅只读查询。", "utf8");
    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });
    const expectedModes = [mode("chat"), mode("explain", { thinkingLevel: "high" })];
    const module: PluginModule = {
      manifest: {
        id: "sample-plugin",
        version: 2,
        name: "sample-plugin 知识库",
        tools: [{ name: "catalog-query", description: "组件索引查询" }],
        promptFragments: [{ inline: "仅只读查询。" }, { file: promptFile }],
        modes: expectedModes,
      },
      tools: [tool("catalog-query", "组件索引查询")],
    };

    const loaded = await loader.load(module);

    expect(loaded.manifest).toEqual({
      id: "sample-plugin",
      version: 2,
      name: "sample-plugin 知识库",
      tools: [{ name: "catalog-query", description: "组件索引查询" }],
      promptFragments: [{ inline: "仅只读查询。" }, { file: promptFile }],
      modes: expectedModes,
    });
    expect(loaded.tools.map((entry) => entry.name)).toEqual(["catalog-query"]);
    expect(loaded.promptFragments).toEqual([
      { inline: "仅只读查询。" },
      { file: promptFile },
    ]);
    expect(loaded.modes).toEqual(expectedModes);
    expect(loaded.plugin).toBe(module);
    expect(loader.loadedIds()).toEqual(["sample-plugin"]);
  });

  it("loader 只加载/校验，绝不调用 register / dispose，并保留原始插件模块", async () => {
    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });
    const register = vi.fn<PluginRegister>();
    const dispose = vi.fn<PluginDispose>();
    const module = pluginModule("p", { register, dispose });

    const loaded = await loader.load(module);

    expect(register).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(loaded.plugin).toBe(module);
    expect(loaded.plugin.register).toBe(register);
    expect(loaded.plugin.dispose).toBe(dispose);
  });

  it("module.modes 覆盖 manifest.modes", async () => {
    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });
    const module = pluginModule("p", {
      manifest: { modes: [mode("manifest-mode")] },
      modes: [mode("module-mode")],
    });

    const loaded = await loader.load(module);

    expect(loaded.modes.map((entry) => entry.id)).toEqual(["module-mode"]);
  });

  it("校验 mode id 非空且唯一", async () => {
    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });

    const duplicate = pluginModule("p", { manifest: { modes: [mode("chat"), mode("chat")] } });
    await expect(loader.load(duplicate)).rejects.toThrow(/插件 mode id 重复: p -> chat/);

    const empty = pluginModule("q", { manifest: { modes: [mode("  ")] } });
    await expect(loader.load(empty)).rejects.toThrow(/插件 mode id 无效: q/);

    const notArray = pluginModule("r", {
      manifest: { modes: mode("chat") as unknown as readonly PluginModeProfile[] },
    });
    await expect(loader.load(notArray)).rejects.toThrow(/插件 mode 声明无效: r/);
  });

  it("校验 mode 的模型与提示词非空", async () => {
    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });

    const noProvider = pluginModule("p", {
      manifest: { modes: [mode("chat", { modelProvider: "  " })] },
    });
    await expect(loader.load(noProvider)).rejects.toThrow(/插件 mode 缺少模型供应商: p -> chat/);

    const noModel = pluginModule("q", { modes: [mode("chat", { modelId: "" })] });
    await expect(loader.load(noModel)).rejects.toThrow(/插件 mode 缺少模型 id: q -> chat/);

    const noAppend = pluginModule("r", { modes: [mode("chat", { appendSystemPrompt: " " })] });
    await expect(loader.load(noAppend)).rejects.toThrow(/插件 mode 缺少追加系统提示词: r -> chat/);

    const noOverride = pluginModule("s", {
      modes: [mode("chat", { appendSystemPrompt: undefined, systemPrompt: "" })],
    });
    await expect(loader.load(noOverride)).rejects.toThrow(/插件 mode 缺少系统提示词: s -> chat/);
  });

  it("mode 提示词 appendSystemPrompt / systemPrompt 必须二选一", async () => {
    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });

    // 两者都缺失：提示词来源不确定。
    const neither = pluginModule("p", {
      modes: [mode("chat", { appendSystemPrompt: undefined })],
    });
    await expect(loader.load(neither)).rejects.toThrow(
      /插件 mode 提示词无效（appendSystemPrompt\/systemPrompt 须二选一）: p -> chat/,
    );

    // 两者同时提供：无法确定是追加还是整体覆盖。
    const both = pluginModule("q", {
      modes: [mode("chat", { appendSystemPrompt: "追加", systemPrompt: "覆盖" })],
    });
    await expect(loader.load(both)).rejects.toThrow(
      /插件 mode 提示词无效（appendSystemPrompt\/systemPrompt 须二选一）: q -> chat/,
    );

    // 仅 appendSystemPrompt：宿主通用追加能力，规范化后只保留该字段。
    const appendOnly = await loader.load(pluginModule("r", {
      modes: [mode("chat", { appendSystemPrompt: "仅追加片段" })],
    }));
    expect(appendOnly.modes[0]).toEqual({
      id: "chat",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4",
      appendSystemPrompt: "仅追加片段",
    });
    expect("systemPrompt" in appendOnly.modes[0]!).toBe(false);

    // 仅 systemPrompt：旧的整体覆盖语义保留。
    const overrideOnly = await loader.load(pluginModule("t", {
      modes: [mode("chat", { appendSystemPrompt: undefined, systemPrompt: "整体覆盖" })],
    }));
    expect(overrideOnly.modes[0]).toEqual({
      id: "chat",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4",
      systemPrompt: "整体覆盖",
    });
    expect("appendSystemPrompt" in overrideOnly.modes[0]!).toBe(false);
  });

  it("拒绝重复插件 id", async () => {
    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });
    await loader.load(pluginModule("sample-plugin"));

    await expect(loader.load(pluginModule("sample-plugin"))).rejects.toThrow(/插件 id 重复: sample-plugin/);
  });

  it("拒绝 manifest 声明缺少工具实现", async () => {
    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });
    const module = pluginModule("p", { manifest: { tools: [{ name: "missing" }] } });

    await expect(loader.load(module)).rejects.toThrow(/工具声明缺少实现: p -> missing/);
  });

  it("拒绝未在 manifest 声明的工具实现", async () => {
    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });
    const module = pluginModule("p", { tools: [tool("extra")] });

    await expect(loader.load(module)).rejects.toThrow(/工具实现缺少 manifest 声明: p -> extra/);
  });

  it("拒绝工具声明与实现描述不一致", async () => {
    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });
    const module = pluginModule("p", {
      manifest: { tools: [{ name: "t", description: "声明描述" }] },
      tools: [tool("t", "实现描述")],
    });

    await expect(loader.load(module)).rejects.toThrow(/工具声明与实现描述不一致: p -> t/);
  });

  it("拒绝插件内工具声明重复与实现重名", async () => {
    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });
    const duplicateDeclaration = pluginModule("p", {
      manifest: { tools: [{ name: "t" }, { name: "t" }] },
      tools: [tool("t")],
    });
    await expect(loader.load(duplicateDeclaration)).rejects.toThrow(/插件工具声明重复: p -> t/);

    const duplicateImplementation = pluginModule("q", {
      manifest: { tools: [{ name: "t" }] },
      tools: [tool("t"), tool("t")],
    });
    await expect(loader.load(duplicateImplementation)).rejects.toThrow(/插件内工具名重复: q -> t/);
  });

  it("拒绝跨插件工具名冲突并指出占用者", async () => {
    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });
    const makeShared = (id: string) =>
      pluginModule(id, { manifest: { tools: [{ name: "shared" }] }, tools: [tool("shared")] });

    await loader.load(makeShared("a"));
    await expect(loader.load(makeShared("b"))).rejects.toThrow(
      /工具名冲突: shared（已被插件 a 声明）/,
    );
  });

  it("拒绝与 Pi 内置工具保留名冲突", async () => {
    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });
    const module = pluginModule("p", {
      manifest: { tools: [{ name: "read" }] },
      tools: [tool("read")],
    });

    await expect(loader.load(module)).rejects.toThrow(/工具名与内置工具保留名冲突: read/);
    expect(BUILTIN_TOOL_NAMES).toContain("powershell");
    expect(BUILTIN_TOOL_NAMES).toContain("grep");
  });

  it("校验插件标识与版本", async () => {
    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });

    await expect(loader.load(pluginModule("Bad_Id"))).rejects.toThrow(/插件 id 无效/);
    await expect(loader.load(pluginModule("p", { manifest: { version: 0 } }))).rejects.toThrow(
      /插件版本无效: p -> 0/,
    );
  });

  it("提示词片段的 inline/file 必须二选一且非空", async () => {
    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });

    const both = pluginModule("p", {
      manifest: { promptFragments: [{ inline: "文本", file: "a.md" }] },
    });
    await expect(loader.load(both)).rejects.toThrow(/插件提示词片段无效/);

    const neither = pluginModule("q", { manifest: { promptFragments: [{}] } });
    await expect(loader.load(neither)).rejects.toThrow(/插件提示词片段无效/);

    const relative = pluginModule("r", { manifest: { promptFragments: [{ file: "prompts/sample.md" }] } });
    await expect(loader.load(relative)).rejects.toThrow(/插件提示词文件必须为存在的绝对路径/);

    const missing = pluginModule("s", { manifest: { promptFragments: [{ file: "/missing/sample.md" }] } });
    await expect(loader.load(missing)).rejects.toThrow(/插件提示词文件必须为存在的绝对路径/);
  });

  it("校验失败时插件不注册，可重新加载", async () => {
    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });
    const invalid = pluginModule("p", { manifest: { modes: [mode("chat", { modelId: "" })] } });

    await expect(loader.load(invalid)).rejects.toThrow(/插件 mode 缺少模型 id/);
    expect(loader.loadedIds()).toEqual([]);
    await expect(loader.load(pluginModule("p"))).resolves.toBeDefined();
  });

  it("加载器要求非空默认项目目录并对外暴露 projectCwd", () => {
    expect(() => new PluginLoader({ projectCwd: "  " })).toThrow(/缺少默认项目目录/);
    expect(new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" }).projectCwd).toBe(
      "/srv/sample-project/catalog-query",
    );
  });

  it("按 ESM specifier 加载默认导出插件", async () => {
    const file = path.join(tempRoot(), "default-plugin.mjs");
    writeFileSync(
      file,
      [
        "export default {",
        '  manifest: { id: "esm-plugin", version: 1,',
        '    tools: [{ name: "esm_tool", description: "esm 工具" }],',
        '    promptFragments: [{ inline: "esm 提示" }],',
        '    modes: [{ id: "chat", modelProvider: "anthropic", modelId: "claude-sonnet-4",',
        '      appendSystemPrompt: "esm 追加提示词" }] },',
        '  tools: [{ name: "esm_tool", label: "ESM Tool", description: "esm 工具",',
        '    parameters: { type: "object", properties: {} },',
        "    execute: async () => ({ content: [] }) }],",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });
    const loaded = await loader.load(pathToFileURL(file).href);

    expect(loaded.manifest.id).toBe("esm-plugin");
    expect(loaded.tools.map((entry) => entry.name)).toEqual(["esm_tool"]);
    expect(loaded.promptFragments).toEqual([{ inline: "esm 提示" }]);
    expect(loaded.modes.map((entry) => entry.id)).toEqual(["chat"]);
    expect(loaded.plugin.manifest.id).toBe("esm-plugin");
  });

  it("按 ESM specifier 加载命名导出插件", async () => {
    const file = path.join(tempRoot(), "named-plugin.mjs");
    writeFileSync(
      file,
      [
        'export const manifest = { id: "named-plugin", version: 3 };',
        "export const tools = [];",
        "",
      ].join("\n"),
      "utf8",
    );

    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });
    const loaded = await loader.load(pathToFileURL(file).href);

    expect(loaded.manifest).toEqual({ id: "named-plugin", version: 3 });
    expect(loaded.tools).toEqual([]);
    expect(loaded.promptFragments).toEqual([]);
    expect(loaded.modes).toEqual([]);
  });

  it("拒绝缺少 manifest 导出的模块与不可解析的 specifier", async () => {
    const file = path.join(tempRoot(), "not-a-plugin.mjs");
    writeFileSync(file, "export const notAPlugin = 1;\n", "utf8");

    const loader = new PluginLoader({ projectCwd: "/srv/sample-project/catalog-query" });
    await expect(loader.load(pathToFileURL(file).href)).rejects.toThrow(/插件模块缺少 manifest 导出/);
    await expect(loader.load("./pi-plugin-loader-missing.mjs")).rejects.toThrow(/插件加载失败/);
    await expect(loader.load("   ")).rejects.toThrow(/插件 specifier 不能为空/);
  });
});
