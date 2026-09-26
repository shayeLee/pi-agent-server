[English](README.md) · **简体中文**

# pi-agent-server

pi-agent-server 是基于 Pi Agent Runtime 构建的长期运行、会话式 HTTP/SSE 服务，核心支持多用户访问。项目与会话管理用于组织工作和对话，同时提供流式任务控制、持久化、并发限制、路由 RBAC 与可配置工具权限。`web/` 中的 React/Vite 应用为可选独立客户端，Fastify 不托管该前端。

> **状态：Release Candidate（RC），尚非生产就绪。**

## 当前边界

- **当前面向内网：** 公网部署能力将在后续版本完善。
- **当前为单实例运行：** 后续计划支持多实例部署。
- **Pi 工具：** 默认 `read`、`ls`、`find`、`grep`。可通过环境变量 `TOOLS` 配置完整工具列表。
- **Pi 扩展：** 通过 `PI_EXTENSION_PATHS` 指定要加载的 Pi 扩展。不设置时不加载扩展。支持范围见下方[Pi 扩展](#pi-扩展)。
- **可按需增加业务功能：** 开发者可以把额外的工具、接口等功能做成 agent-server 插件，通过 `PI_PLUGINS` 配置启用。不需要额外功能时，无需配置。
- **Pi Session JSONL 暂不自动清理：** 删除项目或会话后，对应的 JSONL 文件仍会保留。
- **支持本机加密备份：** 备份与恢复工具已经提供，异地容灾仍在规划中。详见[备份与恢复](docs/backup-restore.md)。
- **首次部署需要初始化数据库：** 先按[运维文档](docs/operations.md)初始化数据库，再启动服务；如果新版本发布说明要求更新数据库结构，也要先按运维文档升级数据库，再启动新版本服务。

## 特性

- 以多用户支持为首要能力。
- 项目与会话管理作为组织工作与对话的配套能力。
- HTTP/JSON API 与 Server-Sent Events。
- 任务运行期间支持 `steer`、`follow-up` 和 `abort`。
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

本地模板包含开发值 `DATA_DIR=/tmp/pi-agent-server`、`PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8`、`PI_DEFAULT_MODEL=openai-codex/gpt-5.6-luna` 和 `PI_DEFAULT_THINKING_LEVEL=medium`；使用前请修改机器相关路径。`PI_ALLOWED_CLIENT_CIDRS` 必填，并按所有路由的客户端 IP 匹配。

`dev:real` 的数据库在 `/tmp/pi-agent-server`，服务启动只验证、不自动初始化。首次运行前（或清空 `/tmp` 后）初始化一次：

```bash
pnpm dev:real:init
```

该命令等价于离线 bootstrap 并回读验证；重复运行会因库非空而拒绝，之后直接运行 `pnpm dev:real` 即可。

默认凭证来源是 `~/.pi/agent/auth.json`。部署时应通过 `PI_AUTH_PATH` 指向服务专用凭证文件；也可以用 `PI_MODEL_PROVIDER` 和 `PI_MODEL_API_KEY` 注入默认 provider 的运行时 API key。

### Pi 扩展

可通过 `PI_EXTENSION_PATHS` 配置要加载的 Pi 扩展：

```bash
PI_EXTENSION_PATHS=/absolute/path/to/pi-extension
```

### Web UI
可选独立 Web UI 通过 `pnpm web` 启动。

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
| `POST` | `/v1/sessions/:id/steer` | 引导运行中的任务 |
| `POST` | `/v1/sessions/:id/follow-ups` | 排队追加 follow-up |
| `POST` | `/v1/sessions/:id/abort` | 中止该会话当前正在执行的任务。请求体可以不填；如果填写，必须是 `{ "requestId": "..." }`，只有任务的请求 ID 与它一致时才会中止。ID 不匹配则返回 `409`，任务继续运行。 |
| `GET` | `/v1/sessions/:id/export` | 只读消息快照；绝不创建 runtime |
| `GET` | `/v1/sessions/:id/file-preview?path=<relative>&line=<optional>` | 预览该会话项目目录中的文本文件；`path` 填相对文件路径，`line` 可选，用于定位行号。不能读取项目目录外的文件 |

### 公共 API 契约 v1

- v1 请求、响应和 SSE 字段见 [OpenAPI 规范](openapi/v1.json)；客户端可从 `pi-agent-server/contract` 导入对应类型。插件路由及其字段由各插件独立定义，见[插件接入说明](docs/plugin-integration.md)。现有 v1 行为和字段保持兼容；可新增可选内容，破坏性变更需使用新版本。
- `GET /v1/access` 只返回 `{ canRead, canWrite }`：分别表示用户能否使用只读功能、提交或控制任务。`GET /v1/capabilities/<plugin-id>/access` 返回当前用户能使用该插件的哪些功能。权限配置见 [IP 访问控制](docs/ip-rbac-design.md)。
- 每次有意提交消息使用唯一 `requestId`，确保重试不会重复处理。同一服务进程运行期间，复用 ID 但提交不同内容会返回 `409`；此检查仅限进程内，重启后不保证识别内容变化。消息图片支持 PNG、JPEG 和 WebP，服务不会压缩图片。
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
| `DATA_DIR` | 进程 cwd | JSONL、服务 agent 目录和默认 SQLite 位置 |
| `DB_PATH` | `<DATA_DIR>/pi-agent-server.db` | SQLite 文件 |
| `PI_STORAGE_DIALECT` | `sqlite` | `sqlite` 或显式 `postgres` |
| `PI_DATABASE_URL` | 未设置 | PostgreSQL 必填 |
| `PI_ALLOWED_CLIENT_CIDRS` | **无默认；必填** | 允许访问服务的来源 IP 网段，例如 `127.0.0.0/8` |
| `PI_IP_ACCESS_POLICY_FILE` | 未设置 | 可选策略文件的绝对路径，用于为指定 IP 设置角色、禁用状态和 token 要求 |
| `PI_AUTH_PATH` | `~/.pi/agent/auth.json` | 非开发环境应使用服务专用文件 |
| `PI_MODEL_PROVIDER` / `PI_MODEL_API_KEY` | 未设置 | 默认 provider 运行时凭证注入 |
| `PI_DEFAULT_MODEL` | 未设置 | `provider/modelId` |
| `PI_DEFAULT_THINKING_LEVEL` | Pi 默认值 | `off` 至 `max` |
| `TOOLS` | `read,ls,find,grep` | 逗号分隔的完整工具列表；设置后替换默认列表，例如 `read,ls,find,grep,bash,edit,write` |
| `PI_PLUGINS` | 未设置 | 逗号分隔的显式加载、受信任同进程 ESM specifier；可以是包名，也可以是构建产物入口的绝对路径（裸机部署用后者，因为 `pnpm link` 在重建 `node_modules` 后不保留）；不扫描目录或 `.pi` |
| `PI_EXTENSION_PATHS` | 未设置 | 显式加载 Pi SDK 扩展的主变量，逗号分隔（绝对路径或 `~/…`）；不自动发现，无效路径或加载失败即拒绝启动。`PI_PROVIDER_EXTENSION_PATHS` 为已弃用兼容 alias：去除空白与空项后，仅旧变量得到非空列表时在路径校验前警告；两个变量都得到非空列表则拒绝启动 |
| `CORS_ORIGINS` | 空 | 允许在浏览器中调用本服务的网页地址；多个地址用逗号分隔，例如 `http://127.0.0.1:5173` |
| `PI_BACKUP_STAGING_ROOT` | 每用户私有应用目录 | 备份或数据库升级时使用的临时工作目录；通常无需设置 |

## 持久化与运维

- 元数据存于 SQLite 或 PostgreSQL；完整对话历史存于 Pi 管理的 JSONL。
- DELETE 把持久清理意图写入 `file_operations`，但仓库只提供只读 planner；物理执行不在当前范围。
- backup、restore、migration、reconcile 和 owner-transfer 均为离线命令，不启动服务，也不安装 timer/worker。`pi-agent-server-drill` 同样如此：做门禁（preflight）、执行隔离一键演习（run）与清理隔离运行产物（cleanup）。它绝不自动启动服务、安装 timer，也不触碰正式资源。
- PostgreSQL server、`pg_dump`、`pg_restore` major 必须匹配，并且有效业务 schema 必须非 `public`、非系统 schema。
- 只有相应环境门控的真实 PostgreSQL/age 检查实际运行时才能形成验收证据；skip 不算验收。

见[运维索引](docs/operations.md)、[备份与恢复](docs/backup-restore.md)和[数据库设计](docs/database-design.md)。

## 开发

```bash
pnpm test
pnpm typecheck
pnpm verify
pnpm verify:release     # 需要真实 PostgreSQL 与 age 前置条件
pnpm build
pnpm --filter web test
pnpm --filter web build
pnpm e2e
```

专项离线命令与 PostgreSQL 门禁见 [docs/operations.md](docs/operations.md)、[docs/postgres-podman-test.md](docs/postgres-podman-test.md)和 `package.json`。

## 文档

日常运维只需看这两份操作手册：

- [运维](docs/operations.md)：生产更新、服务管理、管理员 IP 与排障。
- [备份与恢复](docs/backup-restore.md)：密钥、定时备份、失败检查、恢复演练与保留策略。

研发参考：

- [架构](docs/architecture.md)与[数据库设计](docs/database-design.md)
- [IP 接入控制](docs/ip-rbac-design.md)
- [插件接入](docs/plugin-integration.md)
- [ADR 索引与维护约定](docs/decisions/README.md)

[归档资料](docs/archive/)收录历史安装步骤、已完成计划、验收记录及可选监控/IAM 规划，不作为当前生产操作手册。独立文档索引已移除，以本节为统一入口。
