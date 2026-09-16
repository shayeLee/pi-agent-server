// 显式 provider 扩展接入（可选、受信、同进程）：
// - 只加载显式配置的路径（StartConfig.providerExtensionPaths / PI_PROVIDER_EXTENSION_PATHS），
//   绝不自动发现——DefaultResourceLoader 恒为 noExtensions:true，保留既有安全边界；
// - 这些扩展可以注册模型 provider（pi.registerProvider）并订阅 before_provider_request /
//   before_provider_headers / before_agent_start 等 hook；
// - 扩展在工厂函数里排队的 provider 注册必须由宿主在 loader.reload() 之后**显式**刷进
//   ModelRuntime：默认模型校验、插件 mode 校验与 PiModelRuntimeCatalog 都在首个会话创建前
//   解析 provider，若只依赖 createAgentSession 内部 flush，扩展 provider 对它们不可见。
// 扩展代码即宿主权限，属受信边界，不是沙箱（见 README「Current boundaries」）。

import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  createEventBus,
  DefaultResourceLoader,
  type EventBus,
  type InlineExtension,
  type ModelRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

/**
 * 归一化显式 provider 扩展路径（纯函数）：
 * - 空白项（含逗号分隔产生的空项）忽略；
 * - 支持 `~` / `~/…` 展开；展开后必须是绝对路径，相对路径 fail-fast
 *   （避免相对 AGENT_CWD 的隐式歧义，与其它离线 CLI 的绝对路径约束一致）；
 * - 保序去重。
 */
/** 每个 loader 自己的 EventBus；WeakMap 不延长 dispose 后 loader 的生命周期。 */
const loaderEventBuses = new WeakMap<ResourceLoader, EventBus>();

/** 取与该 ResourceLoader 同源的扩展 EventBus，供会话 adapter 严格绑定。 */
export function getProviderExtensionEventBus(loader: ResourceLoader): EventBus | undefined {
  return loaderEventBuses.get(loader);
}

export function resolveProviderExtensionPaths(
  configured: readonly string[] | undefined,
): readonly string[] {
  const paths: string[] = [];
  for (const raw of configured ?? []) {
    const entry = raw.trim();
    if (entry === "") continue;
    const expanded = entry === "~" ? homedir() : entry.startsWith("~/") ? join(homedir(), entry.slice(2)) : entry;
    if (!isAbsolute(expanded)) {
      throw new Error(`provider extension path must be absolute (or start with "~/"): ${entry}`);
    }
    if (!paths.includes(expanded)) paths.push(expanded);
  }
  return paths;
}

/** 扩展入口路径是否落在某个显式配置的路径之下（配置为文件时取相等）。纯字符串/路径比较，不做 realpath。 */
function configuredPathCovers(configuredPath: string, loadedPath: string): boolean {
  const root = resolve(configuredPath);
  const loaded = resolve(loadedPath);
  if (loaded === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return loaded.startsWith(prefix);
}

/**
 * 显式配置的扩展加载失败（路径不存在、模块无法导入、未导出工厂函数等）即拒绝启动：
 * 显式配置绝不允许静默降级为「没加载」。
 *
 * 除 SDK 报出的 `errors` 外，还逐条确认**每个显式配置的路径真的产出了扩展入口**：
 * 空目录、manifest 里 `pi.extensions` 指向的入口缺失、`extensions/` 子目录为空等情形
 * SDK 既不报错也不加载任何扩展，只检查 `errors` 会把它们静默当成「加载成功」。
 * 覆盖判定只读取一次 `loader.getExtensions()`，不触发二次 reload，也不重跑任何扩展工厂。
 *
 * 错误只含**宿主自己配置的路径**与固定文案：SDK/扩展提供的原始错误文本一律不透传
 * （扩展可能把凭证、请求头或内部细节写进错误消息），也不附加 `cause`（避免调用方/日志
 * 顺着 cause 读到原文）。定位失败原因需直接检查该扩展自身。
 */
export function assertProviderExtensionsLoaded(
  loader: ResourceLoader,
  configuredPaths: readonly string[],
): void {
  const result = loader.getExtensions();
  if (result.errors.length > 0) {
    const paths = [...new Set(result.errors.map((entry) => entry.path))];
    throw new Error(`provider extension failed to load: ${paths.join(", ")}`);
  }
  // 配置路径必须至少被一个已加载入口覆盖：配置为目录时入口在其下（含 manifest/`extensions`
  // 展开出的文件），配置为文件时入口就是该文件。相对入口（manifest 指向目录外）按未覆盖处理，
  // fail-closed 而不是把它当成「已加载」。
  const loadedPaths = result.extensions.map((extension) => extension.resolvedPath || extension.path);
  const uncovered = configuredPaths.filter(
    (configured) => !loadedPaths.some((loaded) => configuredPathCovers(configured, loaded)),
  );
  if (uncovered.length > 0) {
    throw new Error(`provider extension failed to load: ${uncovered.join(", ")}`);
  }
}

/**
 * 把扩展排队的 provider 注册刷进 ModelRuntime（复刻 SDK createAgentSessionServices 的语义，
 * 但注册失败即 fail-fast，而不是只记诊断）。返回成功注册的 provider id，供调用方记录/断言。
 *
 * 刷完两个队列后清空，避免 createAgentSession/_buildRuntime 再次 flush 造成重复注册；
 * 之后由扩展运行时发起的 registerProvider 会走已绑定的 ModelRuntime（bindCore 后的直接调用）。
 *
 * 失败同样脱敏：只回显扩展路径与 provider 标识，绝不透传 SDK/provider 的原始错误文本或 cause。
 */
export function flushProviderRegistrations(
  modelRuntime: ModelRuntime,
  loader: ResourceLoader,
): readonly string[] {
  const result = loader.getExtensions();
  const registered: string[] = [];
  for (const { name, config, extensionPath } of result.runtime.pendingProviderRegistrations) {
    try {
      modelRuntime.registerProvider(name, config);
    } catch {
      throw new Error(`provider extension "${extensionPath}" failed to register provider "${name}"`);
    }
    registered.push(name);
  }
  result.runtime.pendingProviderRegistrations = [];
  for (const { provider, extensionPath } of result.runtime.pendingNativeProviderRegistrations) {
    try {
      modelRuntime.registerNativeProvider(provider);
    } catch {
      throw new Error(
        `provider extension "${extensionPath}" failed to register native provider "${provider.id}"`,
      );
    }
  }
  result.runtime.pendingNativeProviderRegistrations = [];
  return registered;
}

/** 会话专属 ResourceLoader 的构造参数（提示词三项互斥由调用方决定，本函数只透传）。 */
export type SessionResourceLoaderOptions = {
  /**
   * loader 的稳定 cwd：**所有** loader 必须传同一值（服务 cwd），不得随项目 cwd 变化。
   *
   * SDK 以「上一次扩展加载 cwd」为键维护模块缓存：cwd 与上次不同即 `clearExtensionCache()`
   * 并重新求值全部扩展模块（模块级副作用重放，例如 WorkBuddy 在 `globalThis.fetch` 上再包一层）。
   * 项目提示词/工具 cwd 由 `createAgentSession({ cwd })` 决定，与本值无关；提示词里的
   * `Current working directory` 行取会话 cwd，因此稳定本值不会篡改项目提示词。
   */
  readonly extensionCwd: string;
  /** 服务专用 agentDir（不继承个人 ~/.pi/agent）。 */
  readonly agentDir: string;
  /** 显式 provider 扩展路径；为空时不加载任何外部扩展。 */
  readonly providerExtensionPaths?: readonly string[];
  /** 服务内置受控 extension factory（如协议兼容层）。 */
  readonly extensionFactories?: InlineExtension[];
  /** 整体提示词覆盖（PI_SYSTEM_PROMPT；未设置时由 SDK 生成默认提示词）。 */
  readonly systemPrompt?: string;
  /** 冻结提示词字面量 override（恢复会话用；绝不重新解析、不再追加片段）。 */
  readonly systemPromptOverride?: () => string;
  /** 追加提示词片段（能力片段；仅新建/首次解析路径使用）。 */
  readonly appendSystemPrompt?: readonly string[];
};

/**
 * 创建、reload 并接线一个**会话专属** ResourceLoader（宿主唯一入口）。
 *
 * 安全与生命周期契约：
 * - `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles` 恒为 true：只加载显式
 *   配置的 provider 扩展路径，绝不自动发现；
 * - 显式配置的扩展加载失败即抛错（fail-fast，绝不静默降级为「没加载」）；
 * - reload 后立即把扩展排队的 provider 注册刷进传入的 ModelRuntime（默认模型/凭证校验、插件
 *   mode 校验、`GET /v1/models` 与后续恢复会话都可见），并清空队列避免二次注册；
 * - **一个 loader 只服务一个活动 session**：loader 持有自己的 ExtensionRuntime，`AgentSession
 *   .dispose()` 会 invalidate 它；startup/项目提示词探针会话创建后立即 dispose，绝不能与真实
 *   会话共享同一 loader（否则真实会话拿到 stale runtime）。同一 session 的多轮共享同一 adapter
 *   与 loader，无需重建；
 * - **所有 loader 共用同一稳定 `extensionCwd`**（服务 cwd）：新建 loader 首次 reload 复用模块
 *   缓存（仅重跑工厂函数），已 loaded 的 loader 再次 reload 才会 clearExtensionCache() 重求值；
 *   宿主每个 loader 只 reload 一次，且扩展加载 cwd 恒定，所以扩展模块级副作用整进程只发生一次
 *   （见 docs/pi-sdk-api.md §3.5）。项目 cwd 变化只影响会话工具/提示词 cwd，不影响本值；
 * - **追加提示词源恒为显式**：即使调用方不传 `appendSystemPrompt`，也显式传 `[]`，否则 SDK 会
 *   自动发现 `agentDir/APPEND_SYSTEM.md` 与 `<cwd>/.pi/APPEND_SYSTEM.md`——冻结字面量恢复路径
 *   会被偷偷追加当前磁盘内容，破坏「恢复即冻结字面量」。
 */
export async function loadSessionResourceLoader(
  modelRuntime: ModelRuntime,
  options: SessionResourceLoaderOptions,
): Promise<DefaultResourceLoader> {
  const providerExtensionPaths = options.providerExtensionPaths ?? [];
  const eventBus = createEventBus();
  const loader = new DefaultResourceLoader({
    cwd: options.extensionCwd,
    eventBus,
    agentDir: options.agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(providerExtensionPaths.length > 0
      ? { additionalExtensionPaths: [...providerExtensionPaths] }
      : {}),
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.systemPromptOverride !== undefined
      ? { systemPromptOverride: options.systemPromptOverride }
      : {}),
    // 恒显式：`[]` 明确关闭 SDK 的 APPEND_SYSTEM.md 自动发现（冻结字面量恢复路径必须零追加）。
    appendSystemPrompt: options.appendSystemPrompt ? [...options.appendSystemPrompt] : [],
    ...(options.extensionFactories !== undefined
      ? { extensionFactories: options.extensionFactories }
      : {}),
  });
  await loader.reload();
  if (providerExtensionPaths.length > 0) assertProviderExtensionsLoaded(loader, providerExtensionPaths);
  flushProviderRegistrations(modelRuntime, loader);
  loaderEventBuses.set(loader, eventBus);
  return loader;
}
