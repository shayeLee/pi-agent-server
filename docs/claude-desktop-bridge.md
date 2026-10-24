# Claude Desktop 桥接 MCP 设计

> 状态：第一版已实现（`src/claude-bridge/`）。开发后端 8080 用真实模型联调通过；正式后端 8082 的部署副本已生成，只做了只读检查。`pi-dev` 与 `pi` 两个连接器都已注册到 Code tab。

## 1. 目标

让 Claude Desktop 通过 MCP 调用 pi-agent-server：Claude 主导工作，把耗时、可以用便宜模型做、或者需要完整留痕的活委派给 Pi 会话。委派出去的会话和 Web UI 里的会话是同一批，用户可以在 Web 上看全过程、接着聊。

方向是 **Claude 调用 Pi**。不在 server 里加 Claude 适配器（见 2026-10-22 的方向决定）；Pi 调用 Claude 仍走现有的 `integrations/agent-team/claude-sdk`。

不做的事：

- 不改 server 的路由、数据库和 SSE 契约；桥接只是 v1 公共 API 的又一个客户端。
- 不暴露管理类能力（共享 MCP、模型登录、Agent 设置、项目信任、删除项目或会话）。
- 不实现 ACP；以后要接 Zed / JetBrains 时另做。

## 2. 总体结构

```
Claude Desktop ──stdio MCP──> pi-bridge（本机 Node 进程）──HTTP/SSE──> pi-agent-server
                                   │                                   (8080 开发 / 8082 正式)
                                   └─ 复用 src/client：ApiClient + consumeSse
```

- 运行方式：stdio MCP server，由 Claude Desktop 按需启动，一个连接器一个进程。
- 代码位置：`src/claude-bridge/`，入口 `src/claude-bridge/main.ts`；单独的 `tsconfig.bridge.json` 编译到 `dist-bridge/`（`pnpm build:bridge`），沿用仓库里 migrate、backup 等独立入口的做法。
- 依赖：不加新依赖。MCP 服务端协议自己实现（`mcp-server.ts`、`stdio-transport.ts`，只有 initialize、ping、tools/list、tools/call 和取消通知），JSON-RPC 类型与协议版本常量来自已有的 `@earendil-works/pi-mcp`。没用官方 `@modelcontextprotocol/sdk`，是因为它会带进 express、hono、jose 等十几个依赖，而这里只需要 stdio。HTTP 和 SSE 全部用 `src/client`，不另写一套；`ApiClient.abort` 为此加了可选的 `requestId`。

## 3. 两套后端

| 用途 | 后端 | 连接器名 | 说明 |
| --- | --- | --- | --- |
| 开发测试 | `http://127.0.0.1:8080` | `pi-dev` | 开发服务，Claude 可随意建会话、跑任务；Web 在 5173 |
| 正式使用 | `http://127.0.0.1:8082` | `pi` | `.pi/local-deploy` 的正式部署；Web 在 5180 |

桥接本身不写死端口，只读环境变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PI_BRIDGE_BASE_URL` | 是 | 后端地址，如 `http://127.0.0.1:8080` |
| `PI_BRIDGE_TOKEN_FILE` | 否 | Bearer token 文件路径；后端开了 `tokenRequired`，或后端是 `accounts` 模式（放个人 token，见第 4 节）时需要。不接受直接写 token 的变量，免得 token 出现在 Claude 的配置文件里 |
| `PI_BRIDGE_LABEL` | 否 | 显示在工具说明里的后端名，如 `dev` / `正式`；不设时用地址里的主机和端口 |
| `PI_BRIDGE_WEB_URL` | 否 | Web UI 地址，如 `http://127.0.0.1:5173`；设了才在结果里给会话链接 `webUrl` |
| `PI_BRIDGE_WAIT_SECONDS` | 否 | `pi_send` / `pi_wait` 单次最多等多久，默认 120 |
| `PI_BRIDGE_PROJECTS` | 否 | 允许操作的项目 id 列表（逗号分隔）；不设时不限制 |

启动时先请求 `GET /v1/access`，`canWrite` 为假就在每个写类工具里直接报错，并说明原因。

## 4. 身份与权限

下面说的是默认的 `ip` 模式。后端改成 `accounts` 模式（[登录设计](login-design.md)）后，桥接不再靠 `127.0.0.1` 拿身份，而是用个人 token：

- 用 `pnpm accounts -- issue-token --name <账号> --label bridge` 签发（输出里的明文只显示一次），写进一个 `0600` 的文件，`PI_BRIDGE_TOKEN_FILE` 指向它。
- 桥接建的会话属于这个账号，和这个账号在浏览器里看到的是同一批；权限是账号的角色，不再固定是 admin。
- 吊销 token、禁用账号或恢复备份后（恢复会吊销恢复出来的全部 token），桥接请求会得到 401，要重新签发并换上新文件。

`ip` 模式下两套后端的 IP 策略都是 `127.0.0.1 → admin`，没有 token。桥接从本机连过去，所以：

- **会话归属**：桥接建的会话属于 `127.0.0.1`，和本机打开的 Web UI 是同一个 owner，所以在 5173 / 5180 上都能直接看到、接着聊。
- **权限偏大**：桥接拿到的是 admin。限制只能靠桥接自己：只提供第 5 节列出的工具，不转发任意请求，也不提供删除。
- **Pi 工具全开**：委派出去的会话默认可以用 `bash`、`edit`、`write`，跟在 Web 上用一样。这是现有部署的边界，桥接不改变它；要限制就在后端设 `TOOLS` 白名单。

## 5. 工具清单

工具名统一加 `pi_` 前缀。返回内容都是给模型读的精简文本加结构化 JSON，不原样转发大块数据。

### 5.1 查询类

| 工具 | 参数 | 做什么 |
| --- | --- | --- |
| `pi_list_projects` | 无 | 列出项目：id、名字、目录、能否建会话 |
| `pi_list_models` | `projectId?` | 列出可用模型和默认模型 |
| `pi_list_sessions` | `projectId?`、`limit?`（默认 20） | 按最近更新排序列出会话：id、标题、模型、更新时间、是否原生共享会话 |
| `pi_get_session` | `sessionId`、`tail?`（默认 6）、`includeTools?` | 读会话记录（`GET /export`），只返回最后 `tail` 条消息；工具调用默认只给名字和状态，`includeTools: true` 时附带截断后的参数 |

### 5.2 执行类

| 工具 | 参数 | 做什么 |
| --- | --- | --- |
| `pi_create_session` | `title`、`projectId?`、`model?`、`thinkingLevel?` | 建会话，必要时再改模型和思考档位。标题必填，前面自动加 `[Claude] `，方便在 Web 上认出来；有了标题，服务端就不会再自动起标题 |
| `pi_send` | `sessionId`、`prompt`、`wait?`（默认 `true`）、`requestId?` | 提交消息。`wait` 为真时一直等到这轮结束或超时（见第 6 节） |
| `pi_wait` | `requestId` | 继续等一个还没结束的任务，规则同 `pi_send` |
| `pi_steer` | `sessionId`、`text` | 引导正在运行的任务 |
| `pi_abort` | `sessionId`、`requestId` | 中止任务；带上 `requestId`，只中止这一轮，不会误停别人在 Web 上发起的新任务 |

### 5.3 不提供的

删除会话或项目、改共享 MCP、模型登录、Agent 设置、项目信任、上传附件、扩展命令和对话框。需要时由用户在 Web UI 上操作。

## 6. 发送和等待

`pi_send` 的流程：

1. 生成 `requestId`（调用方传了就用传的，方便重试时去重）。
2. 先读 `GET /export` 拿到当前的 `lastEventId`，再以这个游标订阅 `GET /events`，然后提交 `POST /messages`。顺序不能反，否则可能漏掉开头的事件。
3. 只看 `requestId` 一致的事件。遇到 `completed`、`error` 或 `aborted` 就结束；中途记下工具调用次数和最后的 `usage`。
4. 结束后再读一次 export，取最后一条用户消息之后的最后一条助手消息作为回复（比拼接 `text_delta` 更可靠，也和 Web 上看到的一致）。export 里的 `turnId` 是用户消息的记录 id，不是 `requestId`，所以按位置找。
5. 超过 `PI_BRIDGE_WAIT_SECONDS` 还没结束，就返回 `status: "running"` 和 `requestId`，任务在 Pi 那边继续跑。桥接在后台继续订阅这一轮直到结束，`pi_wait` 直接拿后台的结果，不会漏事件；结束的结果保留 1 小时。桥接进程重启后，之前的 `requestId` 就查不到了，改用 `pi_get_session` 看记录。

返回内容：

```json
{
  "status": "completed | error | aborted | running | queued",
  "requestId": "…",
  "sessionId": "…",
  "reply": "最后一条助手消息（太长时截断，并注明总长度）",
  "error": "status 为 error 时的原因",
  "toolCalls": 7,
  "elapsedSeconds": 42,
  "webUrl": "设了 PI_BRIDGE_WEB_URL 才给"
}
```

`toolCalls` 只数顶层工具调用，codemode 脚本里的嵌套调用不算。还在跑的时候返回 `toolCalls`、`lastTool` 和 `hint`，不返回 `reply`。

边界情况：

- 会话正忙：`POST /messages` 返回 `queued` 时照实报告排队位置，继续等，超时规则不变。
- SSE 断开：按 `lastEventId` 自动重连；服务重启（epoch 变化）时这一轮直接记为 `error`，提示去看记录。
- `409`（同一个 `requestId` 内容不同）：直接报错，不重试。
- 网络失败：报错并带上 `requestId`，调用方可以用同一个 `requestId` 重试。

## 7. 输出大小

MCP 返回的内容会进 Claude 的上下文，所以默认要省：

- `reply` 默认最多 8000 字，超出截断并注明。
- `pi_get_session` 默认只给最后 6 条消息，每条最多 2000 字；工具参数和结果默认不给。
- 需要完整记录时，告诉 Claude 去 Web UI 看，或者分页多次读。

## 8. 在 Claude Desktop 里注册

Code tab 和普通对话读的是两份配置，两边都要用时各加一次：

- **Code tab**：用 `claude mcp add`，user 作用域，名字分别是 `pi-dev` 和 `pi`，`--env PI_BRIDGE_BASE_URL=…`。
- **普通对话**：在 `claude_desktop_config.json` 的 `mcpServers` 里加同样两项。

先构建，再在 Code tab 注册 `pi-dev`：

```bash
pnpm build:bridge
```

```bash
claude mcp add --scope user pi-dev -e PI_BRIDGE_BASE_URL=http://127.0.0.1:8080 -e PI_BRIDGE_LABEL=dev -e PI_BRIDGE_WEB_URL=http://127.0.0.1:5173 -- /Users/mz/.volta/bin/node /Users/mz/pi-agent-server/dist-bridge/claude-bridge/main.js
```

node 要写绝对路径：Claude Desktop 从图形界面启动，PATH 里不一定有 Volta。

注册后新开的 Code tab 会话里就能用 `pi_*` 工具。改了桥接代码要重新 `pnpm build:bridge`，并新开会话（MCP 进程在会话开始时启动）。正式的 `pi` 连接器见第 9 节。

## 9. 正式部署的构建产物

正式用的 `pi` 连接器不跟着开发中的代码变（选了方案 A）：

- `pi-dev` 指向仓库里的 `dist-bridge/`，`pnpm build:bridge` 后立即生效。
- `pi` 指向 `.pi/local-deploy/bridge/` 的副本。`.pi/local-deploy/start.command` 在构建服务和 Web UI 时一并执行 `pnpm run build:bridge`，再把 `dist-bridge/` 同步到 `bridge/`，所以正式桥接和正式服务一起更新。部署运行中 `start.command` 会拒绝执行，副本也就不会在运行中被替换。
- 副本里只有编译产物，`@earendil-works/pi-mcp` 沿目录向上从仓库的 `node_modules` 解析，和 `server/` 副本一样。

注册 `pi`：

```bash
claude mcp add --scope user pi -e PI_BRIDGE_BASE_URL=http://127.0.0.1:8082 -e PI_BRIDGE_LABEL=正式 -e PI_BRIDGE_WEB_URL=http://127.0.0.1:5180 -- /Users/mz/.volta/bin/node /Users/mz/pi-agent-server/.pi/local-deploy/bridge/claude-bridge/main.js
```

## 10. 测试

- 单元测试（vitest）：注入假的 fetch，覆盖等待成功、超时返回 `running`、`pi_wait` 接续、排队、`error` / `aborted`、SSE 断线重连、`requestId` 去重、输出截断、`PI_BRIDGE_PROJECTS` 限制、`canWrite` 为假。
- 真实联调：只连 8080，用 `openai/gpt-6-luna` 建会话、发消息、中途 steer、abort，再到 5173 上确认会话可见。
- 正式后端 8082 不做自动化测试。

## 11. 已定（2026-10-22）

1. 第 9 节选 A：正式桥接用 `.pi/local-deploy/bridge/` 的副本；`pi-dev` 用仓库里的 `dist-bridge/`（源码在 `src/claude-bridge/`）。
2. `pi_send` 可以发到任何可见的会话（包括 Web 上建的和 Pi 原生会话）；发到不是桥接建的会话时，返回里提醒一句。
3. 第一版只注册到 Claude Desktop 的 Code tab，普通对话以后再加。

## 12. 后续

- 方案二：统一 Claude 和 Pi 共用的 skills 与上下文文件。
- 方案三：用 Claude Desktop 定时任务，借桥接读用量报表和失败会话，生成摘要。
