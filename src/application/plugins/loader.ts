// 显式插件加载器（两阶段启动的第一阶段）：只按显式来源（内联模块 / ESM specifier）
// 加载并校验受信插件，不扫描用户目录或项目目录，也不产生任何副作用——
// 绝不调用插件的 register / dispose，二者由宿主在阶段二与停止时自行调用。
// 加载前严格校验 manifest、mode profile 与工具声明的一致性、重复插件 id、
// 跨插件工具名冲突以及 Pi 内置工具保留名冲突。

import { existsSync } from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  BUILTIN_TOOL_NAMES,
  PLUGIN_CAPABILITY_LIMIT,
  PLUGIN_CAPABILITY_NAME_PATTERN,
  type LoadedPlugin,
  type PluginManifest,
  type PluginModeProfile,
  type PluginModule,
  type PluginPromptFragment,
  type PluginSource,
  type PluginToolDeclaration,
} from "../../plugin/contract.js";

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BUILTIN_TOOL_NAME_SET = new Set<string>(BUILTIN_TOOL_NAMES);

/** 插件加载器选项。 */
export interface PluginLoaderOptions {
  /** 宿主默认项目目录；宿主据此取值构建 PluginHostContext.projectCwd。 */
  readonly projectCwd: string;
}


export class PluginLoader {
  /** 宿主默认项目目录；宿主在阶段二构建 PluginHostContext 时复用。 */
  readonly projectCwd: string;
  private readonly modules = new Map<string, PluginModule>();
  private readonly order: string[] = [];
  private readonly toolOwners = new Map<string, string>();

  constructor(options: PluginLoaderOptions) {
    const projectCwd = options?.projectCwd;
    if (typeof projectCwd !== "string" || projectCwd.trim() === "") {
      throw new Error("插件加载器缺少默认项目目录");
    }
    this.projectCwd = projectCwd;
  }

  /** 已加载插件 id（按加载顺序）。 */
  loadedIds(): readonly string[] {
    return [...this.order];
  }

  /**
   * 加载并校验一个插件：内联模块直接校验，字符串按 ESM specifier 动态导入。
   * 只解析与校验，不执行插件代码中的 register / dispose；校验失败时插件不会注册，
   * 已加载插件不受影响。返回的 LoadedPlugin.plugin 供宿主稍后调用生命周期钩子。
   */
  async load(source: PluginSource): Promise<LoadedPlugin> {
    const module = await this.resolveModule(source);
    const sourceLabel =
      typeof source === "string"
        ? source
        : `<inline:${typeof module.manifest?.id === "string" ? module.manifest.id : "unknown"}>`;
    const manifest = this.validateManifest(module.manifest, sourceLabel);

    if (this.modules.has(manifest.id)) {
      throw new Error(`插件 id 重复: ${manifest.id}`);
    }

    const tools = this.validateTools(module, manifest, sourceLabel);
    for (const tool of tools) {
      if (BUILTIN_TOOL_NAME_SET.has(tool.name)) {
        throw new Error(`工具名与内置工具保留名冲突: ${tool.name}`);
      }
      const owner = this.toolOwners.get(tool.name);
      if (owner !== undefined) {
        throw new Error(`工具名冲突: ${tool.name}（已被插件 ${owner} 声明）`);
      }
    }

    const modes = this.resolveModes(module, manifest);
    const capabilities = validateCapabilities(manifest.capabilities, manifest.id);

    this.modules.set(manifest.id, module);
    this.order.push(manifest.id);
    for (const tool of tools) {
      this.toolOwners.set(tool.name, manifest.id);
    }

    return {
      manifest,
      tools,
      promptFragments: [...(manifest.promptFragments ?? [])],
      modes,
      capabilities,
      plugin: module,
    };
  }

  private resolveModes(
    module: PluginModule,
    manifest: PluginManifest,
  ): readonly PluginModeProfile[] {
    if (module.modes === undefined) return manifest.modes ?? [];
    return validateModeProfiles(module.modes, manifest.id) ?? [];
  }

  private async resolveModule(source: PluginSource): Promise<PluginModule> {
    if (typeof source === "string") {
      if (source.trim() === "") throw new Error("插件 specifier 不能为空");
      let imported: unknown;
      try {
        imported = await import(source);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`插件加载失败: ${source}: ${reason}`);
      }
      return unwrapImportedModule(imported, source);
    }
    if (!isRecord(source)) {
      throw new Error("插件模块无效: 需要插件对象或 ESM specifier");
    }
    return source as unknown as PluginModule;
  }

  private validateManifest(raw: unknown, source: string): PluginManifest {
    if (!isRecord(raw)) {
      throw new Error(`插件 manifest 无效: ${source}`);
    }
    const id = raw.id;
    if (typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id)) {
      throw new Error(`插件 id 无效: ${source} -> ${String(id)}`);
    }
    const version = raw.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw new Error(`插件版本无效: ${id} -> ${String(version)}`);
    }
    const name = raw.name;
    if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
      throw new Error(`插件名称无效: ${id}`);
    }
    const tools = this.validateToolDeclarations(raw.tools, id);
    const promptFragments = validatePromptFragments(raw.promptFragments, id);
    const modes = validateModeProfiles(raw.modes, id);
    const capabilities = validateCapabilities(raw.capabilities, id);
    return {
      id,
      version,
      ...(typeof name === "string" ? { name } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(promptFragments !== undefined ? { promptFragments } : {}),
      ...(modes !== undefined ? { modes } : {}),
      ...(capabilities.length > 0 ? { capabilities } : {}),
    };
  }

  private validateToolDeclarations(
    raw: unknown,
    pluginId: string,
  ): readonly PluginToolDeclaration[] | undefined {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
      throw new Error(`插件工具声明无效: ${pluginId}`);
    }
    const seen = new Set<string>();
    const declarations: PluginToolDeclaration[] = [];
    for (const entry of raw) {
      if (!isRecord(entry)) {
        throw new Error(`插件工具声明无效: ${pluginId}`);
      }
      const name = entry.name;
      if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
        throw new Error(`插件工具名无效: ${pluginId} -> ${String(name)}`);
      }
      if (seen.has(name)) {
        throw new Error(`插件工具声明重复: ${pluginId} -> ${name}`);
      }
      seen.add(name);
      const category = entry.category;
      if (category !== undefined && category !== "read" && category !== "write" && category !== "execute") {
        throw new Error(`插件工具类别无效: ${pluginId} -> ${name}`);
      }
      const description = entry.description;
      if (description !== undefined && typeof description !== "string") {
        throw new Error(`插件工具声明描述无效: ${pluginId} -> ${name}`);
      }
      declarations.push({
        name,
        ...(typeof category === "string" ? { category } : {}),
        ...(typeof description === "string" ? { description } : {}),
      });
    }
    return declarations;
  }

  /** 校验工具实现与 manifest 声明一一对应（名称集合一致、声明描述一致、插件内不重名）。 */
  private validateTools(
    module: PluginModule,
    manifest: PluginManifest,
    source: string,
  ): readonly ToolDefinition[] {
    const rawTools = module.tools;
    if (rawTools !== undefined && !Array.isArray(rawTools)) {
      throw new Error(`插件工具实现无效: ${source}`);
    }
    const tools = rawTools ?? [];
    const implementations = new Map<string, ToolDefinition>();
    for (const tool of tools) {
      if (!isRecord(tool)) {
        throw new Error(`插件工具实现无效: ${source}`);
      }
      const name = tool.name;
      if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
        throw new Error(`插件工具名无效: ${manifest.id} -> ${String(name)}`);
      }
      if (implementations.has(name)) {
        throw new Error(`插件内工具名重复: ${manifest.id} -> ${name}`);
      }
      if (typeof tool.description !== "string") {
        throw new Error(`插件工具缺少描述: ${manifest.id} -> ${name}`);
      }
      if (typeof tool.execute !== "function") {
        throw new Error(`插件工具缺少执行实现: ${manifest.id} -> ${name}`);
      }
      if (!isRecord(tool.parameters)) {
        throw new Error(`插件工具缺少参数 schema: ${manifest.id} -> ${name}`);
      }
      implementations.set(name, tool as unknown as ToolDefinition);
    }

    const declared = manifest.tools ?? [];
    const declaredNames = new Set(declared.map((declaration) => declaration.name));
    for (const declaration of declared) {
      const implementation = implementations.get(declaration.name);
      if (implementation === undefined) {
        throw new Error(`工具声明缺少实现: ${manifest.id} -> ${declaration.name}`);
      }
      if (
        declaration.description !== undefined &&
        declaration.description !== implementation.description
      ) {
        throw new Error(`工具声明与实现描述不一致: ${manifest.id} -> ${declaration.name}`);
      }
    }
    for (const name of implementations.keys()) {
      if (!declaredNames.has(name)) {
        throw new Error(`工具实现缺少 manifest 声明: ${manifest.id} -> ${name}`);
      }
    }

    return tools;
  }
}

/** 从 ESM 命名空间解析插件模块：优先 default 导出，其次命名导出。 */
function unwrapImportedModule(imported: unknown, specifier: string): PluginModule {
  const candidate =
    isRecord(imported) && isRecord(imported.default) && "manifest" in imported.default
      ? imported.default
      : imported;
  if (!isRecord(candidate) || !("manifest" in candidate)) {
    throw new Error(`插件模块缺少 manifest 导出: ${specifier}`);
  }
  return candidate as unknown as PluginModule;
}

function validatePromptFragments(
  raw: unknown,
  pluginId: string,
): readonly PluginPromptFragment[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`插件提示词片段无效: ${pluginId}`);
  }
  const fragments: PluginPromptFragment[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      throw new Error(`插件提示词片段无效: ${pluginId}`);
    }
    const inline = entry.inline;
    const file = entry.file;
    const hasInline = typeof inline === "string" && inline.trim() !== "";
    const hasFile = typeof file === "string" && file.trim() !== "";
    if (hasInline === hasFile) {
      throw new Error(`插件提示词片段无效（inline/file 须二选一）: ${pluginId}`);
    }
    if (hasFile) {
      if (!path.isAbsolute(file as string) || !existsSync(file as string)) {
        throw new Error(`插件提示词文件必须为存在的绝对路径: ${pluginId}`);
      }
      fragments.push({ file: file as string });
    } else {
      fragments.push({ inline: inline as string });
    }
  }
  return fragments;
}

/**
 * 校验 mode profile：id 非空且唯一，modelProvider / modelId 非空；
 * 提示词声明 `appendSystemPrompt`（追加，宿主通用能力）与 `systemPrompt`（整体覆盖，旧语义）
 * **必须且只能二选一**，且所选项去空白后非空。
 */
function validateModeProfiles(
  raw: unknown,
  pluginId: string,
): readonly PluginModeProfile[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`插件 mode 声明无效: ${pluginId}`);
  }
  const seen = new Set<string>();
  const modes: PluginModeProfile[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      throw new Error(`插件 mode 声明无效: ${pluginId}`);
    }
    const id = entry.id;
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`插件 mode id 无效: ${pluginId} -> ${String(id)}`);
    }
    if (seen.has(id)) {
      throw new Error(`插件 mode id 重复: ${pluginId} -> ${id}`);
    }
    seen.add(id);
    const modelProvider = entry.modelProvider;
    if (typeof modelProvider !== "string" || modelProvider.trim() === "") {
      throw new Error(`插件 mode 缺少模型供应商: ${pluginId} -> ${id}`);
    }
    const modelId = entry.modelId;
    if (typeof modelId !== "string" || modelId.trim() === "") {
      throw new Error(`插件 mode 缺少模型 id: ${pluginId} -> ${id}`);
    }
    // 提示词必须二选一：两个都缺失或同时提供都在这里 fail-closed。
    const appendSystemPrompt = entry.appendSystemPrompt;
    const systemPrompt = entry.systemPrompt;
    const hasAppend = appendSystemPrompt !== undefined;
    const hasOverride = systemPrompt !== undefined;
    if (hasAppend === hasOverride) {
      throw new Error(
        `插件 mode 提示词无效（appendSystemPrompt/systemPrompt 须二选一）: ${pluginId} -> ${id}`,
      );
    }
    if (hasAppend && (typeof appendSystemPrompt !== "string" || appendSystemPrompt.trim() === "")) {
      throw new Error(`插件 mode 缺少追加系统提示词: ${pluginId} -> ${id}`);
    }
    if (hasOverride && (typeof systemPrompt !== "string" || systemPrompt.trim() === "")) {
      throw new Error(`插件 mode 缺少系统提示词: ${pluginId} -> ${id}`);
    }
    const thinkingLevel = entry.thinkingLevel;
    if (
      thinkingLevel !== undefined &&
      (typeof thinkingLevel !== "string" || thinkingLevel.trim() === "")
    ) {
      throw new Error(`插件 mode 思考级别无效: ${pluginId} -> ${id}`);
    }
    modes.push({
      id,
      modelProvider,
      modelId,
      ...(hasAppend ? { appendSystemPrompt: appendSystemPrompt as string } : {}),
      ...(hasOverride ? { systemPrompt: systemPrompt as string } : {}),
      ...(typeof thinkingLevel === "string" ? { thinkingLevel } : {}),
    });
  }
  return modes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 校验 manifest.capabilities：插件自声明的业务能力标识。
 *
 * 键名由插件原样声明，宿主不做任何大小写变换（避免 `bind` → `canBind` 这类脆弱的
 * 字符串拼接）；未声明时返回空数组（未声明的标识永远不出现在投影中）。
 */
function validateCapabilities(raw: unknown, pluginId: string): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`插件能力声明无效: ${pluginId}`);
  }
  if (raw.length > PLUGIN_CAPABILITY_LIMIT) {
    throw new Error(`插件能力声明超过上限 ${PLUGIN_CAPABILITY_LIMIT}: ${pluginId}`);
  }
  const seen = new Set<string>();
  const capabilities: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !PLUGIN_CAPABILITY_NAME_PATTERN.test(entry)) {
      throw new Error(`插件能力标识无效: ${pluginId} -> ${String(entry)}`);
    }
    if (seen.has(entry)) {
      throw new Error(`插件能力标识重复: ${pluginId} -> ${entry}`);
    }
    seen.add(entry);
    capabilities.push(entry);
  }
  return capabilities;
}
