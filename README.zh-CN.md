[English](README.md) · **简体中文**

# pi-agent-server

pi-agent-server 是基于 Pi Agent Runtime 构建的长期运行、会话式 HTTP/SSE 服务，核心支持多用户访问。项目与会话管理用于组织工作和对话，同时提供流式任务控制、持久化、并发限制、路由 RBAC 与可配置工具权限。`web/` 中的 React/Vite 应用为可选独立客户端，Fastify 不托管该前端。

> **状态：Release Candidate（RC），尚非生产就绪。**

## 当前边界

- **当前面向内网：** 公网部署能力将在后续版本完善。
- **当前为单实例运行：** 后续计划支持多实例部署。
- **Pi 工具默认授权：** `TOOLS` 未设置或为空/空白时，允许全部可用内置工具及显式加载的扩展/插件工具；保留 Pi 的工具激活及会话恢复行为。纯工具名 `TOOLS` 是覆盖所有工具来源的完整白名单；全 modifier 列表解析后作为白名单（见配置）。**风险：** 默认允许命令执行和文件写入（含 `bash`、`edit`、`write`）；只读工具选择请设置 `TOOLS=read,ls,find,grep`，并另行落实文件系统/进程隔离。HTTP RBAC 和文件授权不变。
- **Pi 扩展：** 通过 `PI_EXTENSION_PATHS` 指定要加载的 Pi 扩展。不设置时不加载扩展。支持范围见下方[Pi 扩展](#pi-扩展)。
- **可按需增加业务功能：** 开发者可以把额外的工具、接口等功能做成 agent-server 插件，通过 `PI_PLUGINS` 配置启用。不需要额外功能时，无需配置。
- **Pi Session JSONL 暂不自动清理：** 删除项目或会话后，对应的 JSONL 文件仍会保留。
- **支持本机加密备份：** 备份与恢复工具已经提供，异地容灾仍在规划中。中断运行不自动续传：停止 writer，核验并仅清理本次产物后重做；原生恢复绝不覆盖已有文件。详见[备份与恢复](docs/backup-restore.md)。
- **首次部署需要初始化数据库：** 先按[运维文档](docs/operations.md)初始化数据库，再启动服务；如果新版本发布说明要求更新数据库结构，也要先按运维文档升级数据库，再启动新版本服务。

Pi SDK 与 pi-ai 固定为 **1.1.0**；本次 SDK 升级无需数据库迁移（下方既有原生会话 v2 要求不变）。SSE `tool_end` 与 export `tool_result` 的可选 `durationMs` 是 SDK 实测工具执行时间，不是子 agent 运行时间或模型吞吐；旧记录缺失仍表示未知。轮/turn 计数仍表示实际执行。见 [SDK 边界](docs/pi-sdk-api.md)与[统计契约](docs/usage-measurement.md)。

## 特性

- 以多用户支持为首要能力。
- 项目与会话管理作为组织工作与对话的配套能力。
- HTTP/JSON API 与 Server-Sent Events。
- 空闲或新会话时，发送/Enter 启动 primary 任务；运行中默认提交 `follow-up` 进入追加队列，没有发送模式选择栏。通过追加条目的「引导」按钮提升为 `steer`。Composer 不提供停止按钮；后台 abort 与程序 API/hooks 能力保留。Web UI 展示服务端权威驻留队列项，支持单条删除，提交通知与队列行分开显示。追加支持文字与图片（不支持文件附件）；准入仅清除提交的快照，保留新草稿/附件。结果未知时绝不自动重发。
- 默认 SQLite；显式选择 PostgreSQL。
- 会话以 Pi JSONL 文件保存，项目、会话与任务状态等信息存入数据库；同一请求重复提交会返回已记录的结果，不重复执行。
- 基于角色的路由访问控制，默认拒绝：`viewer`、`user`、`operator`、`admin`；允许网段内未单独登记的 IP 默认视为 `user`。
- 可通过安全策略文件配置绑定精确 IP 的 Bearer token。

## 快速开始

### 前置条件

- Node.js >= 22.19.0
- pnpm

### Mock 服务与 Web UI

```bash
# 终端 1
pnpm mock

# 终端 2
pnpm web:mock
```

打开 <http://127.0.0.1:5173>。Mock 服务使用内存数据库和假 Agent，不需要模型凭证。

### 从源码启动真实服务（开发模式）

```bash
pnpm dev:real
```

`dev:real` 通过 tsx 的 `--env-file-if-exists=.env.local` 加载可选的 `.env.local`。先复制已追踪且不含敏感值的模板：

```bash
cp .env.example .env.local
```

本地模板显式设置开发值 `DATA_DIR=/tmp/pi-agent-server`、`PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8`、`PI_DEFAULT_MODEL=openai-codex/gpt-5.6-luna` 和 `PI_DEFAULT_THINKING_LEVEL=medium`；使用前请修改机器相关值。若 `DATA_DIR` 未设置或为空白，服务默认使用 `~/.pi/agent`。`PI_ALLOWED_CLIENT_CIDRS` 必填，并按所有路由的客户端 IP 匹配。

`dev:real` 使用解析后的 `DATA_DIR` 和 `DB_PATH`，服务启动只验证、不自动初始化数据库。首次运行前初始化空目标：

```bash
pnpm dev:real:init
```

`dev:real:init` 与 `dev:real` 加载相同的可选 `.env.local`（已有进程环境变量优先），并复用统一存储 resolver：`DATA_DIR` 未设置或空白时默认 `~/.pi/agent`，`DB_PATH` 可覆盖默认的 `<DATA_DIR>/pi-agent-server.db`。模板中的 `/tmp` 路径是显式开发示例，不是硬编码默认。对于 SQLite，已有库先在临时 DB/WAL/SHM snapshot 上调用官方只读 schema/ledger verify 引擎，成功或失败都会清理副本。有效 head 会报告“已初始化”并成功退出，不写入；仅不存在或完全空的目标才 bootstrap 并验证。非空且无有效 ledger 的库拒绝 adoption、删除或修复；有效旧版本需要显式离线迁移，绝不自动 apply。PostgreSQL 需使用显式离线 migration CLI。初始化后直接运行 `pnpm dev:real` 即可。

默认凭证来源是 `~/.pi/agent/auth.json`。部署时应通过 `PI_AUTH_PATH` 指向服务专用凭证文件；也可以用 `PI_MODEL_PROVIDER` 和 `PI_MODEL_API_KEY` 注入默认 provider 的运行时 API key。

### Pi 扩展

可通过 `PI_EXTENSION_PATHS` 配置要加载的 Pi 扩展：

```bash
PI_EXTENSION_PATHS=/absolute/path/to/pi-extension
```

### Pi 原生会话（默认共享）

列出项目或会话时发现原生 **v3** JSONL 并索引原件，依据已验证的 header 自动登记符合条件的 canonical 工作区（绝不反解目录名作为 cwd 授权）；默认 cwd 复用默认项目。不会直接暴露其他 owner 的私有会话或项目。原生会话默认对**所有通过网络准入的用户**共享，仍受现有路由 RBAC 约束；Web 新建会话继续按 owner 私有隔离。有写权限的用户可共同继续、控制或中止共享会话。API 新增可选 `visibility`（`shared`/`private`）与 `origin`（`native`/`managed`），旧客户端仍能 list/open。请求 ID 在共享会话内全局唯一并绑定操作者；其他用户复用会返回 `409`，不会收到对方的请求结果。

发现不复制、迁移或删除源文件。同一原件只对应一个 server session/runtime；逻辑删除保留持久墓碑。显示优先级为 Web 改名、最新原生名称、首条 prompt。新建项目若 canonical cwd 重复（含符号链接别名和默认 cwd）返回 `409`；既有重复项目保留。

`PI_SESSION_SHARE_EXCLUDE_CWDS` 按逗号分隔、trim 并去除空项；未设置/为空不排除任何目录。填写最多 64 个存在的绝对目录，按 **canonical cwd 精确匹配**，不是前缀。无效配置拒绝启动；目录替换或别名重定向使共享访问 fail closed，包括活动事件流。修改后重启；私有会话访问与原件保留。

`PI_SESSION_SOURCE_DIR` 是 CLI/Web 新建私有 JSONL 的统一根：默认 `PI_CODING_AGENT_DIR/sessions`，否则为 `~/.pi/agent/sessions`，独立于服务端 `PI_AGENT_DIR` 和 `DATA_DIR`。隔离存储须显式设置。Web 新建会话使用原生 encoded-cwd 布局，但保持 private/managed，包括分享排除 cwd；旧 server-ID 引用继续可读，不移动文件。source claim 与墓碑防止私有文件被重新发现为共享。**不要同时使用 CLI 和服务操作同一原件：** 尚无跨进程锁。FD 校验与追加边界见[架构](docs/architecture.md)。

备份包含已登记原生/私有来源的真实 bytes 与墓碑，不只是索引；活动原件缺失或无效即 fail closed。恢复须显式设置原生目标根和 identity cwd mapping，绝不覆盖文件。中断恢复需核验清理后重做，见[备份与恢复](docs/backup-restore.md)。重启前离线 apply 新增数据库 v2 migration；启动仍只 verify。

自动发现将已验证、符合条件的工作区登记为系统管理项目。`GET /v1/projects` 仅列出当前操作者可见会话的项目，默认项目也过滤；不删除已存项目或文件。有写权限的操作者可在共享项目中新建自己的私有会话（`canCreateSession`），不会取得项目修改或其他操作者附件的访问权。exclude 撤销共享入口，但保留通过自己私有会话的访问。项目改名/删除仍仅限 owner。显式创建返回空草稿，Web 保留它以发送首条消息；空列表仍可向默认项目首次发送。归属与存储规则见[数据库设计](docs/database-design.md)。

### Web UI
可选独立 Web UI 通过 `pnpm web` 启动。

重设计分阶段进行：基础和两栏侧边栏／会话区已实现，包括侧栏唯一项目选择、日期分组会话、工具轻卡、统一输入框及单一主题菜单（浅色／深色／跟随系统三项单选），展开、收起及手机侧栏均可操作。所选浅色／深色／跟随系统模式缓存到 localStorage，刷新时恢复。未设置或非法值默认跟随系统，仅此模式响应操作系统变化；存储不可用时仍可在本页切换主题。阶段三 A 已加入引导／追加控件及权威驻留控制队列 UI。Inspector 默认关闭，按需以 380px 右侧栏挤出会话列，无遮罩或焦点陷阱。宽度 ≤600px 时占据可用布局宽度，隐藏但不卸载会话；关闭或 Esc 返回聊天并回焦轨迹入口，草稿不丢失。左侧移动导航仍为独立 overlay 抽屉。Inspector 已按「步骤」（默认）、「系统提示词」、「事件流」排列。步骤按权威快照顺序展示用户消息、思考、助手文本、工具调用及独立工具结果，可展开查看完整内容；系统提示词明确区分当前有效值与创建时快照。来源、刷新行为和历史顺序限制见[会话步骤与 Inspector](docs/session-steps.md)。新增的[控制队列参考图](docs/design/reference-control-queues.png)只引导追加交互，不得覆盖既有 280px 侧栏、26px Logo 或原工具名。参见 [DESIGN.md](DESIGN.md) 和原有[工作区视觉参考](docs/design/reference-gpt-workspace.png)。

已批准的[项目切换参考](docs/design/project-switcher-reference.png)将常驻项目行精简为左侧项目名称紧邻 chevron 的一体触发器（x16）与右侧搜索按钮，移除装饰性 folder 图标与常驻「+」按钮。项目下拉提供带左侧对勾的项目选择列表、分隔线以及底部「+ 新建项目」展开创建表单。Web UI 明确不做项目删除（后端 API、路由、RBAC 及客户端 SDK 完整保留 `deleteProject` 能力）。搜索在项目行下方展开，安全高亮纯文本标题匹配，无结果可清空；清空保留输入展开，关闭或切项目均清空并退出搜索。会话重命名／导出／删除仍可用。侧栏默认 280px，可拖宽 180–400px，保留 rail／drawer 恢复及手机 44px 触控。隔离 workspace 测试覆盖这些交互、几何及 1440/1280/390px 明暗 App 截图；参考证据写入 `/tmp/pi-sidebar-v5-final`。这不代表生产部署或真机键盘已验收。

工具卡保留正常参数／结果展开及流式更新，不再提供原始数据查看／复制操作、专用检查弹窗或 footer 占位。协议数据、事件日志、代码复制及共用统计／超大 diff 弹窗不变。可运行 `volta run pnpm --dir web exec playwright test --config playwright.workspace.config.ts` 验证；展开工具卡截图位于 `web/test-results/workspace/tool-expanded-no-footer.png`。

UI 基础采用不含 Preflight 的 Tailwind v4、`ui:` 前缀工具类及本地维护的 Radix 基础组件。全局主题 token 位于 `web/src/styles/tokens.css`，按 `[data-ui]` 启用的别名与 Portal 共用这些 token。业务组件保留既有数据契约，使用系统字体。工具类目前仅扫描 `web/src/components/ui`，其他区域接入时需显式扩展扫描范围。固定 UI 文案、无障碍标签、提示及前端校验／错误消息统一使用 `web/src/i18n/zh-CN.ts` 中的中文语言对象，按功能分组，动态文案使用函数。Thinking／Thought 显示为“正在思考”／“思考过程”，并提供中文展开／收起提示。用户及服务端内容、模型 ID、工具名称与协议字段保留原值。目前仅使用中文，尚未实现语言切换。 模型面板打开时会将当前模型滚到可见区，并保留搜索焦点。可用思考级别去重后按 `off → minimal → low → medium → high → xhigh → max` 排列；未来未知级别仍保留在末尾。选中项显示强调色描边及较高字重。 助手正文首字到来前，回复区域显示明确等待提示，并区分等待运行确认、思考、工具执行及断线状态。中止后的半截回复保留“已中止”标记，发送下一轮后仍可见；历史仅在导出包含明确的 `stopReason: "aborted"` 证据时恢复该标记。

导航使用 `/p/:projectId` 表示项目起始态，`/p/:projectId/s/:sessionId` 表示会话。显式 URL 优先于最近选择，会话归属通过服务端授权元数据校验。返回／前进和刷新恢复导航，不恢复未发送草稿或附件。空项目可能在刷新后从过滤的项目列表中消失。独立 Web 托管服务只应为前端导航路径提供 SPA 入口，不能兜底 `/v1`、SSE 或缺失资源；Fastify 不托管 Web UI。生产深链接兜底仍需部署验收。

验证命令：`pnpm --filter web test`、`pnpm --filter web build`、`pnpm --dir web exec playwright test --config playwright.ui-foundation.config.ts`（隔离 mock／fixture，无需真实 Agent）。基础浏览器测试覆盖键盘／焦点交互，并对桌面／手机、两种主题下的空态与历史会话比较基础样式开关前后的截图；这验证样式隔离，不代表与参考稿逐像素一致。运行 `pnpm --dir web exec playwright test --config playwright.workspace.config.ts` 可复验新版工作区 fixture 并生成截图。运行 `volta run pnpm --dir web exec playwright test --config playwright.steps.config.ts` 可验证 Inspector 组件及完整 App 的 mock API 接线。真机软键盘、200% 缩放及完整异常状态矩阵仍待进一步验收。

## 部署
内网部署请按[运维文档](docs/operations.md)完成安装、配置和启动检查。

## API 概览

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 存活检查 |
| `GET` | `/readyz` | 进程启动与 migration gate 就绪状态 |
| `GET` | `/metrics` | 固定 Prometheus 进程/readiness 指标 |
| `GET` | `/v1/access` | 查询当前用户是否有读取和写入权限，返回 `canRead` 和 `canWrite` |
| `GET` | `/v1/capabilities/<plugin-id>/access` | 查询当前用户可以使用该插件的哪些功能，具体返回字段由插件定义 |
| `GET` | `/v1/models` | 可用模型与默认值 |
| `GET` / `POST` | `/v1/projects` | 列出或创建项目 |
| `DELETE` | `/v1/projects/:id` | 逻辑删除项目 |
| `GET` / `POST` | `/v1/sessions` | 列出或创建会话 |
| `PATCH` / `DELETE` | `/v1/sessions/:id` | 重命名或逻辑删除会话 |
| `PATCH` | `/v1/sessions/:id/config` | 修改模型/思考配置 |
| `POST` | `/v1/sessions/:id/messages` | 提交提示词（必须提供 `requestId`） |
| `GET` | `/v1/sessions/:id/events` | SSE；viewer 对无 live runtime 的会话收到 `204`。所有与 turn 相关的事件都携带产生它们的 `requestId`（`text_delta`、`thinking_delta`、`tool_start`、`tool_update`、`tool_end`、`status`、`usage`、`queued`、`error`、`completed`、`aborted`） |
| `POST` | `/v1/sessions/:id/steer` | 引导运行中的任务；带关联身份的请求返回空 `202`，消费由 SSE 确认，HTTP 准入不代表消费。见[消费确认](docs/steering-confirmation.md) |
| `POST` | `/v1/sessions/:id/follow-ups` | 排队追加 follow-up；带关联身份时准入返回空 `202`，旧版纯文本请求返回空 `204` |
| `GET` | `/v1/sessions/:id/control-queue` | 读取驻留引导/追加项的权威快照 |
| `DELETE` | `/v1/sessions/:id/control-queue/:controlId` | 按控制身份删除排队项 |
| `POST` | `/v1/sessions/:id/control-queue/:controlId/promote` | 将排队的追加项提升为引导 |
| `POST` | `/v1/sessions/:id/abort` | 中止该会话当前正在执行的任务。请求体可以不填；如果填写，必须是 `{ "requestId": "..." }`，只有任务的请求 ID 与它一致时才会中止。ID 不匹配则返回 `409`，任务继续运行。 |
| `GET` | `/v1/sessions/:id/export` | 只读消息快照；绝不创建 runtime |
| `GET` | `/v1/sessions/:id/steps` | Inspector 完整步骤快照，数组顺序权威；只读且不创建 runtime |
| `GET` / `HEAD` | `/v1/sessions/:id/system-prompt` | 读取系统提示词并明确标注 `live_effective`、`creation_snapshot` 或 `unavailable` 来源；只读且不创建 runtime |
| `GET` | `/v1/sessions/:id/file-preview?path=<relative>&line=<optional>` | 预览该会话项目目录中的文本文件；`path` 填相对文件路径，`line` 可选，用于定位行号。不能读取项目目录外的文件 |

队列出队不代表任务完成或控制内容已消费。公开事件边界的队列同步可能延迟；GET 与队列变更会即时对照 SDK 当前驻留对象。变更使用原始 control ID 及 request/acknowledgement 身份。保证与限制见[控制队列](docs/control-queues.md)。

Inspector 读取沿用会话 export 的授权层级，且不创建 runtime。步骤快照包含投影出的完整语义块，包括思考以及分开的工具调用／工具结果；数组顺序权威。已保存历史只能保留记录中的分支／块顺序：重启后无法恢复未持久化的并行工具真实完成时序，因此这不是永久完整的 SDK 事件档案。实时系统提示词来自已有公开 getter，但不证明模型实际收到的内容；创建时快照也不是运行时提示词的重建。现有事件流视图／流保持不变。契约与限制见[会话步骤与 Inspector](docs/session-steps.md)。

### 公共 API 契约 v1

- v1 请求、响应和 SSE 字段见 [OpenAPI 规范](openapi/v1.json)；客户端可从 `pi-agent-server/contract` 导入对应类型。插件路由及其字段由各插件独立定义，见[插件接入说明](docs/plugin-integration.md)。现有 v1 行为和字段保持兼容；可新增可选内容，破坏性变更需使用新版本。
- `GET /v1/access` 只返回 `{ canRead, canWrite }`：分别表示用户能否使用只读功能、提交或控制任务。`GET /v1/capabilities/<plugin-id>/access` 返回当前用户能使用该插件的哪些功能。权限配置见 [IP 访问控制](docs/ip-rbac-design.md)。
- 每次有意提交消息使用唯一 `requestId`。持久化 fingerprint 在重启后仍以 `409` 拒绝内容变化；无 fingerprint 的旧记录不保证该检查。共享会话的 ID 还绑定操作者。消息图片支持 PNG、JPEG 和 WebP，服务不会压缩图片。非图片上传需显式配置存储与配额，见[附件上传](docs/attachment-uploads.md)。
- `file-preview` 的路径相对于会话的受信项目目录，不能读取目录外文件。没有保存目录快照的旧会话无法使用预览；请新建会话。

## 访问控制

启动必须提供显式 CIDR allowlist：

```bash
export PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8
```

身份即客户端 IP：默认取直接 TCP 对端 IP；当 TCP 对端为回环（`127.0.0.0/8` 或 `::1`，即同机反向代理，如 nginx 反代到 `127.0.0.1:8080`）时，改用 `X-Forwarded-For` 的**最右**一条（nginx 是追加语义，最右条目才是代理实际看到的地址）。XFF 缺失或不可解析时回落到 socket 对端 IP；非回环对端一律忽略 XFF。若真实用户经同机代理到达，允许网段必须覆盖用户所在内网，而不只是 `127.0.0.0/8`。详见 [docs/ip-rbac-design.md](docs/ip-rbac-design.md) 与 [ADR 0003](docs/decisions/0003-loopback-proxy-client-ip.md)。

可选的绝对路径 `PI_IP_ACCESS_POLICY_FILE` 能为精确 IP 定义：

- `role`：`viewer`、`user`、`operator` 或 `admin`；
- `disabled`；
- `tokenRequired` 与全局唯一的 `sha256:<64位小写hex>` token hash。

允许 CIDR 内未登记的 IP 使用 `role=user` 且关闭 token。Token 不能绕过 CIDR 准入、改变角色或跨 IP 使用。


## 配置

| 变量 | 当前默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 端口 |
| `HOST` | `127.0.0.1` | 绑定地址 |
| `DATA_DIR` | `~/.pi/agent` | 服务数据、旧布局 JSONL 与默认 SQLite 位置；不覆盖统一会话来源根 |
| `PI_SESSION_SOURCE_DIR` | CLI agent 目录 + `/sessions` | CLI/Web 新建私有 JSONL 的统一根；独立于 `DATA_DIR`/服务端 `PI_AGENT_DIR`；隔离存储须显式覆盖 |
| `PI_SESSION_SHARE_EXCLUDE_CWDS` | 未设置（共享所有符合条件的项目） | 逗号 split/trim/去空项；精确 canonical cwd 排除；无效目录 fail closed；修改后重启 |
| `DB_PATH` | `<DATA_DIR>/pi-agent-server.db` | SQLite 文件 |
| `PI_STORAGE_DIALECT` | `sqlite` | `sqlite` 或显式 `postgres` |
| `PI_DATABASE_URL` | 未设置 | PostgreSQL 必填 |
| `PI_ALLOWED_CLIENT_CIDRS` | **无默认；必填** | 允许访问服务的来源 IP 网段，例如 `127.0.0.0/8` |
| `PI_IP_ACCESS_POLICY_FILE` | 未设置 | 可选策略文件的绝对路径，用于为指定 IP 设置角色、禁用状态和 token 要求 |
| `PI_AUTH_PATH` | `~/.pi/agent/auth.json` | 非开发环境应使用服务专用文件 |
| `PI_MODEL_PROVIDER` / `PI_MODEL_API_KEY` | 未设置 | 默认 provider 运行时凭证注入 |
| `PI_DEFAULT_MODEL` | 未设置 | `provider/modelId` |
| `PI_DEFAULT_THINKING_LEVEL` | Pi 默认值 | `off` 至 `max` |
| `PI_SYSTEM_PROMPT` | Pi 默认提示词 | 可选的系统提示词整体覆盖；保留既有语义 |
| `PI_APPEND_SYSTEM` | 未设置 | 追加系统提示词原文，**不是路径**；空白不追加。先于文件原文和能力片段追加。修改后重启并新建会话；见 [SDK 提示词边界](docs/pi-sdk-api.md#35-资源加载与系统提示词安全边界)。 |
| `PI_APPEND_SYSTEM_FILE` | 未设置 | 显式 UTF-8 文件，启动仅读一次；相对路径基于服务启动 cwd，不展开 `~`。无效文件拒绝启动。修改后重启并新建会话；冻结提示词不变。不自动发现 `APPEND_SYSTEM.md`。 |
| `TOOLS` | 允许全部工具 | 受信服务配置，不是会话输入。纯工具名形成完整白名单，包含扩展/插件工具。全 modifier `+name,-name` 按顺序调整 Pi 默认选择（`read,bash,edit,write`），再冻结为宿主白名单；例如 `-bash,+custom_tool` 保留 read/edit/write 并允许已注册的自定义工具。混合纯名/modifier 或 modifier 通配符拒绝启动。未设置/空白/仅逗号允许全部；程序化 `StartConfig.tools=[]` 禁用全部。 |
| `PI_PLUGINS` | 未设置 | 逗号分隔的显式加载、受信任同进程 ESM specifier；可以是包名，也可以是构建产物入口的绝对路径（裸机部署用后者，因为 `pnpm link` 在重建 `node_modules` 后不保留）；不扫描目录或 `.pi` |
| `PI_EXTENSION_PATHS` | 未设置 | 显式加载 Pi SDK 扩展的主变量，逗号分隔（绝对路径或 `~/…`）；不自动发现，无效路径或加载失败即拒绝启动。`PI_PROVIDER_EXTENSION_PATHS` 为已弃用兼容 alias：去除空白与空项后，仅旧变量得到非空列表时在路径校验前警告；两个变量都得到非空列表则拒绝启动 |
| `CORS_ORIGINS` | 空 | 允许在浏览器中调用本服务的网页地址；多个地址用逗号分隔，例如 `http://127.0.0.1:5173` |
| `PI_BACKUP_STAGING_ROOT` | 每用户私有应用目录 | 备份或数据库升级时使用的临时工作目录；通常无需设置 |

## 持久化与运维

- 元数据存于 SQLite 或 PostgreSQL；完整对话历史存于 Pi 管理的 JSONL。
- managed 会话 DELETE 把持久清理意图写入 `file_operations`，但仓库只提供只读 planner；物理执行不在当前范围。原生会话 DELETE 只为服务端索引登记墓碑，绝不调度源文件删除。
- backup、restore、migration、reconcile 和 owner-transfer 均为离线命令，不启动服务，也不安装 timer/worker。`pi-agent-server-drill` 同样如此：做门禁（preflight）、执行隔离一键演习（run）与清理隔离运行产物（cleanup）。它绝不自动启动服务、安装 timer，也不触碰正式资源。
- PostgreSQL server、`pg_dump`、`pg_restore` major 必须匹配，并且有效业务 schema 必须非 `public`、非系统 schema。
- 只有相应环境门控的真实 PostgreSQL/age 检查实际运行时才能形成验收证据；skip 不算验收。

见[运维索引](docs/operations.md)、[备份与恢复](docs/backup-restore.md)和[数据库设计](docs/database-design.md)。

## 开发

日常入口、专项门禁、先决条件与覆盖边界见[测试命令清单](docs/testing.md)。

```bash
pnpm test
pnpm typecheck
pnpm verify
pnpm verify:release     # 需要真实 PostgreSQL 与 age 前置条件
pnpm build
pnpm --filter web test
pnpm --filter web build
pnpm run e2e
```

`pnpm run e2e` 使用本机已安装的 Chrome 顺序运行分组，保留已有 skip 守卫，默认排除长会话性能与最近会话恢复测试。rich-app/start-state 的 12 个测试在独立 rich 组使用隔离 mock 端口 5189/8089 执行；只有该组的测试进程及服务设置 `MOCK_SCENARIO=rich`。其它组和全量基线 discovery 显式清空该变量，即使调用者环境中已设置。失败不阻止后续组；原生 Playwright JSON 报告及汇总（通过/失败/跳过/未执行）保存在启动时打印的独立临时目录。使用 `pnpm run e2e -- --list` 可核验分组的 Playwright discovery，不启动服务或执行测试。

专项离线命令与 PostgreSQL 门禁见 [docs/operations.md](docs/operations.md)、[docs/postgres-podman-test.md](docs/postgres-podman-test.md)和 `package.json`。

## 文档

日常运维只需看这两份操作手册：

- [运维](docs/operations.md)：生产更新、服务管理、管理员 IP 与排障。
- [备份与恢复](docs/backup-restore.md)：密钥、定时备份、失败检查、恢复演练与保留策略。

研发参考：

- [架构](docs/architecture.md)与[数据库设计](docs/database-design.md)
- [IP 接入控制](docs/ip-rbac-design.md)
- [插件接入](docs/plugin-integration.md)
- [控制队列](docs/control-queues.md)
- [会话步骤与 Inspector](docs/session-steps.md)
- [ADR 索引与维护约定](docs/decisions/README.md)

[归档资料](docs/archive/)收录历史安装步骤、已完成计划、验收记录及可选监控/IAM 规划，不作为当前生产操作手册。独立文档索引已移除，以本节为统一入口。
