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

**核对基线：`@earendil-works/pi-coding-agent 0.84.4`**（`pi --version` 当前 0.84.4）。

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

### 3.5 资源加载与系统提示词（安全边界）

⚠️ `DefaultResourceLoader` 默认自动发现 `<cwd>/.pi/extensions`、skills、prompts、`AGENTS.md`、themes 及 `agentDir` 下全局资源——直接使用会加载未声明扩展与上下文。needs.md §7 要求只从 manifest 注入受控资源：使用不自动发现的自定义 `ResourceLoader`，或清空各类 override 与 append-system-prompt。系统提示词经 `systemPromptOverride` 按已启用能力组合生成并冻结，固定不变。

### 3.6 SettingsManager

`SettingsManager.create(cwd?, agentDir?)` 从文件加载、`inMemory(settings?)` 测试用；`applyOverrides`、`flush()`（持久化边界）、`drainErrors()`（读取设置 I/O 错误）。

### 3.7 事件与 SSE 映射（服务层协议）

`subscribe` 收到的 SDK 事件需在服务层翻译为 needs.md §4.2 的 SSE 协议：

| SDK 事件 | SSE 事件 |
|---|---|
| `message_update`（`text_delta`） | `text_delta` |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | `tool_start` / `tool_update` / `tool_end` |
| `agent_start` / `turn_start` | `status` |
| `agent_end`（成功） | `completed` |
| `abort()` 调用或异常 | `aborted` / `error` |

`queued` 由服务层在任务进入模型队列时产生；`completed`/`aborted`/`error` 无直接 SDK 事件，由服务层根据 `agent_end`、异常与 `abort()` 合成。

## 4. 签名明细（不在本文维护）

具体签名、事件类型清单与选项默认值随 SDK 漂移，一律以官方 `sdk.md` 为准；本文只保留第 3 节的边界结论。改动边界结论时按第 2 节流程重核。
