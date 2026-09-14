[English](README.md) · **简体中文**

# pi-agent-server

pi-agent-server 是基于 Pi Agent Runtime 构建的长期运行、会话式 HTTP/SSE 服务，核心支持多用户访问。项目与会话管理用于组织工作和对话，同时提供流式任务控制、持久化、并发限制、路由 RBAC 与可配置工具权限。`web/` 中的 React/Vite 应用为可选独立客户端，Fastify 不托管该前端。

> **状态：Release Candidate（RC），尚非生产就绪。**

## 当前边界

- **当前面向内网：** 公网部署能力将在后续版本完善。
- **当前为单实例运行：** 后续计划支持多实例部署。
- **默认 Pi 工具：** `read`、`ls`、`find`、`grep`。通过环境变量 `TOOLS` 配置完整工具列表。
- **外部插件显式且受信任：** 通过 `PI_PLUGINS` 加载指定的同进程 ESM 插件。它是工程扩展边界，不是沙箱。
- **参考图片由宿主校验、不压缩：** `POST /v1/sessions/:id/messages` 可携带可选 `images: [{ mediaType, base64 }]`。宿主只接受静态 `image/png`、`image/jpeg`、`image/webp`，重新校验真实魔数与头部尺寸，并执行数量/体积/像素预算；宿主不压缩、不转码，也不新增图片上传路由或图片数据库。压缩由调用方客户端完成。
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

```bash
git clone <仓库地址>
cd pi-agent-server
pnpm install
```

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

`dev:real` 通过 tsx 的 `--env-file-if-exists=.env.local` 加载可选且已被 gitignore 的 `.env.local`。先复制已追踪且不含敏感值的模板：

```bash
cp .env.example .env.local
```

本地模板包含开发值 `DATA_DIR=/tmp/pi-agent-server`、`PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8`、`PI_DEFAULT_MODEL=openai-codex/gpt-5.6-luna` 和 `PI_DEFAULT_THINKING_LEVEL=medium`；使用前请修改机器相关路径。实际环境变量优先于 `.env.local`，文件值优先于应用默认值。`PI_ALLOWED_CLIENT_CIDRS` 必填，并按所有路由的直接 socket 对端 IP 匹配，探针也不例外。禁止提交 `.env.local`、认证信息、API key 或令牌。

`dev:real` 的数据库在 `/tmp/pi-agent-server`，服务启动只验证、不自动初始化。首次运行前（或清空 `/tmp` 后）初始化一次：

```bash
pnpm dev:real:init
```

该命令等价于离线 bootstrap 并回读验证；重复运行会因库非空而拒绝，之后直接运行 `pnpm dev:real` 即可。

默认凭证来源是 `~/.pi/agent/auth.json`。部署时应通过 `PI_AUTH_PATH` 指向服务专用凭证文件；也可以用 `PI_MODEL_PROVIDER` 和 `PI_MODEL_API_KEY` 注入默认 provider 的运行时 API key。

需要自定义配置时，手动设置环境变量再运行 `pnpm dev`：

```bash
export PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8
pnpm dev
```

可选模型默认值：

```bash
export PI_DEFAULT_MODEL=provider/modelId
export PI_DEFAULT_THINKING_LEVEL=medium
```

持久化数据库应先通过离线 migration 流程初始化或升级，并设置绝对 `AGENT_CWD`、`DATA_DIR`、`DB_PATH`，然后使用：

```bash
export PI_MIGRATION_GATE=verify
```

`verify` 只检查不可变 migration ledger 和 schema head；绝不应用 migration、reset 数据或 bootstrap baseline。PostgreSQL 必须使用非 `public`、非系统 schema 的 effective `current_schema()`。见[备份与恢复](docs/backup-restore.md)。

可选独立 Web UI 通过 `pnpm web` 启动。

## API 概览

所有路由都先检查来源 IP。`/health`、`/readyz` 不需要 token；`/metrics` 用于运维监控，只有 `admin` 和 `operator` 可以访问。如果策略文件要求某个 IP 出示 token，访问 `/metrics` 时也需要带上为该 IP 配置的 token。

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 存活检查 |
| `GET` | `/readyz` | 进程启动与 migration gate 就绪状态 |
| `GET` | `/metrics` | 固定 Prometheus 进程/readiness 指标 |
| `GET` | `/v1/access` | 由中央 RBAC 矩阵派生的最小访问能力投影 `{canRead, canWrite}` |
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
| `POST` | `/v1/sessions/:id/abort` | 中止任务。可省略 body 以兼容旧行为；如提供，必须严格为 `{ "requestId": "..." }`，且仅中止该当前请求。`requestId` 不匹配时返回 `409`，不会取消任务。 |
| `GET` | `/v1/sessions/:id/export` | 只读消息快照；绝不创建 runtime |

### 宿主公共 API 契约 v1

宿主只发布 v1 契约产物，不宣称自己是消费方的单一事实源。UI 与其它宿主消费者应从 `pi-agent-server/contract` 导入请求、响应和 SSE 类型。固定 OpenAPI 文档可通过 `pi-agent-server/openapi/v1.json` 获取；其检入源文件为 `openapi/v1.json`，`npm run generate:openapi` 会确定性地重新生成它。动态受信插件路由有意不属于此宿主契约。

消费方各自 pin 所依赖的已发布版本，并在本地测试中与之比对；跨仓产物比对属于人工/发布流程，宿主无法自行验证。

请求校验语义：Fastify 用其 AJV 基线校验 body 与 params，而非按 schema 中 `additionalProperties: false` 的严格读法。已声明类型会被强转（`coerceTypes: 'array'`，因此数字或单元素数组形式的 `title` 会被接受并转成字符串），未声明字段会被静默剔除（`removeAdditional: true`），而不是返回 `400`。因此 `400` 只表示缺少必填字段或值无法强转/越界，绝不表示标量类型错误或出现未知字段。`POST /v1/sessions/:id/abort` 是唯一例外：它没有 AJV schema，其手写解析器会对未知字段和非字符串值返回 `400`。文档级与每个经 AJV 校验且带 request body 的 operation 都带有 `x-pi-request-validation: { coerceTypes: true, removeAdditional: "silent-strip" }` 如实声明这一点。

在 v1 内，既有 operation、字段、状态语义和 SSE 事件 data 保持兼容；可以新增可选字段或 operation。破坏性变更必须提供新的版本化契约/path，而不能修改 v1。RC 期间，`src/server/app.ts` 的实际 API 仍是实现权威。

### 访问能力投影

`GET /v1/access` 返回最小固定响应体 `{ canRead, canWrite }`，由中央路由权限矩阵（`ROUTE_PERMISSIONS` + `evaluateRouteAuthorization`）派生，而非硬编码；绝不返回调用方的 `role`、IP 或 token。

- `canRead`：当所有读权限（会话列表/导出/事件流与 `capability:read`）对该角色开放时为 `true`，即 `viewer`、`user`、`admin`；
- `canWrite`：当所有写/控制权限（`sessions:send-message`、`sessions:control`、`capability:write`）对该角色开放时为 `true`，即 `user`、`admin`；
- `operator` 在整个 `/v1` 面被拒，因此返回固定 `403`，得不到任何投影。

该端点与其它只读 `GET` 路由使用同一读 RBAC，并受相同的 token 与 CORS 规则约束。若未来矩阵出现分项不一致，布尔值只会更保守（绝不误报可写），因此访问控制 UI 可安全地据此隐藏写操作。

### 消息输入与图片附件

- `POST /v1/sessions/:id/messages` 要求非空 `requestId`；`prompt` 通常必须非空，但至少一张图片通过权威校验时允许为空（仅图片消息）。两者都有长度上限（128 与 32,768 个 UTF-16 code unit），含非法控制字符时同样被拒。
- 可选 `images: [{ mediaType, base64 }]` 携带参考图片。支持的 `mediaType` 为 `image/png`、`image/jpeg`、`image/webp`。宿主在请求到达会话 runtime 之前，校验 canonical base64、真实魔数、头部尺寸、MIME 一致性与数量/体积/像素预算。非法图片返回 `400` 固定文案，绝不回显内容。
- 宿主不压缩、不转码图片；客户端应在提交前压缩。PNG/JPEG/WebP 逐字节透传到 Pi SDK 图片内容。
- 同一 `requestId` 携带不同内容重放返回 `409`，不再静默返回旧结果（`requestId` 是幂等键）。该检查仅限进程内，暂不能跨进程重启识别载荷变化，因为持久化幂等记录只保存终态结果。
- `GET /v1/sessions/:id/export` 将受支持的 user 消息图片投影为可选 `images: [{ mediaType, base64 }]` 字段，同样经过完整校验并有预算限制；畸形或超预算的图片块被省略而不是使导出失败。活会话与只读 JSONL 导出共用同一投影，逐字节一致。

## 访问控制

启动必须提供显式 CIDR allowlist：

```bash
export PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8
```

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
| `PI_PLUGINS` | 未设置 | 逗号分隔的显式加载、受信任同进程 ESM 插件包名；不扫描目录或 `.pi` |
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

从[文档索引](docs/README.md)开始。主要文档：

- [架构](docs/architecture.md)
- [数据库设计](docs/database-design.md)
- [IP-RBAC 设计](docs/ip-rbac-design.md)
- [ADR 索引与维护约定](docs/decisions/README.md)
- [ADR 0002：canonical baseline 与 migration 启动门禁](docs/decisions/0002-canonical-baseline-and-migration-gate.md)
- [备份与恢复](docs/backup-restore.md)
- [运维索引](docs/operations.md)
- [未来公网 IAM 规划](docs/identity-access-plan.md)
