[English](README.md) · **简体中文**

# pi-agent-server

一个 Agent Server：将 Pi Agent Runtime 封装为长期运行、以会话为中心的 HTTP/SSE 服务。它负责请求认证与调用方身份识别、项目和会话生命周期、持久化、流式任务控制、并发与工具权限。

用户与集成方可以通过 HTTP/SSE API 与服务交互，并在此基础上构建自己的 UI、工作流或业务系统。独立的 Web UI（使用 React/Vite 构建，位于 `web/`）仅为随附的独立客户端，不是唯一或必须使用的 UI，也不是服务本体。

> **状态：** Release Candidate（RC）

> **重要限制**
>
> - **PostgreSQL** 存储已实现，**并已通过 `PI_TEST_PG_URL` 门控的真实 PG 集成测试验证**——全部门控用例（45 个，含最终测试审计新增的共用 Repository 契约、真实唯一约束映射与严格 schema preflight）已由 `pnpm verify:release` 在真实 PG 实例上全部通过。只有显式启用（`PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL`）才会使用。**尚非生产就绪**：暂无正式的数据迁移、备份与回滚机制（RC 阶段）。
> - Web 界面是**独立的 Web UI**（使用 React 和 Vite 构建，`web/`）。Fastify **不托管 `web/dist`**；需要自行运行 `pnpm web` / `pnpm web:mock` 并在浏览器中打开。

## 特性 Highlights

- **HTTP + SSE API** —— 通过 Server-Sent Events 流式输出回答，支持 `steer`、`follow-up`、`abort` 控制。
- **会话与工作区** —— 支持多个项目（各自独立工作目录）与按用户隔离的会话。
- **Web 界面** —— 管理项目与会话、选择模型和思考级别、在 inspector 面板中查看实时事件流。
- **持久化** —— 完整对话历史保存在 Pi JSONL 会话文件中；项目/会话元数据与请求幂等记录保存在 SQLite（默认）或 PostgreSQL（显式启用）中。
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

然后启动服务：

```bash
# 终端 1：API 服务，监听 http://127.0.0.1:8080
pnpm dev

# 终端 2：Web 界面，监听 http://127.0.0.1:5173（将 /v1 与 /health 代理到 8080）
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

## 数据与存储 Data & Storage

- **SQLite（默认）** —— 项目/会话元数据与请求幂等记录保存在 `DB_PATH` 指向的 SQLite 文件中（WAL 模式、外键开启）。
- **对话历史** —— Pi SDK 将完整历史写入 JSONL 会话文件：默认项目位于 `<DATA_DIR>/sessions/<sessionId>/`，额外项目位于 `<DATA_DIR>/projects/<projectId>/sessions/<sessionId>`。数据库记录 JSONL 路径，重启后据此恢复会话。
- **服务端 agent 目录** —— `<DATA_DIR>/.pi-agent` 存放服务端 agent 配置（`models.json` 等），不继承个人 `~/.pi/agent`。
- **凭证** —— 默认 `~/.pi/agent/auth.json`，可用 `PI_AUTH_PATH` 覆盖。
- **Schema** —— 表/列/索引由单一运行时 Schema Manifest（`src/storage/schema-manifest.ts`）生成；详见 [docs/database-design.md](docs/database-design.md)。
- **PostgreSQL** —— 已实现并已通过 **`PI_TEST_PG_URL` 门控的真实 PG 集成测试**验证（共享的方言无关 Repository 契约、真实唯一约束映射、旧 schema fail-fast）；全部门控用例已由 `pnpm verify:release` 在真实 PG 实例上通过。需显式 `PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL` 启用；空白方言保持 SQLite，未知非空方言立即报错退出。需要本地复跑时使用 Podman 临时 PG（[docs/postgres-podman-test.md](docs/postgres-podman-test.md)）。尚非生产就绪：暂无正式 migration/备份/回滚。

## 安全与限制 Security & Limitations

- 默认绑定 **127.0.0.1**；仅在受控网络/防火墙下对外暴露。
- 内网 IP 按**来源 IP**信任（免 token）。公网必须使用 `TOKENS` 静态映射中的 Bearer token；**没有 token 签发接口**。
- **当前鉴权范围：** 服务端仅通过静态 `TOKENS` 环境变量映射进行公网 Bearer token 鉴权。目前没有用户登录系统、没有 token 签发接口、也没有按用户区分的身份管理。
- **后续规划（尚未实现）：** 完整的用户登录与身份与访问管理（IAM），涵盖三个层面 —— 认证（Authentication，用户登录）、身份识别/调用方身份解析（Identity，突破来源 IP 的身份判定）、授权（Authorization，权限校验）。规划能力包括 OAuth/OIDC 集成、Access Token（已确认的鉴权机制，不采用会话式鉴权）、API Key 全生命周期管理（签发、轮换、撤销、过期）、细粒度权限 scope 与审计日志。当前阶段不承诺具体时间线或实现细节；详细路线图（术语边界、目标架构、数据模型方向、分阶段工作包与待决策项）见 [docs/identity-access-plan.md](docs/identity-access-plan.md)。
- 默认工具白名单为**只读**（`read`、`ls`、`find`、`grep`）；`bash`、`edit`、`write` 除非在 `TOOLS` 中显式列出，否则禁用。
- `POST /v1/projects` 接受客户端提供的 `cwd` —— 公网生产部署**不要开放**该接口，否则认证客户端可在任意本地路径创建工作区。
- Web 界面中的 token **仅在浏览器内存中**（不写 `localStorage`）。
- 反代部署时需将 `TRUST_PROXY` 配置为代理的具体 IP（拒绝全信任与 CIDR），并为浏览器端配置 `CORS_ORIGINS`；否则转发的客户端 IP 仍不被信任，跨域 SSE 会被拒绝。
- **PG 状态** —— 已通过 `PI_TEST_PG_URL` 门控的真实 PG 集成测试验证；当前扩展门控（45 个用例）已由 `pnpm verify:release` 在真实 PG 实例上通过。**尚非生产就绪**：无正式 migration、备份与回滚，仅限 RC 阶段使用。

## 开发与测试 Development & Testing

```bash
pnpm test               # 服务端测试（vitest）
pnpm typecheck          # TypeScript 类型检查（不输出）
pnpm verify             # 日常门禁：typecheck + test
pnpm test:postgres      # 仅跑真实 PG 集成测试；PI_TEST_PG_URL 缺失/空白时失败（退出码 1）
pnpm verify:release     # 完整发布门禁：typecheck + test + test:postgres + build（需要 PI_TEST_PG_URL）
pnpm build              # 构建服务端（dist/）

pnpm --filter web test  # Web 单元测试
pnpm --filter web build # 构建 Web 应用（tsc -b && vite build）
pnpm e2e                # Playwright 端到端（自动启动 mock 后端与 Vite 服务）
```

- **发布门禁（P0）：** 不能在没有运行 typecheck 或 PG 测试被 skip 时宣称完整验收。`pnpm verify:release` 依次执行 `typecheck` + `test` + `test:postgres` + `build`；`release:rc` 发布前调用 `verify:release`。日常循环用 `pnpm verify`（typecheck + test，无需数据库）。
- **PG 集成测试与普通 test 的 skip 保持区分：**
  - `pnpm test`（未设 `PI_TEST_PG_URL`）：`tests/postgres/` 整组 **skip**（既有门控，不报告通过、不发起连接）。
  - `pnpm test:postgres`（未设 `PI_TEST_PG_URL`）：**非零退出并说明原因**（发布门禁——skip 不是验收）。使用跨平台 Node runner（`scripts/test-postgres.ts`），绝不打印连接串。
  - 设置 `PI_TEST_PG_URL` 后，`pnpm test` 与 `pnpm test:postgres` 都会真实执行 `tests/postgres/` 用例；完整验收循环请用 `pnpm verify:release`。
- **e2e** —— 本 RC 不宣称 e2e 已通过；请本地运行 `pnpm e2e` 自行验证（首次需 `pnpm --filter web exec playwright install` 安装浏览器）。
- 架构与核心数据流：[docs/architecture.md](docs/architecture.md)。存储设计：[docs/database-design.md](docs/database-design.md)。

## 文档 Documentation

- [docs/architecture.md](docs/architecture.md) —— 架构与核心数据流
- [docs/database-design.md](docs/database-design.md) —— SQLite / PostgreSQL schema 设计
- [docs/pi-sdk-api.md](docs/pi-sdk-api.md) —— Pi SDK 使用清单（HTTP 接口形态以 `src/server/app.ts` 为准）
- [docs/postgres-podman-test.md](docs/postgres-podman-test.md) —— 使用 Podman 进行本地 PostgreSQL 测试

内部阶段计划与归档文档（`docs/archive/`）不是用户入口。