[English](README.md) · **简体中文**

# pi-agent-server

围绕 Pi Agent Runtime 构建的长期运行、会话型 HTTP/SSE 服务。它提供项目与会话管理、流式任务控制、持久化、并发限制、基于 IP 的准入、路由 RBAC 和可配置工具权限。`web/` 中的 React/Vite 应用是可选独立客户端；Fastify 不托管它。

> **状态：Release Candidate（RC），尚非生产就绪。**

## 当前边界

- **只支持单实例：** 每个 logical SQLite 数据库或 PostgreSQL schema 及其关联 `DATA_DIR` 只允许一个 pi-agent-server 进程。共享存储副本和实例重叠的滚动升级不受支持。
- **仅限内网：** 调用方身份来自 canonical 直接 TCP 对端 IP。所有路由都必须经过 `PI_ALLOWED_CLIENT_CIDRS`；绝不信任转发 IP header。未来 OIDC/IAM 与 workspace/sandbox 完成前禁止公网暴露。
- **不是 sandbox：** IP-RBAC 不限制项目 `cwd`、工具绝对路径或 OS 权限。默认工具白名单只读。正式启用 `bash`/`edit`/`write`、多实例或公网前必须完成 WP5B durable idempotency/shutdown 加固；当前没有 runtime guard 强制该治理策略。
- **仅逻辑删除：** 删除项目或会话会移除数据库可见资源，并把 JSONL 清理意图写入 `file_operations`。当前没有 outbox worker，也不会物理 unlink JSONL。
- **本机加密备份：** 离线 SQLite/PostgreSQL backup/restore 使用 age 加密并写入本机 `BACKUP_ROOT`，不覆盖主机/磁盘与备份同时丢失。age identity 私钥由运维托管，仅在恢复时提供。
- **恢复策略：** RPO 目标 24 小时；备份保留 30 天并人工清理。RTO 目标 4 小时，但 signoff 延期到项目投入使用且具备代表性数据规模后。
- **备份语义待调整：** 当前 strict backup 遇到缺失 session 文件引用会失败，backup 还会解析 JSONL 行。已确认目标为 missing-as-empty、opaque JSONL backup、invalid-as-empty restore；该目标尚未实现，见 [Phase 3 状态台账](docs/phase-3-data-retention-plan.md)。
- **Migration 行为待调整：** 当前 `PI_MIGRATION_GATE` 默认 `off`，`verify` 为 opt-in 且永不迁移。已确认目标是默认 `verify` 并增加显式 managed/RC 数据模式，仍然不自动 migration/reset；该目标尚未实现。

## 特性

- HTTP/JSON API 与 Server-Sent Events。
- 任务运行期间支持 `steer`、`follow-up` 和 `abort`。
- 按 IP 隔离项目和会话归属。
- 默认 SQLite；显式选择 PostgreSQL。
- Pi JSONL 对话历史，以及数据库元数据与请求幂等终态记录。
- 中央 default-deny 路由 RBAC，角色包括 `viewer`、`user`、`operator`、`admin`。
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

### 真实服务

`PI_ALLOWED_CLIENT_CIDRS` 必填，并按所有路由的直接 socket 对端 IP 匹配，探针也不例外。

```bash
export PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8
pnpm dev
```

默认凭证来源是 `~/.pi/agent/auth.json`。部署时应通过 `PI_AUTH_PATH` 指向服务专用凭证文件；也可以用 `PI_MODEL_PROVIDER` 和 `PI_MODEL_API_KEY` 注入默认 provider 的运行时 API key。

可选模型默认值：

```bash
export PI_DEFAULT_MODEL=provider/modelId
export PI_DEFAULT_THINKING_LEVEL=medium
```

持久化数据库应先通过离线 migration 流程初始化或升级，并设置绝对 `AGENT_CWD`、`DATA_DIR`、`DB_PATH`，然后使用：

```bash
export PI_MIGRATION_GATE=verify
```

`verify` 只检查不可变 migration ledger 和 schema head；绝不应用 migration 或 reset 数据。见[备份与恢复](docs/backup-restore.md)。

可选独立 Web UI 通过 `pnpm web` 启动。

## API 概览

所有路由都先经过直接对端 IP 准入。`/health`、`/readyz` 对任意 admitted role 免 token；`/metrics` 仅限 `admin`/`operator`，且画像 `tokenRequired=true` 时仍需绑定 IP 的 token。

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 存活检查 |
| `GET` | `/readyz` | 进程启动与 migration gate 就绪状态 |
| `GET` | `/metrics` | 固定 Prometheus 进程/readiness 指标 |
| `GET` | `/v1/models` | 可用模型与默认值 |
| `GET` / `POST` | `/v1/projects` | 列出或创建项目 |
| `DELETE` | `/v1/projects/:id` | 逻辑删除项目 |
| `GET` / `POST` | `/v1/sessions` | 列出或创建会话 |
| `PATCH` / `DELETE` | `/v1/sessions/:id` | 重命名或逻辑删除会话 |
| `PATCH` | `/v1/sessions/:id/config` | 修改模型/思考配置 |
| `POST` | `/v1/sessions/:id/messages` | 提交提示词（必须提供 `requestId`） |
| `GET` | `/v1/sessions/:id/events` | SSE；viewer 对无 live runtime 的会话收到 `204` |
| `POST` | `/v1/sessions/:id/steer` | 引导运行中的任务 |
| `POST` | `/v1/sessions/:id/follow-ups` | 排队追加 follow-up |
| `POST` | `/v1/sessions/:id/abort` | 中止任务 |
| `GET` | `/v1/sessions/:id/export` | 只读消息快照；绝不创建 runtime |

RC 期间以 `src/server/app.ts` 的实际 API 为准。

## 访问控制

启动必须提供显式 CIDR allowlist：

```bash
export PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8
```

可选的绝对路径 `PI_IP_ACCESS_POLICY_FILE` 能为精确 IP 定义：

- `role`：`viewer`、`user`、`operator` 或 `admin`；
- `disabled`；
- `tokenRequired` 与全局唯一的 `sha256:<64位小写hex>` token hash。

允许 CIDR 内未登记的 IP 使用 `role=user` 且关闭 token。Token 不能绕过 CIDR 准入、改变角色或跨 IP 使用。跨 owner 资源统一隐藏为 `404`；`admin` 也没有跨 owner 权限。

旧 `INTRANET_CIDRS`、`TOKENS`、`TRUST_PROXY` 以及已移除的 workspace 配置会导致启动失败。见 [IP-RBAC 设计](docs/ip-rbac-design.md)。

## 配置

| 变量 | 当前默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 端口 |
| `HOST` | `127.0.0.1` | 绑定地址 |
| `DATA_DIR` | 进程 cwd | JSONL、服务 agent 目录和默认 SQLite 位置 |
| `DB_PATH` | `<DATA_DIR>/pi-agent-server.db` | SQLite 文件 |
| `PI_STORAGE_DIALECT` | `sqlite` | `sqlite` 或显式 `postgres` |
| `PI_DATABASE_URL` | 未设置 | PostgreSQL 必填 |
| `PI_ALLOWED_CLIENT_CIDRS` | **无默认；必填** | canonical 直接对端 CIDR |
| `PI_IP_ACCESS_POLICY_FILE` | 未设置 | 可选绝对路径 JSON v1 策略 |
| `PI_AUTH_PATH` | `~/.pi/agent/auth.json` | 非开发环境应使用服务专用文件 |
| `PI_MODEL_PROVIDER` / `PI_MODEL_API_KEY` | 未设置 | 默认 provider 运行时凭证注入 |
| `PI_DEFAULT_MODEL` | 未设置 | `provider/modelId` |
| `PI_DEFAULT_THINKING_LEVEL` | Pi 默认值 | `off` 至 `max` |
| `TOOLS` | `read,ls,find,grep` | 副作用工具需显式配置并满足 WP5B 部署门禁 |
| `CORS_ORIGINS` | 空 | 逗号分隔的浏览器 origin |
| `PI_MIGRATION_GATE` | `off` | 当前接受 `off` 或只读 `verify`；目标默认 `verify`，尚未实现 |
| `PI_BACKUP_STAGING_ROOT` | 每用户私有应用目录 | 离线 backup/migration/cutover 明文 staging |

`PI_DEFAULT_WORKSPACE_ROOT`、`defaultWorkspaceRoot` 和 `workspaceRoots` 已移除；通过 runtime config 显式提供且值为 `undefined` 时也会拒绝。

## 持久化与运维

- 元数据存于 SQLite 或 PostgreSQL；完整对话历史存于 Pi 管理的 JSONL。
- DELETE 把持久清理意图写入 `file_operations`，但仓库只提供只读 planner；物理执行不在当前范围。
- backup、restore、migration、cutover、reconcile 和 owner-transfer 均为离线命令，不启动服务，也不安装 timer/worker。
- PostgreSQL server、`pg_dump`、`pg_restore` major 必须匹配。
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
- [Phase 3 状态台账](docs/phase-3-data-retention-plan.md)
- [备份与恢复](docs/backup-restore.md)
- [运维索引](docs/operations.md)
- [未来公网 IAM 规划](docs/identity-access-plan.md)
