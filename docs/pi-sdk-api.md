# Pi SDK API 使用清单

> 本文记录 pi-agent-server 使用到的 Pi SDK API，作为实现的快速索引，不是官方文档的替代。API 签名以官方 `sdk.md` 为准，SDK 升级后须按第 1 节方法重新核对并更新本文。

## 1. 官方文档定位与更新方法

官方文档随 pi 包一起安装，不在本项目仓库内。定位方法（项目内需已安装 `@earendil-works/pi-coding-agent`，并使用 ESM import）：

```bash
# 文档目录
node --input-type=module -e \
  "import('@earendil-works/pi-coding-agent').then(m => console.log(m.getDocsPath()))"

# 包根目录
node --input-type=module -e \
  "import('@earendil-works/pi-coding-agent').then(m => console.log(m.getPackageDir()))"

# Pi SDK README 路径
node --input-type=module -e \
  "import('@earendil-works/pi-coding-agent').then(m => console.log(m.getReadmePath()))"
```

`getDocsPath()`、`getPackageDir()`、`getReadmePath()` 均为包导出 helper，随安装位置自动计算，跨环境稳定。

相关文档（位于 `<docs>/` 下）：

- `sdk.md`：SDK API 主文档，本文的核对源。
- `session-format.md`：会话 JSONL 文件格式。
- `extensions.md`：扩展与自定义工具完整 API。
- `rpc.md`：RPC 模式。
- `environment-variables.md`：环境变量。

### 更新步骤

1. 升级 pi 或 `@earendil-works/pi-coding-agent` 后，用上述命令定位最新 `docs` 目录。
2. 打开 `sdk.md`，对照本文「API 清单」逐项核对签名与导出。
3. 若签名、导出或默认行为变化，更新本文，并同步修正 needs.md 与实现代码。
4. 更新下方「核对基线」的版本号。

核对基线：`pi 0.84.2`（用 `pi --version` 查当前版本）。

## 2. 会话创建与生命周期

```typescript
import {
  createAgentSession,
  createAgentSessionRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const { session, extensionsResult, modelFallbackMessage } =
  await createAgentSession({ /* 选项见下 */ });
```

`createAgentSession()` 返回 `{ session, extensionsResult, modelFallbackMessage }`，其中 `session` 才是 `AgentSession`。

会话的新建、恢复、替换等**替换式**操作在 `AgentSessionRuntime` 上，不在 `AgentSession` 上：

- `runtime.newSession()`：新建会话
- `runtime.switchSession(path)`：切换到已保存会话
- `runtime.fork(entryId, options?)`：从指定节点分叉
- `runtime.importFromJsonl(...)`：导入 JSONL
- 注意：替换后 `runtime.session` 会变化，事件订阅需重新绑定

对应到 needs.md §4.2 的 `POST /v1/sessions`：实现时用 `SessionManager.create(cwd)` 或 `AgentSessionRuntime.newSession()`，而非 `AgentSession` 上的方法。

### createAgentSession 关键选项

| 选项 | 说明 |
|---|---|
| `cwd` | 工作目录（工具路径解析、资源发现） |
| `agentDir` | 全局配置目录（独立 agentDir，避免继承个人配置） |
| `model` / `modelRuntime` / `scopedModels` | 模型、运行时与会话可用模型范围 |
| `tools` / `noTools` / `excludeTools` | 内置工具白名单/禁用 |
| `customTools` | 自定义（结构化）工具 |
| `resourceLoader` | 资源加载器（系统提示词、扩展、技能） |
| `sessionManager` | 会话持久化 |
| `settingsManager` | 设置 |
| `thinkingLevel` | 思考等级 |

## 3. AgentSession 方法（对应 needs.md §4.2）

```typescript
interface AgentSession {
  prompt(text: string, options?: PromptOptions): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
  navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ editorText?: string; cancelled: boolean }>;
  setModel(model: Model): Promise<void>;

  sessionFile: string | undefined;
  sessionId: string;
  isStreaming: boolean;
  messages: AgentMessage[];
  agent: Agent;
  model: Model | undefined;
}
```

与 needs.md 状态机的对应：

- 空闲时 `messages` → `session.prompt(text)`
- 流式生成中 `steer` → `session.steer(text)`
- 流式生成中 `follow-ups` → `session.followUp(text)`
- 中断 `abort` → `session.abort()`
- SSE 事件源 → `session.subscribe(listener)` 的返回值用于取消订阅

注意：流式期间调用 `prompt()` 若未指定 `streamingBehavior`（`"steer"` 或 `"followUp"`）会抛错；建议分别用 `steer()` / `followUp()`。

## 4. SessionManager

```typescript
SessionManager.inMemory();            // 不落盘（测试）
SessionManager.create(cwd);           // 新建持久化会话
SessionManager.continueRecent(cwd);   // 继续最近会话
SessionManager.open(path);            // 打开指定 JSONL
SessionManager.list(cwd);             // 当前项目会话列表
SessionManager.listAll(cwd);          // 全部会话列表
sm.branch(entryId);                   // 从历史节点分叉（历史编辑重跑）
sm.branchWithSummary(entryId, summary);
sm.createBranchedSession(leafId);     // 提取分支为新会话
```

needs.md §4.1「会话存储：Pi JSONL 会话文件」对应 `SessionManager.create` / `open` / `continueRecent`。会话管理 API（needs.md §4.2 的列表/删除/重命名/导出）对应：列表 `list`/`listAll`；删除即删除 `.jsonl` 文件；重命名 `appendSessionInfo(name)`/`getSessionName()`；导出即读取 JSONL 的 `getEntries()`/`getTree()`。历史编辑重跑对应 `navigateTree`（AgentSession）/`branch`（SessionManager）。

## 5. ModelRuntime

```typescript
const modelRuntime = await ModelRuntime.create({
  authPath,        // 凭证文件（独立，避免继承个人配置）
  modelsPath,      // 模型文件
  credentials,     // 或注入 InMemoryCredentialStore
  allowModelNetwork,
  modelRefreshTimeoutMs,
});

modelRuntime.getModel(providerId, modelId); // 按 provider/id 取模型
await modelRuntime.getAvailable();          // 已配置鉴权的可用模型
await modelRuntime.setRuntimeApiKey(provider, key); // 运行时密钥（不落盘）
await modelRuntime.refresh({ allowNetwork, force, signal }); // 刷新目录
```

密钥从环境变量读取后，通过 `setRuntimeApiKey` 注入，不写盘、不落日志；会话结束在 `finally` 中调用 `removeRuntimeApiKey(providerId)` 清除（覆盖异常/abort 路径），避免凭证残留（needs.md §7 安全要求）。`login()` / `logout()`：OAuth 登录/登出（needs.md §7 用户自定义模型的 OAuth 方式，交互式授权、token 入库）。用户 OAuth/API key 必须注入 KMS 加密的 `CredentialStore`，`authPath`（auth.json）不得用于用户凭证，避免明文落盘。

## 6. 自定义工具（Pi 结构化工具）

```typescript
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

const myTool = defineTool({
  name: "my_tool",
  label: "My Tool",
  description: "用途与权限说明",
  parameters: Type.Object({
    input: Type.String({ description: "输入值" }),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text", text: `Result: ${params.input}` }],
    details: {},
  }),
});

const { session } = await createAgentSession({
  customTools: [myTool],
  tools: ["read", "my_tool"], // 自定义工具名需列入 tools 白名单
});
```

needs.md §4.3 的「工具注册表」「读/写/执行类别」在实现时映射为 `defineTool` 的 `description` 与 `execute` 内部约束；能力启用开关决定是否把工具加入 `customTools` 和 `tools`。

## 7. ResourceLoader 与系统提示词

needs.md §7「固定系统提示词、不加载个人全局配置」要求只从 manifest 注入受控资源，禁止加载仓库或个人的未声明配置。

⚠️ `DefaultResourceLoader` 默认会自动发现 `<cwd>/.pi/extensions`、skills、prompts、`AGENTS.md`、themes，以及 `agentDir` 下的全局资源——直接使用会加载未声明的扩展与上下文文件。必须：

- 使用**不做自动发现的自定义 `ResourceLoader`**（只返回 manifest 声明的资源）；或
- 完整禁用 `DefaultResourceLoader` 的 extensions / skills / prompt-templates / themes / context-files 发现（清空各类 override），并清空 append-system-prompt。

系统提示词通过 `systemPromptOverride` 按已启用能力组合生成并冻结，固定不变。

## 8. SettingsManager

```typescript
SettingsManager.create(cwd?, agentDir?);   // 从文件加载
SettingsManager.inMemory(settings?);       // 内存（测试）
settingsManager.applyOverrides({ compaction: { enabled: false } });
await settingsManager.flush();             // 持久化边界
settingsManager.drainErrors();             // 读取设置 I/O 错误
```

## 9. 事件与 SSE 映射

SDK 原生事件（`session.subscribe` 收到的 `AgentSessionEvent`）：

- `message_update`：`assistantMessageEvent.type === "text_delta"` 或 `"thinking_delta"`
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `message_start` / `message_end`
- `agent_start` / `agent_end`
- `turn_start` / `turn_end`
- `queue_update`（`steering` / `followUp`）
- `compaction_start` / `compaction_end`、`auto_retry_start` / `auto_retry_end` 等

needs.md §4.2 的 SSE 事件是**服务层协议**，需在 subscribe 回调里翻译：

| SDK 事件 | SSE 事件 |
|---|---|
| `message_update`(`text_delta`) | `text_delta` |
| `tool_execution_start` | `tool_start` |
| `tool_execution_update` | `tool_update` |
| `tool_execution_end` | `tool_end` |
| `agent_start` / `turn_start` | `status` |
| `agent_end`（成功） | `completed` |
| `abort()` 调用或异常 | `aborted` / `error` |

`queued`、`completed`、`aborted`、`error` 无直接 SDK 事件：`queued` 由服务层在任务进入模型队列时产生；`completed`/`aborted`/`error` 根据 `agent_end`、异常与 `abort()` 调用在服务层合成。

## 10. 内置工具名（用于禁用）

- 内置工具名：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`
- 默认内置：`read`、`bash`、`edit`、`write`
- `noTools: "all"`：禁用全部工具
- `noTools: "builtin"`：只禁用默认内置，保留扩展与自定义工具
- `excludeTools`：在 `tools` 白名单之后按名禁用

needs.md §4.3「默认只读，不启用内置 `bash`/`edit`/`write`」实现为：未配置时使用 `tools: ["read", "ls", "find", "grep"]`；需要完全禁用内置工具时使用 `noTools: "all"`（或显式传入空白名单），并显式列出能力声明的 `customTools`。
