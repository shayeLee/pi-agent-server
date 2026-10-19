# MCP 接入设计

> 状态：P0、P1、P2 已实现（2026-10-17）；P3 的按用户凭证与 OAuth（以动态客户端注册为主）P3-0 至 P3-4 已实现（2026-10-18），见第 13 节；P3-6（共享 MCP 改用 Pi 的 mcp.json、个人 MCP）见第 14 节，其中 P3-6a 已实现。本文记录 pi-agent-server 接入 MCP（Model Context
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

> 2026-10-18 起本节的目录文件 `PI_MCP_CATALOG_FILE` 与第 7 节的密钥文件 `PI_MCP_SECRETS_FILE` 已移除，共享 MCP 改为 Pi 的全局 `mcp.json`，见第 14.2 节。本节保留作为字段语义的说明。

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

在会话 adapter 创建时（新建或恢复）对“目录 + 项目配置 + 用户的连接”做快照，与工具白名单相同。正在回复的那一轮不受修改影响。

2026-10-19 补充：服务端不回收空闲会话的 adapter，所以只靠“恢复时生效”，已经打开过的会话要等服务重启才能用上新设置。现在改成：
- 每条消息提交前，比较会话创建时算出的 MCP server 列表（`effectiveMcpServerEntries` 的结果）和现在的。共享 `mcp.json`、项目设置、用户连接或断开，任何一个让列表变了，都算过期。
- 过期且会话完全空闲（没有进行中、排队的任务，没有在跑的后台子代理，控制队列为空，没有待送达的通知）时，`RuntimeRegistry.refreshIfOutdated` 用同一份对话记录建一个新 runtime，沿用原来的事件总线，SSE 连接和事件游标不受影响，然后释放旧的。
- 先建新的再换：新的建不成就继续用旧的；建好时会话已经开始了别的工作，就丢掉新的，下一条消息再试。
- 原生共享会话持有可撤销的文件绑定，同时打开两份有风险，暂不这样处理，仍要等服务重启。
- 释放 adapter 时先发 `session_shutdown`（reason 用 `reload`），再 dispose SDK 会话。Pi 的 `dispose()` 自己不发这个事件，MCP 扩展就不会关闭 stdio 子进程，每换一次 adapter 或删一次会话都会留下一个进程。用 `reload` 而不是 `quit`，是因为收到 `quit` 的扩展会清掉会话的持久状态（如 model-failback 的封禁记录）。
- stdio server 默认在项目目录里启动。项目用 Volta 等工具锁定了旧版 Node 时，`npx` 会按项目的版本运行，要求新版 Node 的 server（如 chrome-devtools-mcp）会启动失败，会话里也就没有它的工具。这时在共享 MCP 里把这一项的工作目录设成 `~`。
- 会话里引用了已停用工具的旧消息照常保留；再调用时返回工具错误，不中断会话。

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

- （已移除，见第 14.2 节；现在凭证写成 `mcp.json` 里的环境变量 `${NAME}`。）MCP 密钥放在 `PI_MCP_SECRETS_FILE`（绝对路径、权限 `0600` 的严格 JSON，启动时校验权限），通过 `${secret:NAME}` 引用。密钥只注入给 MCP 子进程的 env 和 HTTP header，**不写入服务进程的 `process.env`**。
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
- 面板：服务配置了目录时，侧栏底部的“设置”菜单（与主题选项在一起）多出“MCP 服务”一项，打开当前项目的面板。每个 server 一行，以分隔线隔开：勾选启用，启用后才显示提供方式与禁用的工具；每项改动立即保存，失败时回到服务端的值并显示原因。GET 返回的每个 server 带 `canEnable`，调用者不能启用的 `adminOnly` server 开关置灰；viewer 和非 admin 看共享的默认项目时整个面板只读。

## 11. 分阶段计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 边界 | allowlist 自动排除 `mcp__*`；`tool_call` 兜底拦截；`translate.ts` 透传 `parentToolCallId`；README 写明 bash 环境变量风险 | allowlist 下未授权 MCP 工具无论直接调用还是从 codemode 调用都被拒；all 模式行为不变；嵌套事件带父 ID |
| P1 接入 | 全局目录与密钥文件解析；项目级配置表、迁移 v4、API 与权限；MCP/codemode 扩展接入（`models: false`）；按会话建连 + stdio 全局上限；codemode 排队与超时 | 未配置目录时行为与现在一致；不读取任何 `mcp.json`；`user` 能启用普通 server、不能启用 `adminOnly` 或修改默认项目；stdio 进程数不超过上限；第 3 个并发脚本排队而不是报错 |
| P2 UI | codemode 卡片与嵌套调用列表；项目 MCP 设置面板 | 实时显示与刷新回放一致；viewer 只读 |
| P3 后续 | 按用户凭证与 OAuth，以动态客户端注册为主（第 13 节）；目录热更新、按模型覆盖 exposure 另行设计 | 见第 13.11 节 |

每个阶段遵循 `docs/testing.md`，SQLite 与 PostgreSQL 两种存储都要覆盖。

## 12. 待定问题

- 是否需要给每个用户或项目设置 MCP 调用的速率或配额。
- HTTP server 的并发请求上限与 MCP 指标（第 8 节）。

已解决：

- `createTransport` 不能跨会话复用连接，见第 8 节。
- 项目 MCP 设置存在 `project_mcp_servers` 表中，按 `project_id` 挂在项目上：备份随数据库一起保存，owner 转移不改 `project_id` 所以设置跟着项目走，删除项目时级联删除。
- `adminOnly` 只在启用时检查：管理员之后把已启用的 server 改成 `adminOnly`，已有的项目设置继续生效，需要管理员自行停用或从目录中移除。

## 13. P3：按用户凭证与 OAuth（设计稿）

> 状态：2026-10-18 改为以动态客户端注册为主；P3-0 至 P3-4 已实现，P3-5（预注册客户端接 GitHub）未做。范围只包括“每个用户用自己的身份连 MCP server”；目录热更新、按模型覆盖 exposure 不在本节。

### 13.1 动机与原则

P1 的凭证是共享身份：目录里一份 token，所有启用该 server 的项目都以同一个身份访问外部系统。目标是让用户在 Web 上点“连接 Linear”，在自己的浏览器里完成授权，之后自己的会话用自己的 token。

本项目是开源的自托管服务，所以有一条硬约束：**部署者不应该为了接一个 MCP server 去对方平台注册应用**。因此以 MCP 授权规范中的动态客户端注册（DCR，RFC 7591）为主：服务端第一次发起授权时自动向授权服务器注册一个客户端，部署者只需在目录里写 server 地址。不支持 DCR 的 server（例如 GitHub）留给“预注册客户端”这条后备路径，见第 13.4 节。

### 13.2 已核实的外部事实

| 事实 | 来源 | 影响 |
|---|---|---|
| Linear 远程 MCP（`https://mcp.linear.app/mcp`）对无凭证请求返回 401，`WWW-Authenticate` 带 `resource_metadata` 和 `scope="read write"`；授权服务器 `https://mcp.linear.app` 的元数据有 `registration_endpoint`、`revocation_endpoint`，支持 `authorization_code`、`refresh_token`、PKCE `S256`、RFC 9207 `iss`，客户端认证方式含 `none`，并声明支持 Client ID Metadata Document | 2026-10-18 实测 | 走标准发现 + DCR 即可，无需任何预注册 |
| Notion 远程 MCP（`https://mcp.notion.com/mcp`）同样提供 `registration_endpoint`，元数据形状与 Linear 一致 | 2026-10-18 实测 | DCR 不是 Linear 特例，可作为第二个验证对象 |
| GitHub 远程 MCP 的授权服务器 `https://github.com/login/oauth` **没有 `registration_endpoint`**；官方 README 要求每个 host 自己注册 GitHub App 或 OAuth App | 2026-10-18 实测；github/github-mcp-server README | GitHub 只能走预注册客户端，P3 先不做 |
| Context7、DeepWiki 等公开 server 不需要认证 | 2026-10-18 实测 | 已用 Context7 在开发环境跑通 P1/P2 的真实调用，与本节无关 |
| Pi SDK `@earendil-works/pi-mcp` 1.3.0 提供完整流程：`authorizeMcp(provider, options)` 依次做发现、DCR（或 CIMD）、PKCE 授权跳转、用 `code` + `iss` 换 token，结果是 `REDIRECT` 或 `AUTHORIZED`；`adaptOAuthProvider(provider)` 把它变成 HTTP transport 的 `AuthProvider`，401 时刷新，并发 401 共用一次刷新，需要重新授权时抛 `McpOAuthAuthorizationRequiredError` | `dist/oauth/flow.d.ts`、`provider.d.ts` | 宿主不实现协议，只实现一个按“用户 × server”存取状态的 `OAuthClientProvider`，以及两个 HTTP 路由 |

P3-0 实测结果（2026-10-18，Linear，脚本直接调用 SDK 的 `authorizeMcp` / `adaptOAuthProvider` / `refreshAuthorization`）：

| 项目 | 结果 | 对设计的影响 |
|---|---|---|
| DCR 回调地址 | `http://192.168.1.10:5180/...`、`http://pi-agent.lan:5180/...` 都被拒（`invalid_redirect_uri`：明文 HTTP 只允许 loopback）；`https://…` 和 `http://127.0.0.1:…` 接受 | 局域网通过 IP 访问的部署必须配 HTTPS 才能授权，见第 13.6 节 |
| 注册结果 | 公开客户端（`token_endpoint_auth_method: none`），不发 `client_secret` | `mcp_oauth_clients.client_secret` 可空 |
| 授权与回调 | 回调带 `iss = https://mcp.linear.app`，SDK 校验通过；`state` 匹配 | 第 13.6 节流程可行 |
| token | `bearer`，有效期 86100 秒（约 24 小时），有 refresh token，授予 scope 与申请一致（`read`），**没有 `id_token`** | 账号名只能退回显示连接时间，见第 13.7 节 |
| MCP 调用 | `initialize` 成功（Linear MCP 1.0.0，协议 `2025-11-25`）；`scope=read` 时 `tools/list` 只返回 38 个 `readOnlyHint` 工具，写工具**不出现**；`list_teams` 调用成功 | 目录里的 `scope` 能把 server 收紧为只读，不必再靠 `hiddenTools` |
| 刷新 | 成功，access token 和 refresh token 都轮换；旧 refresh token 之后仍能用一次（服务端宽限） | 仍按第 13.9 节加跨会话刷新锁，不能依赖宽限 |
| 撤销 | `revocation_endpoint` 对 DCR 客户端返回 200；撤销 refresh token 后它立即失效，但**已签发的 access token 仍可调用 MCP** | 断开时两种 token 都要撤销，见第 13.8 节 |

### 13.3 身份前提

本服务的“用户”就是客户端 IP（`ownerKey = ip:…`，见 `docs/ip-rbac-design.md`），没有账号和登录。因此按用户存的外部 token 实际是**按 IP 存**：

- 同一台机器上的所有人共享一个身份；NAT 后面的多人也是如此。
- IP 换给了别人（DHCP 重新分配），新主人会直接继承前任连接的外部身份。这与现有会话、项目的归属风险相同，但外部 token 的后果更重：它能读写对方系统里的数据。

设计据此做三件事：面板里显示已连接的外部账号（拿不到账号名时显示连接时间），用户能一眼看出“这是谁的身份”；优先用会过期的 token 并依赖刷新；owner 转移（`docs/owner-transfer.md`）**不搬运**外部凭证，转移后旧 IP 的凭证直接删除，新 IP 需要重新授权。真正解决需要账号体系，不在本期范围。

### 13.4 目录格式

HTTP server 新增可选的 `oauth` 字段（P1 中该字段被拒绝，P3 放开）：

```json
"linear": {
  "url": "https://mcp.linear.app/mcp",
  "description": "Linear（每个用户用自己的账号）",
  "exposure": "codemode",
  "maxExposure": "codemode",
  "oauth": { "label": "Linear", "scope": "read" }
}
```

字段：

| 字段 | 说明 |
|---|---|
| `label` | 必填，面板按钮上的名字（“连接 Linear”） |
| `scope` | 可选。不写时按 SDK 默认取 401 挑战或资源元数据里的 scope；写了就只申请这些，管理员可以借此把 server 收紧为只读 |
| `clientId` / `clientSecret` | 可选，**预注册后备**：授权服务器不支持 DCR 时，由部署者在对方平台注册应用后填写。`clientSecret` 只能写成 `${secret:NAME}`。写了 `clientId` 就不再做 DCR |
| `authorizationServerMetadataUrl` | 可选，对应 SDK 同名选项，用于发现信息不对的 server |

规则：

- 有 `oauth` 的 server 凭证只来自用户授权；`headers` 里不允许出现 `Authorization`，避免“用户以为在用自己的身份，其实带着共享 token”。
- stdio server 不支持 `oauth`：子进程拿 token 的方式各不相同，按用户注入 env 留到确有需要时再设计。
- 启动时只校验格式，不联网。server 不支持 DCR 且没有 `clientId` 时，在用户点击连接时报错：“这个 MCP server 不支持自动注册，需要管理员在目录里配置 clientId”。

### 13.5 动态注册的客户端

DCR 注册出来的客户端属于**这个部署**，不属于某个用户：所有用户共用一个 `client_id`，各自授权、各自拿 token。这与浏览器类 MCP 客户端的做法一致。

- 注册时的元数据：`client_name` 为 `pi-agent-server`（可由 `PI_MCP_OAUTH_CLIENT_NAME` 覆盖，便于在对方授权页上认出是哪个部署），`redirect_uris` 为第 13.6 节的回调地址，`grant_types` 为 `authorization_code` + `refresh_token`，`token_endpoint_auth_method` 由 SDK 按服务端能力选择。
- 注册结果存表 `mcp_oauth_clients`，主键 `(server_name, redirect_url)`：`PI_PUBLIC_URL` 变了，回调地址跟着变，旧客户端不能用，下次授权时自动重新注册。`client_secret`（若服务端发了）与 token 一样加密存放（第 13.8 节）。
- 授权或刷新返回 `invalid_client`（客户端被对方清理）时，删除这条注册记录，提示用户重新连接，下次自动重新注册。
- 不做 Client ID Metadata Document：它要求 `client_id` 是一个对方能访问的 `https` 地址，自托管的局域网部署通常做不到。将来如果服务有公网 HTTPS 地址，可以作为 DCR 之外的选项，SDK 已支持（`clientMetadataDocument`）。

### 13.6 授权流程

新增配置 `PI_PUBLIC_URL`：用户在浏览器里访问本服务的地址（例如 `http://192.168.1.10:5180`），用来拼回调地址 `<PI_PUBLIC_URL>/v1/mcp/oauth/callback`。目录里有 `oauth` server 而未配置 `PI_PUBLIC_URL` 时，服务拒绝启动。

`PI_PUBLIC_URL` 必须是 `https`，或 loopback（`localhost`、`127.0.0.1`、`[::1]`）上的 `http`。授权服务器普遍按 OAuth 2.1 拒绝其他明文回调地址（P3-0 中 Linear 即如此）。启动时不满足就打警告，不拒绝启动（有的授权服务器可能放宽）。用户点连接时如果注册被拒，面板显示可读原因：“这个服务只接受 HTTPS 回调地址，请为本服务配置 HTTPS 后把 PI_PUBLIC_URL 改成 https 地址”。部署文档要给出局域网配 HTTPS 的做法（反向代理加本地 CA 证书，或 Tailscale 之类的内网 HTTPS）。只从本机访问的部署可以直接用 `http://localhost:…`。

1. 用户在 MCP 面板点“连接 Linear”，前端调用 `POST /v1/mcp/servers/:name/oauth/start`。
2. 服务端为 `(ownerKey, serverName)` 构造 provider，调用 `authorizeMcp`。SDK 完成发现、必要时 DCR、生成 PKCE verifier 和 `state`，最后调用 `provider.redirectToAuthorization(url)`；宿主在这里截下授权 URL，把 `{ state, ownerKey, serverName, codeVerifier, 发现结果, 过期时间 10 分钟 }` 放进内存里的待处理表，返回 `{ authorizationUrl }`。
3. 前端整页跳转到对方授权页，用户同意。
4. 对方回调 `GET /v1/mcp/oauth/callback?code&state&iss`。服务端校验 `state` 存在、未过期、一次性使用，且回调请求的 ownerKey 与发起时相同；然后以 `authorizationCode` 和 `iss` 再调一次 `authorizeMcp`，SDK 校验 `iss` 并换 token，结果为 `AUTHORIZED` 时 provider 已把 token 写库。
5. 302 回前端页面，只带成功或失败的码，不带 token。

待处理授权放在内存里：部署是单实例（`docs/architecture.md`），服务重启只会让进行中的授权失效，用户重新点一次即可。

### 13.7 账号名

面板需要显示“已连接：谁”。MCP 没有通用的“当前用户”接口，所以按顺序尝试：

1. token 响应带 `id_token` 时，取其中的 `email` 或 `name` 声明。只用于显示，不做身份判断，所以不校验签名（它来自直连的 token 接口）。
2. 都没有时显示“已连接（2026-10-18 14:30）”。

不为了拿账号名额外申请 `openid email` scope，避免授权页多出一项让用户困惑的权限。P3-0 中 Linear 不返回 `id_token`，所以 Linear 会显示连接时间。各 server 自己的“当前用户”工具（如 Linear 的 `get_user`）参数和返回格式各不相同，暂不接入。

### 13.8 存储

新迁移 v5，两张表。

`mcp_oauth_clients`（第 13.5 节）：主键 `server_name`；`server_url`、`redirect_url`（注册时的地址，任一变化后不再使用）；`client`（SDK 的客户端信息 JSON，整体加密，含可能有的 `client_secret`）；`registered_at`。

`user_mcp_credentials`：

| 列 | 说明 |
|---|---|
| `owner_key` | 用户（IP 身份） |
| `server_name` | 目录中的 server 名称 |
| `server_url` | 授权时的 server 地址；目录里地址变了，旧凭证不再使用（SDK 的 provider 也按地址隔离） |
| `client_id` | 换 token 时用的客户端，刷新必须用同一个 |
| `account_label` | 显示用账号名，可空 |
| `tokens` | SDK 的 token 响应 JSON（access / refresh token、`token_type`、`expires_in`、`scope`），整体加密；`id_token` 只用来取账号名，不保存 |
| `expires_at` | access token 过期时间，可空 |
| `scope` | 实际授予的 scope |
| `discovery` | 发现结果（JSON），刷新时免去重新发现 |
| `created_at` / `updated_at` | 审计字段 |

主键 `(owner_key, server_name)`。不挂在项目上：一个用户连一次，所有自己的项目都能用。

加密：新增 `PI_MCP_TOKEN_KEY_FILE`（绝对路径、`0600`、内容是 32 字节随机数的 base64），用 AES-256-GCM 加密 `tokens` 与 `client` 两列，附加数据绑定表名与所在行的主键，这样密文挪到别的行就解不开。解不开的行（换了密钥、被挪动）按不存在处理，用户重新授权即可。数据库文件和正式备份包（解密后）里都不会出现明文 token。

已知边界（与第 7 节相同）：`bash` 能读服务进程可读的任何文件，包括这个密钥文件和数据库。在授予 `bash` 的部署里，加密只能防备份泄漏，防不住同机用户。README 的“Current boundaries”要同步写明。

备份与删除：

- 备份随数据库保存密文，恢复时还需要同一份密钥文件，否则这些凭证不可用，用户重新授权即可。
- 用户在面板点“断开”时删除这一行，并在元数据有 `revocation_endpoint` 时尽量撤销 refresh token 和 access token（RFC 7009，各发一次）。P3-0 中 Linear 撤销 refresh token 后，已签发的 access token 仍可用，所以两种都要撤销。撤销失败不阻止删除。
- 目录里删掉 server 后，这一行保留但不再使用，面板标为“管理员已移除这个 server”，用户可以删除。

P3-1 实现说明（2026-10-18）：

- 目录：`src/mcp/catalog.ts` 解析 `oauth`（第 13.4 节的规则全部在启动时校验）。`src/mcp/host.ts` 在目录有 `oauth` server 时要求 `PI_MCP_TOKEN_KEY_FILE`，没有就拒绝启动。
- 存储：迁移 v5；`src/storage/kysely-mcp-oauth-repository.ts` 负责加解密，调用方只见明文记录；SQLite 与 PostgreSQL 跑同一组契约测试。
- provider：`src/mcp/oauth-provider.ts` 的 `StoredMcpOAuthProvider` 实现 SDK 的 `OAuthClientProvider`，按“用户 × server”读写库。授权进行中的 state、verifier、发现结果放在调用方传入的 `pending` 里；会话里不传 `pending` 和 `onRedirect`，需要重新授权时抛 `McpOAuthAuthorizationRequiredError`。`invalid_grant` 时 SDK 让 provider 删掉这个用户的凭证，动态注册的客户端保留。
- 用假授权服务器（`tests/mcp/oauth-provider.test.ts`）验证了：DCR、授权码换 token、`iss` 校验、401 后刷新并保存轮换的 refresh token、refresh token 失效后删除凭证、`PI_PUBLIC_URL` 变化后重新注册、预注册客户端不走 DCR。
- 留给后续步骤：P3-2 的 start 要传 `skipRefresh: true`，否则已连接的用户再点“连接”时 SDK 会直接刷新而不跳转；P3-3 补跨会话刷新锁、到期前主动刷新，以及 owner 转移时删除旧 IP 的凭证（现在的 owner 转移只改 `projects` 与 `sessions`，不会搬运凭证，但也不会删除）。

P3-2 实现说明（2026-10-18）：

- `src/mcp/oauth-connections.ts` 的 `McpOAuthConnections`：start 时以 `skipRefresh: true` 调 `authorizeMcp`，截下授权地址，把 `{ 发起者, server, state, verifier, 发现结果 }` 放进内存待处理表（10 分钟过期，每个用户保留最近 5 个，全服务最多 1000 个）。callback 只接受发起者本人、未过期的 state，用过即删；别的调用者拿到 state 既用不了，也不能把它作废。
- 回调跳回 `<PI_PUBLIC_URL>/?mcp_oauth=<结果>&mcp_server=<名称>`，地址里不带 code、state 或 token。
- 网络准入对 `GET /v1/mcp/oauth/callback` 免 Bearer token（浏览器整页跳回带不上），CIDR 准入与角色授权照旧；start、断开等其他路由仍要 token。
- 注册被拒时，若回调地址是非本机的 http，提示配置 HTTPS（P3-0 中 Linear 的行为）。
- 断开时按 RFC 7009 并行撤销 refresh token 与 access token，只发往 https（或本机）的撤销端点，失败不阻止删除。
- 这些路由已可用，但 Web 面板（P3-4）还没有入口。

### 13.9 会话如何使用凭证

- 连接仍按会话建立（第 8 节）。会话快照时，对有 `oauth` 的 server：
  - 会话属于某个用户（Web 新建的私有会话）且该用户已连接 → 这个 server 进入会话，HTTP transport 的 `authProvider` 是 `adaptOAuthProvider(该用户的 provider)`。
  - 用户没有连接 → 这个 server **不进入会话**，模型看不到它的工具，系统提示里也不出现。面板提示连接后可以使用；已打开的会话从下一条消息起生效（第 4.5 节）。
  - **原生共享会话**不使用任何用户的 OAuth 凭证：这类会话允许多个用户共同继续，用某个人的 token 就等于让其他人冒用这个身份。共享会话里 OAuth server 一律不进入。
- 刷新：由 `adaptOAuthProvider` 在 401 时触发，同一 provider 的并发 401 共用一次刷新。同一用户可能同时开着多个会话，各有一个 provider 实例，所以宿主再按 `(ownerKey, serverName)` 加一把进程内锁，并在刷新前重新读库：别的会话已经换过 token 就直接用新的，避免用旧 refresh token 刷新导致轮换失效。
- 需要重新授权（刷新失败、`McpOAuthAuthorizationRequiredError`）：删除本地凭证，工具调用返回错误“Linear 授权已失效，请在 MCP 面板重新连接”。会话本身不中断。
- 生效时机沿用第 4.5 节：连接或断开只影响之后创建或恢复的会话。断开后，正在运行的会话下一次调用会因为找不到凭证而失败。

P3-3 实现说明（2026-10-18）：

- 会话上下文新增 `mcpCredentialOwner`：Web 管理的私有会话是 owner；共享会话和原生会话为 null（原生会话的 owner 不是授权依据）。资源加载器据此列出 owner 已连接的 oauth server（`McpOAuthConnections.connectedServers`），`effectiveMcpServerEntries` 只放行这些。
- 宿主 transport 对 oauth server 一律使用会话 owner 的 `AuthProvider`（`src/mcp/session-oauth.ts`），拿不到就不连；其他 HTTP server 不带 authProvider，行为不变。
- `AuthProvider` 包在 SDK 的 `adaptOAuthProvider` 外：每次请求从库里读 token；剩余不足 60 秒时主动刷新；刷新与 401 处理按“用户 × server”在进程内串行，并在锁里重读，所以同一用户的多个会话只刷新一次。授权失效（refresh token 被撤销）时 SDK 删除凭证，调用返回“<label> 授权已失效，请在 MCP 面板重新连接”。
- owner 转移：离线工具约定只改 `projects`、`sessions` 两列，这里不改它。转移后会话属于新 IP，新 IP 没有凭证，oauth server 不会进入这些会话，不会冒用旧身份；旧 IP 的凭证留在库里，直到那个 IP 的用户断开，或授权失效后被删除。需要清理时由运维在旧 IP 上断开。

### 13.10 API 与 Web

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/mcp/connections` | 当前用户对目录中每个 `oauth` server 的连接状态 `{ name, label, connected, account?, connectedAt?, expiresAt? }` |
| `POST` | `/v1/mcp/servers/:name/oauth/start` | 返回 `{ authorizationUrl }` |
| `GET` | `/v1/mcp/oauth/callback` | OAuth 回调，完成后 302 回 Web 页面 |
| `DELETE` | `/v1/mcp/servers/:name/connection` | 断开并删除凭证 |

权限：新增 `mcp:connect`，`user` 与 `admin` 可用，`viewer` 不可用（viewer 不能运行会话，连接也没有意义）。回调路由同样经过网络准入，只能完成本 IP 发起的授权。

Web：项目 MCP 面板里 `oauth` server 多一行连接状态：“连接 Linear” / “已连接：someone@example.com · 断开”。项目是否启用这个 server 与用户是否连接相互独立：项目 owner 启用后，项目里的每个用户各自连接、各自使用自己的身份。

P3-4 实现说明（2026-10-18）：

- `GET /v1/projects/:id/mcp` 的每个 server 多一个 `oauthLabel`（需要个人授权时才有），viewer 也能看出哪些 server 用个人身份。
- 面板：这类 server 带“个人授权”标记和一行连接状态（未连接 / 已连接：账号或连接时间），按钮“连接 <label>”与“断开”。连接时先记下当前页面路径（sessionStorage），再整页跳到授权页；viewer 读不到连接状态，显示“只有能运行会话的用户可以连接”。
- 授权回来：`web/src/mcp-oauth-return.ts` 在路由读取地址之前去掉 `mcp_oauth`、`mcp_server`，回到原来的页面（只接受 `/` 与 `/p/...`），面板自动打开并显示结果。
- 说明文字按目录内容显示：有共享凭证的 server 时说明共享身份，有个人授权的 server 时说明“只有你连接过的私有会话能用”。

### 13.11 分阶段计划与验收

| 步骤 | 内容 | 验收 |
|---|---|---|
| P3-0 实测 | 用 SDK 的 `authorizeMcp` 写一个独立脚本，对 Linear 跑完整流程：发现 → DCR → 浏览器授权（本机 loopback 回调）→ 换 token → `initialize`、`tools/list`、一次只读工具调用 → 刷新 → 撤销。另外只做注册、不授权，测非 loopback `http` 回调地址是否被接受 | 已完成（2026-10-18），结果见第 13.2 节 |
| P3-1 存储与目录 | `oauth` 字段解析；迁移 v5；加密存储与仓储（SQLite、PostgreSQL）；DB 版 `OAuthClientProvider` | 已完成（2026-10-18），见第 13.8 节的实现说明 |
| P3-2 授权流程 | `PI_PUBLIC_URL`；DCR 客户端缓存；start / callback / delete 路由；state、PKCE、`iss` 校验 | 已完成（2026-10-18），见第 13.8 节后的实现说明 |
| P3-3 会话接入 | 按会话 owner 注入 `AuthProvider`；跨会话刷新锁；重新授权处理；共享会话排除 | 已完成（2026-10-18），见第 13.9 节的实现说明 |
| P3-4 Web 与文档 | 面板连接状态；README 双语、`configuration.md`、`api.md`、OpenAPI | 已完成（2026-10-18），见上方实现说明 |
| P3-5 预注册后备（可选） | 目录 `clientId` / `clientSecret`；GitHub 作为验证对象 | 不支持 DCR 的 server 可由部署者预注册后接入 |

### 13.12 待定问题

- `PI_PUBLIC_URL` 只能填一个地址：同一服务既从 `localhost` 又从局域网 IP 访问时，回调只能回到其中一个。DCR 可以登记多个 `redirect_uris`，是否支持多个 `PI_PUBLIC_URL`。
- 管理员是否需要“查看 / 吊销所有用户的连接”的入口。
- 同一 IP 多人共享的场景下，是否需要在连接时额外确认（例如显示“这台机器上的其他人也会用你的身份”）。
- GitHub（P3-5）选 GitHub App 还是 OAuth App，以及是否由项目维护一个公共应用走 Device Flow，等做到时再定。

## 14. P3-6：共享 MCP 用 Pi 的 mcp.json，个人 MCP 在 Web 上自己加（设计稿）

> 状态：2026-10-18 设计稿；P3-6a（读取 mcp.json）、P3-6b（admin 在 Web 上修改）已实现。2026-10-19 决定个人 MCP（P3-6c 起）先不做。

### 14.1 已确认的决定

1. **共享 MCP** 就是 Pi TUI 用的那份全局配置 `<agentDir>/mcp.json`（默认 `~/.pi/agent/mcp.json`）。
   - 管理员可以在终端里用 `pi mcp add/remove`、TUI 的 `/mcp` 修改，也可以在 Web 上修改。
   - Web 上只有 admin 能改，其他人只能看。
2. **个人 MCP** 存在服务器数据库里，按用户（ownerKey，即 IP 身份）隔离。
   - 每个用户在 Web 上增删自己的 server。
   - 只有本人的私有会话能用，别人看不到也用不到。
   - 不做“在用户自己电脑上运行 MCP”。那需要本地助手和转发通道，代价大，以后确有需要再单独设计。

### 14.2 共享 MCP：读取 Pi 的 mcp.json

**读取方式**
- 服务总是读取 agentDir 下的 `mcp.json`，不需要开关；文件不存在就没有共享 MCP。**只读这一个全局文件**。
- 项目目录里的 `.pi/mcp.json` 永远不读，因为会话里的模型能写项目目录，读它等于让模型给自己加 server。
- Pi TUI 自己的 OAuth 凭证 `<agentDir>/mcp-auth.json` 也不读，那是 TUI 使用者本人的身份。

**旧的目录文件**
- `PI_MCP_CATALOG_FILE` 与 `PI_MCP_SECRETS_FILE` 已移除，还设置着会拒绝启动，提示改用 `mcp.json`。
- 迁移时把目录里的每一项照第 14.2 节的字段对照写进 `mcp.json`：`adminOnly`、`maxExposure`、`defaultEnabled` 和 `oauth.label` 放进 `piAgentServer`；`${secret:NAME}` 改成环境变量 `${NAME}`。server 名称和地址不变，已有的项目设置和用户授权继续有效。

**热更新**
- 每次给会话做快照时（第 4.5 节）检查文件的修改时间和大小，变了就重新读。所以 `pi mcp add` 之后不用重启服务，会话从下一条消息起就能用上（第 4.5 节）。
- 文件解析失败时继续用上一次读成功的内容，写日志，并在管理员面板显示错误。
- 服务启动时文件就无效：共享 MCP 为空，服务照常启动。
- 正在回复的那一轮不受影响，与第 4.5 节相同。

**字段对照**

| `mcp.json` 字段 | 在本服务里的含义 |
|---|---|
| `command` / `args` / `env` / `cwd` | stdio server，规则同第 8 节（子进程只继承白名单环境变量）。相对 `cwd` 按项目 cwd 解析 |
| `url` / `headers` | HTTP server |
| 值里的 `${NAME}` | 从服务进程的环境变量取值，与 Pi 一致。另外支持 `${PROJECT_CWD}`（args、env、cwd） |
| 值里的 `!cmd` | **不支持**：这一项标为“仅 TUI 可用”，不进入会话。避免每个会话启动时在服务器上执行 shell 命令 |
| `oauth` | 每个用户在 Web 面板里用自己的账号授权，沿用第 13 节的流程：`scope`、`clientId`、`clientSecret`、`authServerMetadataUrl` 照用；`callbackPort`、`callbackUrl`、`clientRegistration: "cimd"` 只对 TUI 有意义，Web 忽略 |
| 没有 `oauth`，也没有 `Authorization` header 的 HTTP server | 匿名连接。Pi TUI 遇到 401 会自动走 OAuth，Web 不会，而是返回连接错误，提示管理员在这一项里加 `"oauth": {}` |
| `auth.provider` | **不支持**：它会把 TUI 使用者的模型登录 token 发给所有用户。这一项标为“仅 TUI 可用” |
| `enabled: false` | 全局停用，所有项目都不连 |
| `exposure` / `toolExposure` / `description` / `timeout` | 含义不变。没有 `description` 时用 server 自己返回的 instructions，再没有就用名字 |
| 本服务专用字段 | 放在每一项的 `piAgentServer` 对象里：`adminOnly`、`maxExposure`、`defaultEnabled`、`label`（OAuth 按钮上的名字）。已核实 Pi 1.3.0 的 `validateMcpServerConfig` 会保留未知字段，`/mcp` 改写文件时也保留其他内容，所以 TUI 不受影响 |

另外两点：
- `mcp.json` 里的 server 会同时出现在管理员自己的 TUI 会话里，这正是“共享”的含义。
- 项目级设置（第 4.2 节的 `project_mcp_servers`）按 server 名称引用，来源换成 `mcp.json` 不影响；同名换成另一个 server 时的处理见第 14.3 节（迁移 v6）。

P3-6a 实现说明（2026-10-18）：

- `src/mcp/pi-config.ts` 把 `mcp.json` 逐项转换成目录 server，用不了的项连同原因记进 `unavailable`，其他项照常使用。只有整个文件的形状不对时才算读取失败。
- 值的写法按 Pi 的规则转换：`$NAME`、`${NAME}` 写成 `${env:NAME}`，连接时从服务进程环境变量取值；`$$`、`$!` 是转义。读取时环境变量没设置，这一项就标为不可用。`command`、`args`、`cwd` 与 Pi 一样只展开 `~`，`args` 和 `cwd` 另外允许 `${PROJECT_CWD}`。
- 没写 `piAgentServer.maxExposure` 时，上限取 `exposure` 与 `toolExposure` 里最宽的那个，所以在 Pi 里能用的设置在这里照样能用。
- 没写 `description` 时，不给 SDK 传说明，由 SDK 使用 server 自己的 instructions。
- `src/mcp/live-catalog.ts` 的 `LiveMcpCatalog`：每次读取目录时比较文件的 inode、大小和修改时间，变了才重新解析。解析失败时保留上一次的内容，记下错误并用 `console.warn` 提示（不回显文件内容）。文件不存在就当作没有 server。
- 会话在 adapter 创建时取目录快照（`snapshot()`），用同一份快照算出启用的 server 并建立连接，期间文件被改也不会对不上。
- `mcp.json` 里带 `oauth` 的 server 需要 `PI_MCP_TOKEN_KEY_FILE` 和 `PI_PUBLIC_URL`，缺一个就标为不可用，不阻止启动。
- 同日去掉了开关和旧的目录文件：服务总是读取 `mcp.json`；`PI_MCP_CATALOG_FILE`、`PI_MCP_SECRETS_FILE` 及其解析代码删除，还设置着就拒绝启动。

### 14.3 共享 MCP：admin 在 Web 上修改

**权限**：新增 `mcp:admin`，只有 admin 有；看列表用 `mcp:read`。其他角色能看到列表（名称、说明、类型、提供方式），看不到连接参数。

**表单字段**
- 名称、类型（HTTP / stdio）、地址和 header，或命令、参数、环境变量、cwd。
- 说明、默认提供方式、上限、仅管理员可启用、默认启用、超时、OAuth（scope）。

**写文件**
- 先写临时文件再改名，保留文件里的其他内容和缩进。新建的文件权限为 `0600`。
- **防止覆盖别处的修改**：GET 返回文件内容的 hash，保存时带上它。文件在此期间被 TUI 或手工改过，就返回 409：“配置文件已在别处修改，请刷新后再改”。

**凭证显示**
- header 和 env 的值在 API 里一律打码返回。保存时值没改（还是打码的样子）就保留原值。
- 表单提示优先写环境变量 `${NAME}`，不要把明文 token 写进文件。

**stdio 的风险**：通过 Web 添加 stdio server，等于在服务器上执行任意命令。只给 admin，与 admin 本来就能在会话里用 `bash` 的权限相当。审计日志记录谁在什么时候改了哪一项。

P3-6b 实现说明（2026-10-19）：

- 权限：`mcp:read`（admin、user、viewer）看列表，`mcp:admin`（只有 admin）增删改。非 admin 只看到能用的 server，不看不能用的项和原因。
- `src/mcp/shared-config.ts`：
  - 只改表单管得到的字段（`url`、`headers`、`command`、`args`、`env`、`cwd`、`description`、`exposure`、`timeout`、`enabled`、`oauth.scope`，以及 `piAgentServer` 的 `adminOnly`、`defaultEnabled`、`maxExposure`）。`toolExposure`、`oauth.clientId`、`piAgentServer.label`、Pi 自己的字段等原样保留，表单里列出它们的名字。换了传输方式时清掉另一种的字段。
  - 写入前用本服务的解析规则检查这一项：名称、和其他项只差 `-`/`_`、`exposure` 超过上限、`!命令`、`auth.provider` 等都拒绝（400）。只缺环境变量的项照样保存，列表里标为不可用，方便先写配置再补环境变量。
  - hash 是文件内容的 SHA-256，文件不存在时是 `absent`。同一进程里的写入排队；和 TUI 同时写仍有极小的窗口，接受这个风险。
  - 新文件权限 `0600`；已有文件保持原来的权限。`mcp.json` 是符号链接时不改（改名会把链接换成普通文件）。
  - 打码规则：值是空的，或只是一个环境变量引用（可带一个前缀词，如 `Bearer ${TOKEN}`），照原样显示；其余显示为 `••••••`，传回 `••••••` 表示保留原值，新加的键不能是打码值。
- 审计：保存和删除各写一条日志（`mcpShared: { action, name }`），带请求的 `subjectHash`，不记录 IP。
- Web：admin 打开“MCP 服务”面板时多一个“共享 MCP”标签，列表按文件顺序；编辑在行内展开表单；删除要再点一次确认；409 时提示刷新。改动后“本项目”标签的列表跟着刷新。
- **server 身份（迁移 v6）**：`mcp.json` 随时能把同一个名字换成另一个 server（`pi mcp add docs --url 新地址` 直接替换同名项）。项目设置因此多存一列 `server_identity`，是保存时 HTTP 地址，或 stdio 命令、参数、cwd 的 SHA-256。和当前同名 server 对不上时，项目设置不生效（连 `defaultEnabled` 也不算），面板提示“换成了另一个 server”，owner 重新勾选后恢复。只改 header、env、说明等不算换了 server。v6 之前的行没有身份，视为一致。
- OAuth 凭证本来就记着 server 地址，地址变了不会继续用，不需要改。

### 14.4 个人 MCP

**开关**
- `PI_MCP_PERSONAL_SERVERS=true` 打开，默认关闭。需要 `PI_MCP_TOKEN_KEY_FILE`。
- 可选的 `PI_MCP_PERSONAL_ALLOWED_HOSTS`：域名白名单，逗号分隔，支持 `*.` 前缀，例如 `*.linear.app,mcp.notion.com`。不设置就不限制域名，但下面的地址拦截始终生效。

**存储**：迁移 v6，新表 `user_mcp_servers`，SQLite 与 PostgreSQL 同步。

| 列 | 说明 |
|---|---|
| `owner_key` | 用户（IP 身份） |
| `name` | 同一用户内唯一，规则同 Pi 的 server 名称 |
| `url` | 必须是 `https` |
| `description` | 可空，空时用 server 返回的 instructions |
| `exposure` | 默认 `codemode`，可选 `codemode`、`deferred`、`hidden`（是否开放 `direct` 见第 14.8 节） |
| `hidden_tools` | 同第 4.2 节 |
| `enabled` | 是否启用 |
| `auth_kind` | `none`、`header`、`oauth` |
| `headers` | 用户填的 header（如 `Authorization: Bearer …`），整体加密，做法同第 13.8 节，附加数据绑定 `(owner_key, name)`。API 只返回 header 名称和“已设置” |
| `oauth` | `{ scope? }`，`auth_kind` 为 `oauth` 时使用 |
| `created_at` / `updated_at` | 审计字段 |

主键 `(owner_key, name)`。每个用户最多 20 个。

**会话里怎么用**
- 只进入会话 owner 本人的私有会话：用第 13.9 节的 `mcpCredentialOwner` 判断。共享会话和原生会话一律不进。
- 对本人的所有项目生效，不按项目单独启用（第一版）。
- `TOOLS` 白名单和第 6 节的兜底拦截照常生效。
- **重名处理**
  - 保存时，名称不能和共享 MCP 重名。
  - 管理员之后加了同名的共享 server，以共享的为准。个人的那项标为“与共享 MCP 重名，已停用”，用户改名即可恢复。

**个人 OAuth**
- 沿用第 13 节的 provider 和刷新锁，凭证仍存 `user_mcp_credentials`。
- server 名称前加 `user:` 前缀，和共享 server 分开。
- 动态注册的客户端表 `mcp_oauth_clients` 现在按 server 名称做主键。个人 server 的名称在不同用户之间可能重复、地址也可能不同，所以个人 server 的注册记录改用 `(server_url, redirect_url)` 区分。

**网络防护（防止借服务器访问内网，SSRF）**，同样适用于个人 server 的 OAuth 发现、注册、换 token 和撤销请求：
- 只允许 `https`。
- 连接前解析域名，任一解析结果属于以下范围就拒绝：
  - 本机地址
  - 私有地址（RFC 1918、`fc00::/7`）
  - 链路本地地址（含 `169.254.169.254`）
  - `100.64.0.0/10`
  - 组播、未指定地址
  - IPv4 映射的 IPv6 地址
- **固定解析结果**：实际连接用检查过的那个 IP（自定义 `lookup`），防止域名重新绑定（DNS rebinding）。
- 不跟随重定向。
- 拦截时返回可读原因：“这个地址指向内网或本机，个人 MCP 不允许连接”。

**其他**
- 权限：新增 `mcp:personal`，`user` 与 `admin` 可用，viewer 不可用。
- owner 转移不搬运个人 MCP，规则与第 13.3 节相同。
- 备份随数据库保存密文。

### 14.5 Web

设置 → MCP 服务的面板分成三块：

1. **本项目**：现有的项目设置，对共享 MCP 按项目启用和收紧。
2. **共享 MCP**：所有人能看到列表。admin 看到“添加 / 编辑 / 删除”，并能看到配置文件的读取错误。
3. **我的 MCP**：个人 server 的增删改、启用开关，以及连接状态（OAuth 的“连接 / 断开”沿用 P3-4 的样式）。

### 14.6 API

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/v1/mcp/shared` | `mcp:read` | 共享 MCP 列表。admin 额外拿到打码后的连接参数、文件 hash 和读取错误 |
| `PUT` | `/v1/mcp/shared/:name` | `mcp:admin` | 新增或替换一项，请求带文件 hash |
| `DELETE` | `/v1/mcp/shared/:name?hash=` | `mcp:admin` | 删除一项，请求带文件 hash |
| `GET` | `/v1/mcp/personal` | `mcp:personal` | 我的 MCP 列表（header 只给名称） |
| `PUT` | `/v1/mcp/personal/:name` | `mcp:personal` | 新增或修改，保存前做地址检查 |
| `DELETE` | `/v1/mcp/personal/:name` | `mcp:personal` | 删除，同时删除对应的 OAuth 凭证并尽量撤销 |
| `POST` | `/v1/mcp/personal/:name/test` | `mcp:personal` | 试连一次（`initialize` + `tools/list`），返回工具数或错误 |

个人 OAuth 的 start、callback、断开复用第 13.10 节的路由。server 名称写成 `user:<name>`，服务端只在调用者本人的个人 server 里查找。

### 14.7 分阶段计划与验收

| 步骤 | 内容 | 验收 |
|---|---|---|
| P3-6a 读取 mcp.json | 总是读取 `mcp.json`；字段对照；`piAgentServer` 扩展字段；热更新；移除目录文件与密钥文件 | `pi mcp add` 之后新建会话能用，不用重启；文件写坏时继续用上次读成功的内容；`!cmd`、`auth.provider` 项不进入会话；不读项目 `.pi/mcp.json` 和 `mcp-auth.json` |
| P3-6b admin Web 修改 | `mcp:admin`；共享 MCP 的 API；原子写入与 hash 冲突检查；打码 | 非 admin 改不了；TUI 改过文件后 Web 保存返回 409；打码值保存后原值不变 |
| P3-6c 个人 MCP | 迁移 v6；仓储加密；API；地址拦截；会话接入 | 内网、本机、元数据地址和重新绑定都被拒；只进入本人私有会话；与共享重名时以共享为准 |
| P3-6d 个人 OAuth | 复用第 13 节；`user:` 前缀；注册客户端按地址区分 | 两个用户同名、不同地址的个人 server 各自授权互不影响 |
| P3-6e Web 与文档 | 面板三块；README 双语、`configuration.md`、`api.md`、OpenAPI | 端到端：admin 加共享 server，用户加个人 server，各自在会话里调用成功 |

### 14.8 待定问题

2026-10-18 先按保守的做法定下，以后有需要再放开：

- 个人 MCP 不允许 `direct`，上限是 `codemode`。
- 个人 MCP 不按项目启用，对本人的所有私有会话生效。
- `PI_MCP_CATALOG_FILE` 不保留：用户决定直接移除，共享 MCP 只有 `mcp.json` 一个来源。
- 共享 MCP 不支持 `!cmd`，含 `!cmd` 的项标为“仅 TUI 可用”。
