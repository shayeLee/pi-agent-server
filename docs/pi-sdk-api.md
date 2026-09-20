# Pi SDK API 使用清单

> 本文只记录 pi-agent-server 实际用到、且不易变化的 SDK 边界结论与升级核对清单，供维护者快速定位；具体签名、事件类型与选项默认值易随 SDK 漂移，一律以官方 `sdk.md` 为准，本文不重复。

## 1. 官方文档定位（升级后须重核）

官方文档随包安装，不在本仓库内。项目内已安装 `@earendil-works/pi-coding-agent` 并使用 ESM import 时：

```bash
volta run node --input-type=module -e \
  "import('@earendil-works/pi-coding-agent').then(m => console.log(m.getDocsPath()))"
volta run node --input-type=module -e \
  "import('@earendil-works/pi-coding-agent').then(m => console.log(m.getPackageDir()))"
volta run node --input-type=module -e \
  "import('@earendil-works/pi-coding-agent').then(m => console.log(m.getReadmePath()))"
```

`getDocsPath()` / `getPackageDir()` / `getReadmePath()` 均为包导出 helper，随安装位置自动计算。

相关文档（`<docs>/` 下）：`sdk.md`（主核对源）、`session-format.md`、`extensions.md`、`rpc.md`、`environment-variables.md`。

## 2. 依赖版本与升级核对清单

**核对基线：`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` 0.86.0。**

> 0.85.1 → 0.86.0 已核对完毕；当时的四处代码/文档改动见 §3.9。

升级该依赖后按序核对，并更新上方基线版本号：

1. 用第 1 节命令定位最新 `docs` 目录，打开 `sdk.md`。
2. 逐项核对第 3 节「SDK 边界」：导出名、`createAgentSession` 返回结构、替换式操作位置、工具白名单语义、ResourceLoader 发现行为、SSE 映射。
3. 签名/导出/默认行为变化时，更新本文，并同步修正 needs.md 与实现代码。
4. 以 `pi --version` 为准更新「核对基线」版本号。

## 3. 当前 SDK 边界（维护者要点）

### 3.1 会话创建与生命周期

- `createAgentSession(...)` 返回 `{ session, extensionsResult, modelFallbackMessage }`，`session` 才是 `AgentSession`。
- 新建/恢复/替换式操作在 `AgentSessionRuntime` 上（`newSession()` / `switchSession(path)` / `fork(entryId)` / `importFromJsonl(...)`），不在 `AgentSession` 上；替换后 `runtime.session` 变化，事件订阅需重新绑定。
- 流式期间调用 `prompt()` 需指定 `streamingBehavior`，否则抛错；建议用 `steer()` / `followUp()` 分别对应 needs.md §4.2 的 steer / follow-ups。
- `AgentSession` 状态机（空闲 `prompt`、流式中 `steer`/`followUp`、中断 `abort`、SSE 源 `subscribe`）对应 needs.md §4.2。

### 3.2 会话持久化（SessionManager）

- 静态入口：`inMemory()`（不落盘，测试）、`create(cwd)`、`continueRecent(cwd)`、`open(path)`、`list(cwd)`、`listAll(cwd)`。
- 历史编辑/分叉：`branch(entryId)`、`branchWithSummary(...)`、`createBranchedSession(leafId)`；命名 `appendSessionInfo(name)`/`getSessionName()`，读取 `getEntries()`/`getTree()`。
- 对应 needs.md §4.1 的 Pi JSONL 会话存储。服务层当前 DELETE 只删除 DB 业务记录并写入 outbox，不调用 SDK 做物理 JSONL 删除。

### 3.3 模型与凭证（ModelRuntime）

- `ModelRuntime.create({ authPath, modelsPath, credentials, ... })`；`getModel` / `getAvailable` / `refresh`。
- 密钥用 `setRuntimeApiKey` 注入、`removeRuntimeApiKey` 清除（不落盘、不落日志），OAuth 走 `login()`/`logout()`。
- 安全边界（needs.md §7）：用户自定义模型凭证必须注入 KMS 加密的 `CredentialStore`；`authPath`（auth.json）不得用于存放用户凭证，避免明文落盘。

### 3.4 自定义工具

- `defineTool` + TypeBox `Type` 声明 name/label/description/parameters/execute，注册进 `customTools`，并把工具名列入 `tools` 白名单（needs.md §4.3「工具注册表」的读/写/执行映射）。
- 内置工具名：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`；默认内置 `read`/`bash`/`edit`/`write`。`noTools: "all"` 全禁、`noTools: "builtin"` 只禁默认内置、`excludeTools` 在 `tools` 白名单之后按名补禁。
- needs.md §4.3「默认只读」实现：未配置时 `tools: ["read", "ls", "find", "grep"]`，并显式列出能力声明的 `customTools`。
- 显式加载的受信外部插件工具同样经 `customTools` 注册，并同时进入 `tools` 白名单；仅把工具名写入白名单不会注册执行实现。

### 3.5 资源加载与系统提示词（安全边界）

⚠️ `DefaultResourceLoader` 默认自动发现 `<cwd>/.pi/extensions`、skills、prompts、`AGENTS.md`、themes 及 `agentDir` 下全局资源——直接使用会加载未声明扩展与上下文。needs.md §7 要求只从 manifest 注入受控资源：使用不自动发现的自定义 `ResourceLoader`，或清空各类 override 与 append-system-prompt。会话创建时冻结系统提示词；带 mode profile 的会话创建和恢复均使用该冻结提示词对应的受控 ResourceLoader。

外部插件 mode 的**追加**提示词（P7c）不经过资源加载器的 append 通道：宿主先经 `SystemPromptPort` 取得该项目在 Pi 侧的完整提示词，再以与 `buildSystemPrompt` 相同的空行分隔追加片段，把合并结果作为会话快照冻结进 `sessions.system_prompt`；恢复时按该字面量 override 复用，不重新解析、不重复追加。旧的 `systemPrompt` 整体覆盖语义保持不变，二者互斥。

**显式 provider 扩展（0.86.0 核对结论）**：`additionalExtensionPaths` 在 `noExtensions: true` 下仍会被加载（`noExtensions` 只关掉 settings/manifest 自动发现），因而是受控接入 provider 扩展的正规通道。扩展工厂里的 `pi.registerProvider()` 在 loader 阶段**只入队** `runtime.pendingProviderRegistrations`；由 `createAgentSession` → `AgentSession._buildRuntime` → `ExtensionRunner.bindCore` 刷入 `ModelRuntime`（`agent-session-services.js` 的显式 flush 同理）。宿主若在首个会话创建前就要用到这些 provider（默认模型/凭证校验、插件 mode 校验、`GET /v1/models`），必须在 `loader.reload()` 后自行 flush，且刷完清空队列以避免二次注册；无需额外调用（0.84.4 时期曾误判需要）`bindExtensions`——`sdk.js` 的 `onPayload`/`transformHeaders` 已统一走 `extensionRunnerRef.current` 的 `before_provider_request` / `before_provider_headers`（该结论在 0.86.0 仍成立；但注意 `bindExtensions` 在 0.86.0 里还负责 `session_start` 与 `extendResourcesFromExtensions`，宿主已显式调用，无回归）。注册失败（如 `streamSimple` 缺 `api`）在宿主这里即 fail-fast 拒绝启动，且错误只回显扩展路径与 provider 标识，不透传 SDK/provider 原文与 `cause`。

**一个活动 session 一个 ResourceLoader（冻结提示词与 dispose 语义）**：`AgentSession.dispose()` 会 `extensionRunner.invalidate(...)`，进而 `ExtensionRuntime.invalidate()` 把该 runtime 永久标记为 stale（此后 `pi.*` 动作与 `ctx` 访问都抛错，且该标记无法清除）。因此**同一 `ResourceLoader` 的 ExtensionRuntime 绝不能跨活动会话共享**：

- 每个活动 session 在创建 adapter 时构造并 `reload()` 一个**独立** loader；同一 session 的多轮复用该 session 的 `AgentSession`/adapter/loader（SDK 单会话语义，无需也不应重建）；
- **startup 默认模型/提示词探针与项目提示词探针**各自使用一次性 loader：探针会话 `dispose()` 后该 loader 的 runtime 变为 stale，但它不再交给任何真实会话；若与真实会话共享同一个 loader，真实会话拿到的 runtime 会在**第一次探针 dispose 后**直接失效（这是实测行为，不是理论风险）；
- **恢复冻结提示词会话**同样按会话构造 loader（`systemPromptOverride` 按字面量返回快照），因此恢复出的会话也持有自己的 runtime；绝不按 frozen `systemPrompt` 字符串缓存/复用 loader，否则同一快照的第二个会话会被第一个会话的 dispose 污染；
- **每个 loader 只 `reload()` 一次**：宿主不用 `session.reload()`/`loader.reload()` 二次加载；这样同一 cwd 下扩展模块只求值一次（见下条）。

**扩展加载 cwd 必须稳定、与项目 cwd 解耦（实测结论）**：`DefaultResourceLoader` 的 `cwd` 同时决定扩展模块缓存的键（`loadExtensionsCached(paths, cwd, ...)` → `useExtensionCacheCwd`）与项目提示词/上下文的根。`AgentSession` 的会话 cwd 由 `createAgentSession({ cwd })` 决定，与 loader 的 `cwd` 是两个独立入参：提示词里的 cwd 段取**会话 cwd**（0.86.0 起渲染为 `<cwd>\n<path>\n</cwd>` 结构化 section，不再是一行 `Current working directory: <path>`；见 §3.9）。因此宿主让**所有** loader 的 `cwd` 恒为服务 cwd，只把项目 cwd 传给 `createAgentSession({ cwd })`：

- 若 loader 的 `cwd` 跟着项目 cwd 交替（startup 探针用服务 cwd、项目探针用项目 cwd、冻结会话又回服务 cwd），`useExtensionCacheCwd()` 每次遇到不同 cwd 就 `clearExtensionCache()`，扩展模块整进程被反复重新求值；模块级副作用（典型如 WorkBuddy 在 `globalThis.fetch` 上再包一层）会层层叠加，进程生命周期内无法卸载。
- 扩展加载 cwd 稳定后：模块只求值一次、模块级副作用只发生一次，工厂函数仍按 loader（即按活动会话/探针）重跑，provider 注册与每会话独立 runtime 完全不受影响；项目提示词仍按各自项目 cwd 解析（未篡改）。

扩展模块缓存语义（实测）：`ResourceLoader.reload()` 在**自身已 loaded** 时先 `clearExtensionCache()`，否则只在 cwd 与前一次缓存不同时清。因此：已加载过的 loader 再次 reload 会重求值全部扩展模块；**新建 loader 首次 reload 在 cwd 不变时只复用缓存（仅重跑工厂函数）**。宿主每个 loader 只 reload 一次且扩展加载 cwd 恒定，所以扩展模块顶层的副作用（如 `globalThis.fetch` 包装）整进程只发生一次；工厂函数则每个 loader 重跑一次（这正是「每会话独立 runtime」需要的）。仅在以下情形会重叠：同一 cwd 的 loader 被再次 reload（如 `session.reload()`，宿主当前不会调用）。

**提示词的追加源必须显式给出**：`DefaultResourceLoader` 在未传 `appendSystemPrompt` 时会自动发现 `agentDir/APPEND_SYSTEM.md` 与 `<cwd>/.pi/APPEND_SYSTEM.md`（受项目信任影响）。冻结字面量恢复路径（`systemPromptOverride`，不传 `appendSystemPrompt`）若依赖该默认值，恢复出的会话会把**当前磁盘内容**追加到冻结快照之后，破坏「恢复即冻结字面量」；因此宿主对每个 loader 都显式传 `appendSystemPrompt`（无能力片段时传 `[]`）关闭该自动发现（0.86.0 仍成立）。

可信扩展的模块级副作用（含上面这类 `globalThis.fetch` 包装）属于**进程生命周期**，不是会话生命周期：宿主无法卸载它们，启动失败退出也不保证能回滚任意扩展已经施加的全局副作用（见 README「Current boundaries」）。

### 3.6 SettingsManager

`SettingsManager.create(cwd?, agentDir?)` 从文件加载、`inMemory(settings?)` 测试用；`applyOverrides`、`flush()`（持久化边界）、`drainErrors()`（读取设置 I/O 错误）。

### 3.7 事件与 SSE 映射（服务层协议）

`subscribe` 收到的 SDK 事件需在服务层翻译为 needs.md §4.2 的 SSE 协议：

| SDK 事件 | SSE 事件 |
|---|---|
| `message_update`（`text_delta`） | `text_delta` |
| `message_update`（`thinking_delta`） | `thinking_delta` |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | `tool_start` / `tool_update` / `tool_end` |
| `agent_start` / `turn_start` | `status` |
| `agent_end`（成功） | `completed` |
| `abort()` 调用或异常 | `aborted` / `error` |

`queued` 由服务层在任务进入模型队列时产生；`completed`/`aborted`/`error` 无直接 SDK 事件，由服务层根据 `agent_end`、异常与 `abort()` 合成。

**turn 事件携带 `requestId`（P7b）**：`translateSdkEvent` 只做 SDK→SSE 的纯映射，不填 `requestId`；`SessionRuntime` 在发射每个 turn 相关事件时统一附加当前任务的 `requestId`（`text_delta`/`thinking_delta`/`tool_start`/`tool_update`/`tool_end`/`status`/`usage`/`queued`/`error`/`completed`/`aborted`）。关键语义：

- 事件仅在活动窗口（`streaming` 或 `aborting`）处理，stray 事件与已结算后的迟到事件一律忽略，绝不绑定到下一个 `requestId`；
- 队列超时（`handleExpired`）用**被超时任务自己的** `requestId`，而非当前/下一个任务；
- `settle` 在清空 `currentRequestId` **之前**捕获该值，终态与 `usage` 一律归属本请求；
- 类型上 `requestId` 仍为可选（`SseRequestId`），仅用于非 turn 遗留场景；正常 turn 的发射路径总是携带具体值并有测试断言。

### 3.8 图片输入（P7a 核对结论，0.86.0 复核未变）

- `PromptOptions.images` / `steer(text, images)` / `followUp(text, images)` 的图片元素类型是 `@earendil-works/pi-ai` 的 `ImageContent`，**0.86.0 的真实形状仍为 `{ type: "image", data: string (base64), mimeType: string }`**（`pi-ai/dist/types.d.ts` 的 `ImageContent`）；并不存在 `source.base64` 包裹层（该形状是早期误判，已在 P7a 修正）。`src/agent/pi-agent-adapter.ts` 的 `SdkImageContent` 与之逐字段对齐，并有编译期兼容断言（tests/agent/image-input.test.ts）。
- `AgentSession.prompt` 直接把这些图片块 push 进 user content，并在 JSONL 中以同形状持久化（`{"type":"image","data":...,"mimeType":...}`）；因此只读导出（`buildSessionContext`）与活会话导出（`session.messages`）看到的是同一结构。
- `detectSupportedImageMimeType`（`utils/mime`）能嗅探 png/jpeg/gif/webp/bmp，但会在 `isAnimatedPng` 命中时返回 `null`；宿主 P7a 策略更严：只接受静态 `image/png`、`image/jpeg`、`image/webp`，由 `src/agent/image-input.ts` 以真实魔数+头部尺寸重新验证，不依赖上游嗅探。
- SDK 自带的图片处理（`utils/image-process`、`image-resize`）面向工具结果与终端显示，依赖可选的原生 Photon；宿主 P7a **不**调用它们，也不引入任何原生图像依赖：压缩由客户端完成，宿主只做校验与透传。

### 3.9 0.85.1 → 0.86.0 升级结论（`Context` vs `TranscriptContext`）

**provider 层收到的 context 不再是 `Context`，而是归一化后的 `TranscriptContext`**：`TranscriptContext = { messages: Message[] }`（带 brand，只能由 `normalizeContext()` 产生），`systemPrompt` 与 `tools` 被折叠进 transcript 的 leading system message（`content` / `toolsAdded`）。调用链：`ModelRuntime.streamSimple` 先 `normalizeContext(context)` 再转给 provider，provider-composer 原样把该 transcript 交给扩展的 `streamSimple`。

宿主影响（`src/provider-adapters/deepseek-v4/provider-adapter.ts`）：

- **禁止**在读 `context.tools` / `context.systemPrompt`——0.86.0 下两者在流式 context 上恒为 `undefined`。取工具集必须回放 transcript：`getCurrentTools(context.messages).map((t) => t.name)`；取系统提示词用 `getCurrentSystemPrompt(context.messages)`。二者均由 `@earendil-works/pi-ai` 顶层导出。
- 语义等价性：agent loop 每轮把可执行工具集与 transcript 的差量写成 `toolsAdded`/`toolsRemoved`，其注释明确「replay always yields exactly `context.tools`」，故 `getCurrentTools()` 与 0.85.1 的 `context.tools` 等价。
- 该缺陷**类型系统拦不住**：`TranscriptContext` 是 `Context` 的子类型，参数逆变让 `(c: Context) => X` 合法赋给 `(c: TranscriptContext) => X`，`tsc` 全绿。宿主已把 `StreamSimple` 的形参收窄为 `TranscriptContext` 以固化修复，并在 `tests/provider-adapters/deepseek-v4-stream-normalizer.test.ts` 增加走 adapter 的回归用例（已实测：改回旧读法即失败）。

**模型 id 改名会让文本协议适配器静默成死代码（本次升级的真实教训）**：0.86.0 的 catalog 把 `deepseek/deepseek-v4-flash` 退役为 `deepseek-flash`（CHANGELOG 有明确记录：「instead of retired Flash aliases」）；`opencode/deepseek-v4-flash-free` → `opencode/deepseek-v4-flash` 则是根据当前 catalog 与旧适配器/真实 fixture 反推（CHANGELOG 未点名 OpenCode）。无论哪条，适配器原先按**精确 id** 匹配，改名后 `matches()` 恒为 false，于是适配器整体退化为透传——**无报错、无测试失败、`tsc` 全绿、`pnpm verify` 全绿**，但 DSML / `<use_tool>` 文本协议已不再被转换。现改为「provider 精确 + 模型 id 子串含 `deepseek`」，并新增断言：用 `builtinProviders()` 要求每个已注册 provider 至少命中一个真实 catalog 模型（`tests/provider-adapters/deepseek-v4-stream-normalizer.test.ts`）。这条断言会在升级当天失败，而不是静默废弃几个月。同时 `opencode` 与 `opencode-go`（同厂、同 4 个 deepseek 模型 id）共用 DSML 适配器，两者都在 `start.ts` 注册；其中 `opencode-go` 的 DSML 归属是**推断而非观测**（见 `provider-adapter.ts` 的 `OPENCODE_PROVIDERS` 注释）。

**系统提示词改为结构化 sections**：0.86.0 的 `buildSystemPromptSections` 把提示词拆成 `preamble`（裸文本）与 `tools`/`rules`/`docs`/`addendum`/`project_context`/`skills`/`cwd`（统一包成 `<name>\n…\n</name>`），段间以空行连接；cwd 因此从 0.85.1 的 `\nCurrent working directory: <path>\n` 变为 `<cwd>\n<path>\n</cwd>`。`customPrompt` 分支仍**无条件**追加 cwd 段，所以冻结字面量恢复路径的拼接结果仍是「冻结字面量 + 一个 cwd 段」（与 0.85.1 语义一致，仅形态不同）。

其余破坏性变更与本仓库的关系：`ToolCall.arguments` 收窄为 `JsonObject`（宿主写入值来自 `Record<string,string>`，合法）、`ToolResultMessage` 条件类型与 `JsonValue` 只读数组（宿主的 `details` 用法不赋值给 SDK 类型）、`user_bash` fail-closed（宿主未使用该 hook）。

## 4. 签名明细（不在本文维护）

具体签名、事件类型清单与选项默认值随 SDK 漂移，一律以官方 `sdk.md` 为准；本文只保留第 3 节的边界结论。改动边界结论时按第 2 节流程重核。
