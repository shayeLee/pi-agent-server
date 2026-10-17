# MCP 接入设计

> 状态：P0、P1、P2 已实现（2026-10-17），P3 另行设计。本文记录 pi-agent-server 接入 MCP（Model Context
> Protocol）server 与 codemode 的方案、已确认的决策和分阶段计划。代码事实基于 Pi SDK
> `@earendil-works/pi-coding-agent@1.3.0`。实现位于 `src/mcp/`、`src/agent/mcp-tool-boundary.ts`
> 与 `src/storage/kysely-project-mcp-repository.ts`。

## 1. 目标与范围

目标：

- 让会话能使用管理员登记的 MCP server，同时支持 stdio 与 streamable HTTP 两种传输。
- 配置分两层：管理员维护的**全局目录**，以及项目 owner 自选的**项目级配置**。
- 多用户共享部署下，MCP 不打开新的越权路径：工具白名单、项目归属与角色都继续生效。
- codemode 的嵌套工具调用在 Web UI 与公开 API 中可见，实时流与历史回放一致。

非目标（本期不做）：

- MCP OAuth 登录、按用户绑定的 MCP 凭证。
- 读取项目目录或个人目录下的 `mcp.json`。
- 运行期热更新全局目录（第一版修改目录需要重启服务）。
- MCP resources 之外的 prompts、sampling 等协议能力。

## 2. SDK 现状

以下行为决定了方案的形状：

| 事实 | 位置 | 影响 |
|---|---|---|
| SDK 默认不加载 MCP 与 codemode；CLI 才把它们作为内置扩展加载，SDK 使用方需显式传 `createMcpExtension()` / `createCodemodeExtension()` | `dist/extensions/index.js`、`dist/extensions/codemode/index.d.ts` | 服务端现为 `noExtensions: true`（`src/server/provider-extensions.ts`），目前 MCP 完全关闭 |
| MCP 扩展默认 `loadConfig` 读取 agentDir 的 `mcp.json` 和受信项目的 `.pi/mcp.json` | `dist/extensions/mcp/index.d.ts` | 服务 agentDir 默认与个人 `~/.pi/agent` 一致，必须覆盖 `loadConfig` |
| MCP server 默认 exposure 为 `codemode`；server 连上后 MCP 扩展会自动激活 `codemode` 工具 | `dist/core/mcp-servers.js`、`docs/mcp.md` | 接 MCP 后 codemode 是默认路径，需决定的是 exposure 策略 |
| MCP 连接按扩展实例存在：`session_start` 连接，`session_shutdown` 关闭 | `dist/extensions/mcp/index.js` | 宿主每个活动会话一个 loader，stdio 进程数 = 活动会话数 × stdio server 数 |
| 探针会话不调用 `bindExtensions` | `src/agent/pi-agent-session-factory.ts` | 探针不会建立 MCP 连接 |
| SDK `tools` 白名单中没有 `mcp__` 开头的条目时，MCP 工具仍保持注册，codemode 与 `tool_search` 可达 | `dist/core/sdk.d.ts` | 现有 `TOOLS` 白名单挡不住 codemode 里的 MCP 调用 |
| 嵌套调用只能到达 `codemode`/`deferred` exposure 的工具，或已激活的 `direct` 工具 | `dist/core/agent-session.js` | 内置工具（`direct`）不受影响，问题只在 MCP |
| 嵌套调用走完整工具管线，`tool_call` / `tool_result` hook 同样生效，事件带 `parentToolCallId` | `dist/core/nested-tool-calls.js` | 宿主可在 hook 中统一拦截、排队 |
| codemode worker 全进程上限 `MAX_CONCURRENT_CODEMODE_WORKERS = 2`，模块级共享、不可配置；超限立即报错而非排队；每个 worker 堆 256MB；默认无超时 | `dist/extensions/codemode/execute.js` | 多用户下需宿主准入控制和强制超时 |
| codemode 的 `models` 全局默认开启，脚本可调用模型目录中的分类器、图像模型 | `dist/extensions/codemode/index.d.ts` | 会以服务端 provider 凭证产生调用，需关闭 |
| `bash` 子进程环境为完整 `process.env`（`getShellEnv()` 展开 `process.env`） | `dist/core/tools/bash.js`、`dist/utils/shell.js` | 授予 `bash` 的用户能读取服务进程的全部环境变量 |
| 宿主 SSE 翻译丢弃 `parentToolCallId` | `src/agent/translate.ts` | 嵌套调用在实时流中显示为顶层工具卡片，回放时又被过滤，二者不一致 |

## 3. 已确认的决策

1. 同时支持 stdio 与 HTTP 两种传输。
2. 同时提供全局配置与项目级配置。
3. 部署形态为多用户共享。
4. `user` 角色的项目 owner 可以在自己的项目中启用全局目录里的 server，无需管理员审批。

## 4. 配置模型

### 4.1 全局目录（管理员）

由 `PI_MCP_CATALOG_FILE` 指定绝对路径的严格 JSON 文件；未设置时不加载 MCP 与 codemode 扩展，行为与现在完全一致。
格式错误、未知字段或相对路径都阻止启动。

```json
{
  "version": 1,
  "servers": {
    "docs": {
      "url": "https://docs.example.com/mcp",
      "headers": { "Authorization": "Bearer ${secret:DOCS_TOKEN}" },
      "description": "Search and read the product documentation",
      "maxExposure": "direct",
      "exposure": "codemode",
      "toolExposure": { "search": "direct" },
      "defaultEnabled": true
    },
    "repo-tools": {
      "command": "uvx",
      "args": ["repo-tools-mcp", "--root", "${PROJECT_CWD}"],
      "description": "Inspect repository metadata",
      "maxExposure": "codemode",
      "toolExposure": { "delete_*": "hidden" },
      "adminOnly": false,
      "defaultEnabled": false
    }
  }
}
```

字段：

- 连接字段沿用 Pi `McpServerConfig`：stdio 用 `command`/`args`/`env`/`cwd`，HTTP 用 `url`/`headers`，以及 `timeout`。拒绝 SSE 与 `oauth`。
- `description`：必填。用于系统提示中的 `mcp_servers` 段落、`searchTools()` 排序和 `describeNamespace()`。
- `maxExposure`：项目可设置的 exposure 上限，默认等于 `exposure`。
- `exposure` / `toolExposure`：目录给出的默认值。`toolExposure` 中的 `hidden` 是硬限制，项目不能放开。
- `adminOnly`：默认 `false`；为 `true` 时只有 admin 能在项目中启用。
- `defaultEnabled`：新项目与未配置的项目是否默认启用，默认 `false`。
- 占位符：`${secret:NAME}` 从密钥文件读取（见第 7 节）；`${PROJECT_CWD}` 由宿主替换为会话项目 cwd。stdio 的相对 `cwd` 按项目 cwd 解析，不使用 SDK 的“相对会话目录”规则。
- server 名称规则沿用 Pi：只允许字母、数字、`_`、`-`，仅 `-`/`_` 不同的名称视为同一个。

宿主通过 `createMcpExtension({ loadConfig })` 注入合成后的配置，并设置 `projectTrusted: false`、`updateConfig` 为 no-op、`openUrl` 直接报错。任何路径都不读取 `~/.pi/agent/mcp.json`、`<agentDir>/mcp.json` 或 `<project cwd>/.pi/mcp.json`。

### 4.2 项目级配置（项目 owner）

存储在数据库，挂在项目上：

| 列 | 说明 |
|---|---|
| `project_id` | 外键，项目删除时级联删除 |
| `server_name` | 目录中的 server 名称 |
| `enabled` | 是否启用 |
| `exposure` | 可选，覆盖目录默认值，不超过 `maxExposure` |
| `hidden_tools` | JSON 数组，在本项目隐藏的工具（server 原工具名，精确匹配） |
| `updated_at` / `updated_by` | 审计字段 |

需要按 `docs/database-design.md` 的迁移注册表新增迁移，SQLite 与 PostgreSQL 同步。

项目级配置**只能引用目录里已有的 server**，并且只能收紧，不能新增 server 或放宽权限。目录中已删除的 server 对应的行保留但忽略，API 返回时标记为 `missing`。

### 4.3 exposure 收紧顺序

`direct` > `codemode` = `deferred` > `hidden`。

- 项目设置的 exposure 不能高于 `maxExposure`。
- `codemode` 与 `deferred` 同级，项目可以在二者之间切换：`deferred` 适合不擅长写 JS 的模型。
- 目录 `toolExposure` 中的 `hidden` 不可被项目覆盖；其余工具级覆盖同样受 `maxExposure` 约束。
- 项目设置了 server 级 exposure 时，它同时是目录工具级覆盖的上限：例如项目选 `codemode`，目录里 `direct` 的工具也降为 `codemode`；选 `hidden` 则全部隐藏。
- 项目级的工具设置只能隐藏（`hidden_tools`），不能给单个工具指定其他 exposure，避免与目录的通配规则互相覆盖。

### 4.4 权限

| 操作 | 允许 |
|---|---|
| 查看项目 MCP 配置 | 项目可见者（含 viewer） |
| 启用、停用、收紧普通 server | 项目 owner（`user` 或 `admin`），需要 `write` 档位 |
| 启用 `adminOnly` server | admin |
| 修改默认项目的 MCP 配置 | 仅 admin（默认项目由所有用户共享） |
| 修改全局目录 | 服务器上的管理员（编辑文件并重启） |

新增路由按 `src/server/route-rbac.ts` 的方式显式声明 permission，沿用 owner 隔离。

### 4.5 生效时机

在会话 adapter 创建时（新建或恢复）对“目录 + 项目配置”做快照，与工具白名单相同。修改项目配置只影响之后创建或恢复的会话，不改变正在运行的会话。恢复的会话如果引用了已停用的工具，调用时返回工具错误，不中断会话。

## 5. exposure 策略

| 场景 | 建议 |
|---|---|
| 一般 server | `codemode`（默认） |
| 少量高频工具 | `toolExposure` 设为 `direct` |
| 删除、写入、付费等危险工具 | `hidden`；或整个 server 设为 `hidden`，只放行个别工具 |
| 工具很多，但项目常用模型不擅长写 JS | 项目切换为 `deferred` |

codemode 扩展配置：`mode: "on"`（内置工具保持声明），`models: false`。`inlineBudget` 使用默认的 3000。

## 6. 工具授权边界

会话最终可用的 MCP 工具：

```
全局目录 ∩ 项目已启用的 server ∩ exposure 收紧结果 ∩ TOOLS 白名单（如设置）
```

`TOOLS` 三种模式（`src/main.ts`、`src/application/ports/tool-authorization-policy-port.ts`）：

- **all**（未设置 `TOOLS`）：不限制工具名，MCP 是否可用完全由项目启用状态决定。
- **allowlist**：白名单中没有 `mcp__*` 条目时，组合边界自动加上 `excludeTools: ["mcp__*"]`；有条目时按 SDK 规则只保留匹配的 MCP 工具。`codemode` 与 `tool_search` 也必须显式列出才会启用。
- **disabled**（`TOOLS` 为空）：SDK 同时关闭 MCP。

纵深防御：新增一个宿主内置扩展，在 `tool_call` hook 中按会话快照校验 `mcp__*` 调用，不在授权集合内就 `block`。嵌套调用同样经过这个 hook，所以即使 SDK 以后调整白名单语义，边界也不会被打开。`src/server/start.ts` 中“SDK 的 MCP exposure 边界不在此收紧”的注释要相应更新。

## 7. 凭证

- MCP 密钥放在 `PI_MCP_SECRETS_FILE`（绝对路径、权限 `0600` 的严格 JSON，启动时校验权限），通过 `${secret:NAME}` 引用。密钥只注入给 MCP 子进程的 env 和 HTTP header，**不写入服务进程的 `process.env`**。
- 目录中的凭证是**共享身份**：所有启用该 server 的用户在外部系统中都表现为同一身份。管理员只应把对全体用户安全的 server 放进目录，高权限 token 的写操作用 `toolExposure: hidden` 去掉。
- **已知限制**：`bash` 子进程继承完整 `process.env`，并以服务进程用户运行。在 all 模式或授予 `bash` 的部署中，用户可以读取服务进程可读的任何文件，包括密钥文件；provider API key 等现有环境变量也已经可读。真正的凭证隔离需要不授予 `bash`，或者让 `bash` 运行在独立用户或沙箱中。这项风险需写入 README 的“Current boundaries”（中英双语同步）。

## 8. 进程与连接管理

实现前验证的结论：SDK 的 `McpClient` 对每个 transport 单独执行 `initialize`，`createTransport` 只是“为一个连接造一个传输”的工厂，多个会话无法共用同一个 MCP 会话。因此采用原定的退路，不做跨会话连接池：

- **按会话建连**：会话启动时为它启用的每个 server 建一个连接，会话结束时关闭。
- **stdio 全局上限**：`PI_MCP_MAX_STDIO_PROCESSES`（默认 32）限制全服务同时运行的 MCP 进程数。达到上限时，新会话的这个 server 连接失败并提示，不阻塞会话启动。
- **宿主自己的 transport**：不使用 SDK 默认 transport（它会继承服务进程 env，并把 `${NAME}` 与 `!cmd` 解析为环境变量和 shell 命令）。连接参数始终取自目录；子进程只继承 `PATH`、`HOME`、`LANG`、`LC_ALL`、`TMPDIR`、`TZ`，加上目录声明并替换了占位符的变量。HTTP 不接 SDK 的 OAuth provider，401 直接作为连接错误。
- HTTP 连接的并发请求数暂不限制；指标（活动进程数、连接失败数、调用耗时）留到后续接入 `/metrics`。

## 9. codemode 并发与超时

- **准入排队**：宿主扩展在 `codemode` 的 `tool_call` hook 中获取一个进程级信号量（容量 2，与 SDK 上限一致），在 `tool_result` 中释放。排队有最长等待时间，超时后 `block` 并返回可读原因。排队数与等待时长纳入现有并发控制和指标。
- **强制超时**：同一 hook 中改写 `event.input`：脚本没有 `// @options` 首行时注入 `timeout_ms`（默认 120000，可配置）；已有的值钳到上限。用户停止会话时走现有 abort 路径。
- **资源上限**：最坏情况下额外占用 2 × 256MB 的 QuickJS 堆，在运维文档中说明。

## 10. Web UI 与公开 API

- SSE 的 `tool_start` / `tool_update` / `tool_end` 增加可选字段 `parentToolCallId`（只新增字段），同步更新 `src/public-api/openapi-v1.ts` 与 `openapi/v1.json`。
- 主时间线：codemode 显示为一张卡片，内容包括默认折叠的脚本（代码高亮）、输出，以及“内部调用 N 次”的折叠列表（工具名、状态、耗时、错误摘要）。嵌套事件只更新父卡片，不单独占一行。
- 回放：从工具结果消息的 `nestedCalls` 或 codemode 结果的 `details.calls` 重建同一视图，保证与实时显示一致。SDK 最多记录 256 次调用，超出时显示“记录不完整”。
- Inspector（`SessionSteps`）已带 `parentToolCallId`，按父子关系缩进显示。
- 项目设置页新增 MCP 面板：列出目录中的 server、启用状态、exposure，以及 `adminOnly` 和共享身份的标记。

P2 实现说明：

- 实时：`src/client/chat-state.ts` 把带 `parentToolCallId` 的事件记到所属卡片的 `nested` 上，不新增时间线条目。嵌套调用再发起的调用（父 ID 是某个嵌套 ID）记到同一张卡片。找不到所属卡片时退回为独立卡片。父调用结束时仍在运行的嵌套调用标为 `unfinished`，记录标为不完整。
- 回放：导出的 `tool_result` 行新增可选 `nestedCalls`（形状同 SDK 的 `NestedToolCalls`，参数经过与工具参数相同的脱敏），Web 历史投影把它还原成同一个 `nested` 字段，所以实时与刷新后显示同一个列表。耗时来源不同：实时取 `tool_end.durationMs`，回放取 SDK 记录的耗时，两者可能差几毫秒。
- 卡片：任何带嵌套调用的工具卡片标题都以“内部调用 N 次”开头，展开后在结果下方显示折叠列表（状态、工具名、耗时、错误摘要、参数过大未记录的说明）。codemode 的脚本默认折叠，展开后按 JavaScript 高亮。
- 面板：侧栏项目行在服务配置了目录时显示“MCP 服务”按钮。每个 server 一张表单（启用、提供方式、隐藏的工具），单独保存。GET 返回的每个 server 带 `canEnable`，调用者不能启用的 `adminOnly` server 开关置灰；viewer 和非 admin 看共享的默认项目时整个面板只读。

## 11. 分阶段计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 边界 | allowlist 自动排除 `mcp__*`；`tool_call` 兜底拦截；`translate.ts` 透传 `parentToolCallId`；README 写明 bash 环境变量风险 | allowlist 下未授权 MCP 工具无论直接调用还是从 codemode 调用都被拒；all 模式行为不变；嵌套事件带父 ID |
| P1 接入 | 全局目录与密钥文件解析；项目级配置表、迁移 v4、API 与权限；MCP/codemode 扩展接入（`models: false`）；按会话建连 + stdio 全局上限；codemode 排队与超时 | 未配置目录时行为与现在一致；不读取任何 `mcp.json`；`user` 能启用普通 server、不能启用 `adminOnly` 或修改默认项目；stdio 进程数不超过上限；第 3 个并发脚本排队而不是报错 |
| P2 UI | codemode 卡片与嵌套调用列表；项目 MCP 设置面板 | 实时显示与刷新回放一致；viewer 只读 |
| P3 后续 | 按用户绑定凭证、OAuth、目录热更新、按模型覆盖 exposure | 另行设计 |

每个阶段遵循 `docs/testing.md`，SQLite 与 PostgreSQL 两种存储都要覆盖。

## 12. 待定问题

- 是否需要给每个用户或项目设置 MCP 调用的速率或配额。
- HTTP server 的并发请求上限与 MCP 指标（第 8 节）。

已解决：

- `createTransport` 不能跨会话复用连接，见第 8 节。
- 项目 MCP 设置存在 `project_mcp_servers` 表中，按 `project_id` 挂在项目上：备份随数据库一起保存，owner 转移不改 `project_id` 所以设置跟着项目走，删除项目时级联删除。
- `adminOnly` 只在启用时检查：管理员之后把已启用的 server 改成 `adminOnly`，已有的项目设置继续生效，需要管理员自行停用或从目录中移除。
