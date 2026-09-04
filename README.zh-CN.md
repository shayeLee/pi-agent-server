[English](README.md) · **简体中文**

# pi-agent-server

一个 Agent Server：将 Pi Agent Runtime 封装为长期运行、以会话为中心的 HTTP/SSE 服务。它负责请求认证与调用方身份识别、项目和会话生命周期、持久化、流式任务控制、并发与工具权限。

用户与集成方可以通过 HTTP/SSE API 与服务交互，并在此基础上构建自己的 UI、工作流或业务系统。独立的 Web UI（使用 React/Vite 构建，位于 `web/`）仅为随附的独立客户端，不是唯一或必须使用的 UI，也不是服务本体。

> **状态：** Release Candidate（RC）

> **重要限制**
>
> - **PostgreSQL** 存储已实现，但只有在当前环境实际运行 `PI_TEST_PG_URL` 门控的 PostgreSQL 集成套件时才可宣称真实验收通过。没有该 URL 时，PG 测试不是验收证据，也不得报告为通过。只有显式启用（`PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL`）才会使用。**尚非生产就绪**：服务启动尚未接入正式 migration、backup 或 rollback（RC 阶段）。
> - **备份/恢复状态：** WP3 的离线 SQLite/PG backup、restore、pre-migration 与 runbook core 已实现。真实 PostgreSQL 与 age gate 均受环境门控；当前 checkout 只有在所需 URL 与二进制存在且 gate 实际运行时才有真实 PG/age 验收证据。已发布的 pre-reset/pre-migration 包返回创建时 identity（manifest ciphertext SHA-256 加 source roots/binding digest），`verifyPublishedBackup` 会将其与已发布字节重新比对；SQLite pre-reset 备份额外在快照生成时点绑定完整 DB/WAL/SHM 面。Restore 会按已认证历史 migration 前缀（含 v0）做物理 schema 校验但不迁移，并逐行校验/计数 v1 `file_operations` outbox。PostgreSQL restore 拒绝已认证的 public/源 schema（未配置时 libpq 默认 `public` namespace 仅作 bootstrap 目标），要求 canonical 显式空 `pi_restore_*` 目标契约，且不发布零字节 dump。所有 WP3 工具均为离线开发期工具，不接入服务启动；服务级正式 backup/rollback/运行时集成未实施，WP3 仍非生产就绪。
> - **WP4A 状态：✅ 已验收；后续生命周期工作仍待完成。** v1 Manifest migration 已在 SQLite 与 PostgreSQL 增加持久 `file_operations` outbox。会话/项目删除在同一锁定数据库事务内写入经过相对白名单校验的 JSONL 路径，不设级联以避免丢 outbox，且绝不调用 `unlink`；lease token 可隔离旧 worker，lazy JSONL 创建有持久路径预留，restore 会逐行校验并计数 outbox。本次验收依据用户提供的真实 PG16+age `verify:release` 成功证据；本文不记录或推导测试数量。WP4B（outbox 执行器/retry/quarantine）与 WP4C（reconcile）尚未开始；WP5/WP6 尚未开始。尚未安装 outbox worker。
> - **受控 cutover 状态（WP2A）：实现与 reviewer 复审修复已在代码中；当前验收受环境门控，没有真实 PG/age 证据时不宣称通过；实际 reset 尚未开始。** 离线受控 cutover CLI（`pnpm cutover` / bin `pi-agent-server-cutover`）与可选严格启动 migration 门禁（`PI_MIGRATION_GATE=verify`，只读校验 ledger/head，默认 off）已实现，且强制真实 age / 真实 PostgreSQL 演练门禁已接入 `verify:release`。**实际 cutover 从未执行**——本工具从未对任何真实用户 SQLite/PG/JSONL 执行过 reset；对真实目标执行需运维/用户明确授权。复审后，reviewer 要求的加固（P0–P3）已落地：(1) PostgreSQL cutover 与 SQLite 同一受控 JSONL 清理——在验证过的 pre-reset 备份之后仅清理 `DATA_DIR` 下 `sessions/`/`projects/` 两个根，保留 `models.json`、绝不触碰凭证（在 gate 前置条件存在时由真实 PG CLI/compiled/installed bin 演练检查）；(2) cutover 路径安全 resolver 纳入 `PI_AUTH_PATH`/`PI_AGENT_DIR`，要求显式绝对 `DATA_DIR` 且不得等于/包含/被包含于 `AGENT_CWD`，并拒绝解析后的凭证、整个 canonical `agentDir` 根（含 `PI_AGENT_DIR=DATA_DIR`、祖先、symlink）或 `agentDir/models.json` 与 reset 面任意方向（含 realpath 别名）的 overlap（自定义凭证名/位置按解析路径保护，绝不依赖 `auth.json` 文件名；备份白名单与 reset 前复验执行同一规则）；(3) `migrationGate="verify"` 使用独立 gate Pool/Kysely 且始终销毁（失败亦然），成功后另建全新 actual Pool 完成 bootstrap——SQLite 门禁真只读：不存在的库绝不创建，快照副本连接以 `readOnly: true` 打开，已存在的 DB/WAL/SHM 保持 stat+byte 指纹一致；(4) 已发布备份包绑定 canonical source roots 加 SQLite DB stat/内容指纹或 PostgreSQL database/schema identity，cutover 在破坏性步骤前重新复验 binding——任何目标变化或 identity mismatch 在 DDL 事务前即零 reset 失败（SQLite 被替换的 inode/dev/nlink/指纹被拒；PG authenticated target 必须等于 `--target-schema`/当前 schema；对于 PG，若复验通过但 DDL/COMMIT 后失败，JSONL 清理已在 DDL 事务前执行且不可撤销，必须保留 pre-reset 备份供运维人工恢复）；(5) `--maintenance-window` 只接受逐字 `CONFIRMED`（大小写/空白变体一律拒绝）；(6) 对 `kind=pre-reset`，SQLite binding 覆盖完整 DB/WAL/SHM 面（存在性/dev/ino/nlink/mode/size/mtime/SHA-256），并在快照生成时点固定：`VACUUM INTO` 前立即指纹，快照后针对已验证相同状态复验，随后在任何 JSONL/age 工作开始前作为唯一不可变基准写入 manifest——后续发布/reset 只与该 binding 比较（禁止重新采集替换基准），任何变化——包括快照与 manifest 之间的 WAL-only 提交——都让备份与后续 cutover 零删除失败（日常 `sqlite-online` 备份不强制无写）；(7) PostgreSQL binding 额外覆盖 cluster/server identity——优先 `pg_control_system().system_identifier`（以 text 读取），并核对 database/schema OID、server addr/port、`cluster_name`——全部在单个专用 PoolClient 的同一个只读 `REPEATABLE READ` 事务内捕获，该事务同时通过 `pg_export_snapshot()` 导出快照：`pg_dump --snapshot=<id>` 在事务保持期间消费同一快照，导出不支持/失败即 fail-closed 拒绝备份；cutover reset 路径持有同一个已复验的专用 PoolClient，并在该连接/事务内执行 identity 复验与 `DROP SCHEMA`/`CREATE SCHEMA`/`GRANT`（绝不切换 Pool 连接、绝不 `DROP DATABASE`）；复验在 system identifier 不可用或为空时安全 fail（绝不回退到同名哈希），任何已绑定 identity 漂移都拒绝（复验在 DDL 事务前即拒绝，JSONL 清理尚未开始，schema 与 JSONL 均零删除），且备份拒绝 `current_database()` 与 URL database 不一致的连接；若 DDL/COMMIT 失败则 schema 变更回滚，但 **JSONL 已在 DDL 事务前被清理且无法自动恢复**——必须保留 pre-reset 备份由运维人工恢复，**绝不自动 restore、自动 down、自动重试**；(8) 备份创建返回已发布包 identity（manifest ciphertext SHA-256 加 source roots/binding digest），`verifyPublishedBackup` 将已发布的 manifest ciphertext、COMPLETE 标记与全部 payload 重新哈希并与创建 identity 比对；创建后被替换的 manifest ciphertext 或 COMPLETE 都零 reset 失败——全程无需用 private identity 解密 manifest；(9) compiled/npm cutover 失败演练真正传入单个逐字不匹配的确认 token 与专用 fail fixture 目录。WP2B（实际 cutover 执行）仍未完成——需要用户/运维显式目标授权，绝不可自动执行；以上不构成任何生产就绪承诺。详见 [docs/cutover-runbook.md](docs/cutover-runbook.md)。
> - **PostgreSQL client 兼容性：** backup core 与强制 gate 会安全查询 `SHOW server_version_num`，并解析 `pg_dump --version` 与 `pg_restore --version`。这三个 PostgreSQL major 必须完全一致；不匹配会在运行 `pg_dump`/`pg_restore` 前 fail-fast，错误只包含 client/server major 及 “install matching client”。不会过滤或篡改 dump。
> - Web 界面是**独立的 Web UI**（使用 React 和 Vite 构建，`web/`）。Fastify **不托管 `web/dist`**；需要自行运行 `pnpm web` / `pnpm web:mock` 并在浏览器中打开。

## 特性 Highlights

- **HTTP + SSE API** —— 通过 Server-Sent Events 流式输出回答，支持 `steer`、`follow-up`、`abort` 控制。
- **会话与工作区** —— 支持多个项目（各自独立工作目录）与按用户隔离的会话。
- **Web 界面** —— 管理项目与会话、选择模型和思考级别、在 inspector 面板中查看实时事件流。
- **持久化** —— 完整对话历史保存在 Pi JSONL 会话文件中；项目/会话元数据、请求幂等记录和文件清理 outbox 保存在 SQLite（默认）或 PostgreSQL（显式启用）中。删除只入队清理，绝不在请求中同步 unlink。
- **安全隔离** —— 使用独立的服务端 `agentDir`（不加载你个人 `~/.pi/agent` 的扩展/skill）、默认绑定回环地址、内网 IP 按来源地址识别（免 token）、公网使用 Bearer token 鉴权。

## 快速开始 Quick Start

### 前置条件

- **Node.js >= 22.19.0** 与 **pnpm**（web 应用是 pnpm workspace 成员）。

```bash
git clone <仓库地址>
cd pi-agent-server
pnpm install
```

### 零凭证 Mock 体验

无需任何模型凭证 —— mock 服务使用内置的假 Agent 和内存 SQLite 数据库。

```bash
# 终端 1：mock 服务，监听 http://127.0.0.1:8081
pnpm mock

# 终端 2：Web 界面，监听 http://127.0.0.1:5173（将 /v1 与 /health 代理到 mock）
pnpm web:mock
```

在浏览器中打开 **http://127.0.0.1:5173**。

说明：

- 默认内网 CIDR 包含 `127.0.0.0/8`，因此本机发出的请求按内网处理，**无需 token**。
- mock 返回固定的演示回复 —— 背后**没有真实模型**。

### 真实模型

凭证可来自以下三种来源：

1. **默认 —— 个人 pi CLI 凭证文件**：默认读取 `~/.pi/agent/auth.json`（与 pi CLI 共用）。
2. **`PI_AUTH_PATH`** —— 指定服务端专用的凭证文件（部署推荐）。
3. **`PI_MODEL_PROVIDER` + `PI_MODEL_API_KEY`** —— 为默认 provider 注入运行时 API key（不落盘）。

可选：为新会话调整默认模型：

```bash
export PI_DEFAULT_MODEL=provider/modelId   # 仅第一个 "/" 分隔 provider 与 model id
export PI_DEFAULT_THINKING_LEVEL=medium    # off | minimal | low | medium | high | xhigh | max
```

### 启动后端 API 服务

仅启动 Fastify Agent Server 后端（Web UI 为可选客户端）：

```bash
# API 服务，监听 http://127.0.0.1:8080
pnpm dev
```

如需使用 migration 工作流初始化的持久本地 SQLite 部署，请设置显式绝对路径，并在启动时校验 migration head：

```bash
export AGENT_CWD="$PWD"
export DATA_DIR="$HOME/Library/Application Support/pi-agent-server"
export DB_PATH="$DATA_DIR/pi-agent-server.db"
export PI_MIGRATION_GATE=verify
export PI_BACKUP_STAGING_ROOT="$HOME/Library/Application Support/pi-agent-server-backup-staging"

pnpm dev
```

`PI_MIGRATION_GATE=verify` 只校验 migration ledger；绝不会自动迁移、reset 或重建数据。持久空库必须先按[受控切换 runbook](docs/cutover-runbook.md)中的离线 migration 工作流初始化。前台运行的服务可通过 `Ctrl-C` 停止。

### 可选：启动 Web UI

在第二个终端启动独立的 Web UI，监听 http://127.0.0.1:5173；它会将 `/v1` 和 `/health` 代理到 8080 后端：

```bash
pnpm web
```

## 使用说明 Usage

### Web 界面

界面支持创建/重命名/删除会话、切换项目、设置会话的模型与思考级别、实时查看流式回答，并可打开右侧 **Inspector** 面板查看原始 SSE 事件流。内网探测失败时（非回环访问）会出现 Bearer token 输入框；token **只保存在浏览器内存中**，绝不写入 `localStorage`。

### HTTP API

API 路由位于 `/v1` 下（JSON）；`GET /health` 无需鉴权。速览：

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 存活检查（免鉴权） |
| `GET` | `/v1/models` | 可用模型、思考级别、服务端默认模型/思考级别 |
| `GET` | `/v1/projects` | 项目列表 |
| `POST` | `/v1/projects` | 创建项目（`name` + `cwd`） |
| `DELETE` | `/v1/projects/:id` | 删除项目 |
| `GET` | `/v1/sessions?projectId=` | 会话列表 |
| `POST` | `/v1/sessions` | 创建会话（可选项目与模型配置） |
| `PATCH` | `/v1/sessions/:id` | 重命名会话 |
| `PATCH` | `/v1/sessions/:id/config` | 修改模型 / 思考级别 |
| `DELETE` | `/v1/sessions/:id` | 删除会话 |
| `POST` | `/v1/sessions/:id/messages` | 提交提示词（必须携带 `requestId` + `prompt`；`202` = 已接受/排队） |
| `GET` | `/v1/sessions/:id/events` | SSE 事件流（可通过 `Last-Event-ID` 续传） |
| `POST` | `/v1/sessions/:id/steer` | 引导正在运行的任务（文本） |
| `POST` | `/v1/sessions/:id/follow-ups` | 追问（文本） |
| `POST` | `/v1/sessions/:id/abort` | 中止正在运行的任务 |
| `GET` | `/v1/sessions/:id/export` | 导出 `{ messages, lastEventId }` 快照 |

> RC 阶段响应结构仍可能调整 —— **以实际运行的 API（见 `src/server/app.ts`）为准**。

### Curl 示例

```bash
# 1. 存活检查（免鉴权）
curl http://127.0.0.1:8080/health
# {"status":"ok"}

# 2. 本机创建会话（内网 → 无需 token）
curl -i -X POST http://127.0.0.1:8080/v1/sessions \
  -H 'Content-Type: application/json' \
  -d '{"title":"demo"}'
# 201 + 会话记录

# 发送提示词（必须携带 requestId + prompt；202 = 已接受）
curl -i -X POST http://127.0.0.1:8080/v1/sessions/<SESSION_ID>/messages \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"req-1","prompt":"Hello"}'
# 202 {"status":"accepted"} ；流式回答经 GET /v1/sessions/<id>/events 推送

# 3. 公网 —— 使用 TOKENS 静态映射中的 Bearer token
curl http://<公网地址>:8080/v1/models -H "Authorization: Bearer <TOKEN>"
```

## 配置 Configuration

所有配置均通过环境变量（解析逻辑见 `src/main.ts`）。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口 |
| `HOST` | `127.0.0.1` | 绑定地址；仅在防火墙/代理保护下对外暴露 |
| `DATA_DIR` | 当前工作目录 | 服务数据目录：会话 JSONL、服务端 `agentDir`、SQLite 数据库文件 |
| `DB_PATH` | `<DATA_DIR>/pi-agent-server.db` | SQLite 数据库文件路径 |
| `PI_AUTH_PATH` | `~/.pi/agent/auth.json` | 凭证文件路径（默认与 pi CLI 共用） |
| `PI_MODEL_PROVIDER` | 未设置 | 用于注入运行时 API key 的默认 provider |
| `PI_MODEL_API_KEY` | 未设置 | 默认 provider 的运行时 API key（不落盘） |
| `PI_DEFAULT_MODEL` | 未设置 | 新会话的默认模型 `provider/modelId` |
| `PI_DEFAULT_THINKING_LEVEL` | 未设置（Pi 默认） | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `TOKENS` | 空 | 公网静态映射 `token1:acct1,token2:acct2`；服务端不签发 token |
| `INTRANET_CIDRS` | `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8` | 视为内网的客户端 IP（按来源 IP 识别身份，免 token） |
| `TOOLS` | 未设置 → `read,ls,find,grep` | 工具白名单；`bash`/`edit`/`write` 必须显式列出 |
| `TRUST_PROXY` | 未设置（不信任） | 逗号分隔的具体代理 IP 白名单；反代部署时必须配置 |
| `CORS_ORIGINS` | 空（CORS 关闭） | 逗号分隔的允许浏览器来源 |
| `PI_STORAGE_DIALECT` | `sqlite` | `sqlite` 或 `postgres`；空/空白归一化为 `sqlite`，未知非空值立即报错退出 |
| `PI_DATABASE_URL` | 未设置 | `PI_STORAGE_DIALECT=postgres` 时必填；缺失则启动失败（不回退 SQLite） |
| `PI_BACKUP_STAGING_ROOT` | `$HOME/Library/Application Support/pi-agent-server-backup-staging` | 仅 backup/migrate/cutover CLI：明文 staging 私有目录的显式绝对根，必须是当前用户 0700（SQLite `VACUUM INTO` 快照 / `pg_dump` 输出 / JSONL 副本）。默认为每用户 config 私有 staging 根（绝非共享系统临时目录）；根的完整祖先链必须非 sticky、不对 group/world 可写、属主为当前用户或 root。绝不位于 backup root 或其父目录内；backup root 的父目录无需可写 |
| `PI_MIGRATION_GATE` | `off` | 严格启动 migration 门禁：`verify` 在 schema bootstrap 前只读校验 migration ledger/head，空库/legacy/落后库 fail-fast（明确提示运行离线 cutover/migrate）；绝不自动迁移或 reset；未知非空值 fail-fast |

## 数据与存储 Data & Storage

- **SQLite（默认）** —— 项目/会话元数据、请求幂等记录与 v1 `file_operations` outbox 保存在 `DB_PATH` 指向的 SQLite 文件中（WAL 模式、外键开启）；PostgreSQL 使用相同逻辑 schema 与 Repository 契约。
- **对话历史** —— Pi SDK 将完整历史写入 JSONL 会话文件：默认项目位于 `<DATA_DIR>/sessions/<sessionId>/`，额外项目位于 `<DATA_DIR>/projects/<projectId>/sessions/<sessionId>`。数据库记录 JSONL 路径，重启后据此恢复会话。
- **服务端 agent 目录** —— `<DATA_DIR>/.pi-agent` 存放服务端 agent 配置（`models.json` 等），不继承个人 `~/.pi/agent`。
- **凭证** —— 默认 `~/.pi/agent/auth.json`，可用 `PI_AUTH_PATH` 覆盖。
- **Schema** —— 表/列/索引由单一运行时 Schema Manifest（`src/storage/schema-manifest.ts`）生成；详见 [docs/database-design.md](docs/database-design.md)。
- **PostgreSQL** —— 已实现，但真实验收仅在当前环境实际运行 **`PI_TEST_PG_URL` 门控**时成立；没有该 URL 不宣称通过（共享的方言无关 Repository 契约、真实唯一约束映射、旧 schema fail-fast）；存储集成门控用例只有在当前真实 PG 实例实际运行时才是验收证据。需显式 `PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL` 启用；空白方言保持 SQLite，未知非空方言立即报错退出。离线 WP3B2 `pg_dump`/`pg_restore` core 与 reviewer 的 P0/P1 修复已完成，并提供要求匹配客户端 major 的真实 `pg_dump`/`pg_restore` backup gate；只有实际运行该 gate 才是验收证据。Restore 使用 canonical 显式空 `pi_restore_*` contract，拒绝 authenticated public/source schema，并可在不预设 target URL `search_path` 的情况下从 target catalog 定位 non-public source schema（未配置的 libpq 默认 `public` namespace 仅作为 bootstrap target）。**libpq client major 必须与测试 server major 相同，且 `pg_dump`、`pg_restore` 使用同一 major。**可用 `psql ... -Atc 'SHOW server_version_num'` 安全查看服务端版本；按该 major 安装/使用 `libpq@<server-major>`（或等效的匹配 major 软件包），并将其 `bin` 放在 `PATH` 前面。不要把 major 18 当作唯一解。需要本地复跑时使用 Podman 临时 PG（[docs/postgres-podman-test.md](docs/postgres-podman-test.md)）。服务级 migration/备份/回滚接入尚非生产就绪。

## 安全与限制 Security & Limitations

- 默认绑定 **127.0.0.1**；仅在受控网络/防火墙下对外暴露。
- 内网 IP 按**来源 IP**信任（免 token）。公网必须使用 `TOKENS` 静态映射中的 Bearer token；**没有 token 签发接口**。
- **当前鉴权范围：** 服务端仅通过静态 `TOKENS` 环境变量映射进行公网 Bearer token 鉴权。目前没有用户登录系统、没有 token 签发接口、也没有按用户区分的身份管理。
- **后续规划（尚未实现）：** 完整的用户登录与身份与访问管理（IAM），涵盖三个层面 —— 认证（Authentication，用户登录）、身份识别/调用方身份解析（Identity，突破来源 IP 的身份判定）、授权（Authorization，权限校验）。规划能力包括 OAuth/OIDC 集成、Access Token（已确认的鉴权机制，不采用会话式鉴权）、API Key 全生命周期管理（签发、轮换、撤销、过期）、细粒度权限 scope 与审计日志。当前阶段不承诺具体时间线或实现细节；详细路线图（术语边界、目标架构、数据模型方向、分阶段工作包与待决策项）见 [docs/identity-access-plan.md](docs/identity-access-plan.md)。
- 默认工具白名单为**只读**（`read`、`ls`、`find`、`grep`）；`bash`、`edit`、`write` 除非在 `TOOLS` 中显式列出，否则禁用。
- `POST /v1/projects` 接受客户端提供的 `cwd` —— 公网生产部署**不要开放**该接口，否则认证客户端可在任意本地路径创建工作区。
- Web 界面中的 token **仅在浏览器内存中**（不写 `localStorage`）。
- 反代部署时需将 `TRUST_PROXY` 配置为代理的具体 IP（拒绝全信任与 CIDR），并为浏览器端配置 `CORS_ORIGINS`；否则转发的客户端 IP 仍不被信任，跨域 SSE 会被拒绝。
- **PG/age 状态** —— 仅当前环境实际运行真实 gate 才可验收：PG 需要 `PI_TEST_PG_URL`，age gate 需要 `age`/`age-keygen`。缺少前置条件时结果是 skip 或 fail-closed，绝不称为“通过”。WP4A 的 storage/outbox/restore 加固已依据用户提供的真实 PG16+age gate 成功证据验收，但 WP4B 的执行器/retry/quarantine 与 WP4C 的 reconcile 尚未开始；WP5/WP6 尚未开始。**尚非生产就绪**：服务级 migration、备份、回滚与生命周期接入尚未实施，仅限 RC 阶段使用。

## 开发与测试 Development & Testing

```bash
pnpm test               # 服务端测试（vitest）
pnpm typecheck          # TypeScript 类型检查（不输出）
pnpm verify             # 日常门禁：typecheck + test + build:backup
pnpm test:postgres      # 仅跑真实 PG 集成测试；PI_TEST_PG_URL 缺失/空白时失败（退出码 1）
pnpm test:pg-backup     # 强制真实 pg_dump/pg_restore + age 备份门禁；先检查 server/client major，不匹配时 fail-closed
pnpm test:migration-prebackup # 强制 WP3C 真实 PG migration 前备份门禁；缺 URL/工具时 fail-closed
pnpm cutover             # 离线受控 cutover CLI（WP2A；仅在完整确认链下才有破坏性——见 docs/cutover-runbook.md）
pnpm test:cutover        # 强制真实 age SQLite cutover 演练门禁（先运行 test:age）；缺 age/age-keygen 时 fail-closed
pnpm test:cutover-pg     # 强制真实 PostgreSQL cutover 演练门禁（随机 pi_cutover_* schema；库级 + 真实 CLI E2E，含 JSONL reset/binding/脱敏/fail path）；缺 URL/工具时 fail-closed
pnpm test:restore-real  # 真实 age 集成 + SQLite restore-core 门禁
pnpm verify:release     # 完整发布门禁：typecheck + test + test:postgres + test:pg-backup + test:migration-prebackup + test:cutover + test:cutover-pg + test:age（由 test:restore-real 调用）+ test:restore-real + build + build:migrate + build:backup + build:cutover（需要 PI_TEST_PG_URL 与全部真实二进制）
pnpm build              # 构建服务端（dist/）

pnpm --filter web test  # Web 单元测试
pnpm --filter web build # 构建 Web 应用（tsc -b && vite build）
pnpm e2e                # Playwright 端到端（自动启动 mock 后端与 Vite 服务）
```

- **发布门禁（P0）：** 不能在没有运行 typecheck、PG 测试被 skip、真实 PG backup 门禁被 skip、真实 cutover 演练门禁被 skip 或真实 age restore 门禁被 skip 时宣称完整验收。`pnpm verify:release` 依次执行 `typecheck` + `test` + `test:postgres` + `test:pg-backup` + `test:migration-prebackup` + `test:cutover` + `test:cutover-pg` + `test:age`（由 `test:restore-real` 调用）+ `test:restore-real` + `build` + `build:migrate` + `build:backup` + `build:cutover`；`release:rc` 发布前调用 `verify:release`。日常循环用 `pnpm verify`（typecheck + test + build:backup，无需数据库）。
- **Age 是发布门禁依赖：** `test:restore-real` 首先运行 `test:age`，要求同时安装 `age` 与 `age-keygen`。任一二进制不可用时，完整 release 验证会 fail-closed（以非零退出），而不是 skip restore 门禁。`build:cutover` 在设置了 `PI_TEST_PG_URL` 与所需二进制时，额外用随机 `pi_cutover_*` 真实 PG schema 运行 compiled 与 installed bin 的 cutover E2E（否则该节打印 skip 说明，而强制的 `test:cutover-pg` 门禁在缺 URL 时仍 fail-closed）。
- **PG 集成测试与普通 test 的 skip 保持区分：**
  - `pnpm test`（未设 `PI_TEST_PG_URL`）：`tests/postgres/` 整组 **skip**（既有门控，不报告通过、不发起连接）。
  - `pnpm test:postgres`（未设 `PI_TEST_PG_URL`）：**非零退出并说明原因**（发布门禁——skip 不是验收）。使用跨平台 Node runner（`scripts/test-postgres.ts`），绝不打印连接串。
  - 设置 `PI_TEST_PG_URL` 后，`pnpm test` 与 `pnpm test:postgres` 都会真实执行 `tests/postgres/` 用例；`pnpm test:pg-backup` 还要求 `pg_dump`、`pg_restore`、age 与 age-keygen，并执行隔离的 dump→加密→恢复门禁。完整验收循环请用 `pnpm verify:release`。
- **e2e** —— 本 RC 不宣称 e2e 已通过；请本地运行 `pnpm e2e` 自行验证（首次需 `pnpm --filter web exec playwright install` 安装浏览器）。
- 架构与核心数据流：[docs/architecture.md](docs/architecture.md)。存储设计：[docs/database-design.md](docs/database-design.md)。

## 文档 Documentation

- [docs/architecture.md](docs/architecture.md) —— 架构与核心数据流
- [docs/database-design.md](docs/database-design.md) —— SQLite / PostgreSQL schema 设计
- [docs/pi-sdk-api.md](docs/pi-sdk-api.md) —— Pi SDK 使用清单（HTTP 接口形态以 `src/server/app.ts` 为准）
- [docs/postgres-podman-test.md](docs/postgres-podman-test.md) —— 使用 Podman 进行本地 PostgreSQL 测试
- [docs/operations.md](docs/operations.md) —— 离线 migration/pre-backup 运维流程与门禁
- [docs/cutover-runbook.md](docs/cutover-runbook.md) —— WP2A 受控 cutover runbook（已实现；当前 PG/age 验收受环境门控；实际 cutover 未执行）
- [docs/backup-restore.md](docs/backup-restore.md) —— SQLite/PostgreSQL 备份、恢复与演练契约

内部阶段计划与归档文档（`docs/archive/`）不是用户入口。