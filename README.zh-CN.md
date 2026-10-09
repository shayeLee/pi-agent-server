[English](README.md) · **简体中文**

# pi-agent-server

pi-agent-server 是基于 Pi Agent Runtime 构建的长期运行、会话式 HTTP/SSE 服务，核心支持多用户访问。项目与会话管理用于组织工作和对话，同时提供流式任务控制、持久化、并发限制、路由 RBAC 与可配置工具权限。`web/` 中的 React/Vite 应用为可选独立客户端，Fastify 不托管该前端。

> **状态：Release Candidate（RC），尚非生产就绪。**

## 当前边界

- **当前面向内网：** 公网部署能力将在后续版本完善。
- **当前为单实例运行：** 后续计划支持多实例部署。
- **Pi 工具默认授权：** `TOOLS` 未设置或为空/空白时，允许全部可用内置工具及显式加载的扩展/插件工具；保留 Pi 的工具激活及会话恢复行为。非空 `TOOLS` 是覆盖所有工具来源的完整白名单。**风险：** 默认允许命令执行和文件写入（含 `bash`、`edit`、`write`）；只读工具选择请设置 `TOOLS=read,ls,find,grep`，并另行落实文件系统/进程隔离。HTTP RBAC 和文件授权不变。
- **Pi 扩展：** 通过 `PI_EXTENSION_PATHS` 指定要加载的 Pi 扩展。不设置时不加载扩展。支持范围见下方[Pi 扩展](#pi-扩展)。
- **可按需增加业务功能：** 开发者可以把额外的工具、接口等功能做成 agent-server 插件，通过 `PI_PLUGINS` 配置启用。不需要额外功能时，无需配置。
- **Pi Session JSONL 暂不自动清理：** 删除项目或会话后，对应的 JSONL 文件仍会保留。
- **支持本机加密备份：** 备份与恢复工具已经提供，异地容灾仍在规划中。中断运行不自动续传：停止 writer，核验并仅清理本次产物后重做；原生恢复绝不覆盖已有文件。详见[备份与恢复](docs/backup-restore.md)。
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

不复制、不迁移旧格式、不删除源 JSONL。导出/预览按需读取。显示优先级为 Web 改名、最新原生 `session_info.name`、首条 prompt。发现最多缓存 128 个 cwd 的扫描结果 5 秒；标题元数据最多缓存 128 份按 stat 指纹区分的摘要，每个变化的源只读取不超过 1 MiB 的完整快照（摘要各限 512 字符）。更大历史的列表不提供标题/首条 prompt 回退；不会将截断扫描伪称最新标题。已登记的 private/managed 源路径不能被原生扫描认领。同一原件只对应一个 server session/runtime。逻辑删除为所有人登记持久墓碑，重启后不再发现。新建项目若 canonical cwd 重复（含符号链接别名和默认 cwd）返回 `409`；既有重复项目保留。

`PI_SESSION_SHARE_EXCLUDE_CWDS` 与 `PI_EXTENSION_PATHS` 一样按逗号分隔、trim 并去除空项；未设置/为空不排除任何目录。填写存在的绝对目录，按 **canonical real cwd 精确匹配**，不是前缀。配置最多允许 64 项。排除路径不存在或不是目录则拒绝启动；启动时固定 canonical 目标，但路径消失、inode 替换或别名重定向仍使全部原生访问 fail closed。已索引操作、每次原生 append、SDK 发射和 SSE 实时/补发输出同步复查目录元数据，不读 JSONL。撤权会关闭存量事件流并 abort/dispose runtime。SSE 传输一次预取 `SessionService.prepareOutputGuard()`，每次 heartbeat/实时/补发写入前同步检查；私有事件流不获取文件系统 guard。修改配置后重启，原件保持不变。

`PI_SESSION_SOURCE_DIR` 可覆盖原生来源根目录。默认使用 CLI `PI_CODING_AGENT_DIR` 下的 `sessions`，否则为 `~/.pi/agent/sessions`；与服务端 `PI_AGENT_DIR` 和 `DATA_DIR` 独立。发现不会创建缺失来源目录；Web 新建私有会话按需创建目标目录。跳过源符号链接、坏 header、cwd 不匹配及非 v3 文件。原生恢复使用经验证的 `O_RDWR|O_APPEND|O_NOFOLLOW|O_NONBLOCK` 描述符，不 create/truncate，并使用 SDK `SessionManager.inMemory(cwd, undefined, entries)`。全部祖先拒绝符号链接，FD/path 必须匹配索引绑定的普通、单链接 inode 与 stat 指纹。SDK `_persist` 经数字 FD 单次追加一行 JSONL；短写/异常永久 poison runtime。禁止会话替换/重写，`getSessionFile()` 仅为元数据。导出读取前后校验的只读 FD 快照，不重新打开路径。`readNativeSourceSnapshot(source, binding, maxBytes?)` 提供经验证的原始 bytes、encoded 根目录相对源路径及身份/stat 元数据，供后续 archive 接入；只有 external-required 索引、缺少这些 JSONL bytes 不算完整原生备份。**不要同时使用 CLI 和服务操作同一原件：** 尚无跨进程锁。这不是抵御恶意本地同 inode 写入者的 sandbox，校验与 append/output 也不是原子的文件系统/DB 事务；部分写入的行不会回滚。macOS 本地 fixture、Node 22.19.0 下，0/8/64 项排除配置的 2,000 次 FD 输出检查约耗时 116/333/1,855 ms，JSONL 读写均为零；元数据成本随排除项数量增长。Web 新建会话使用同一来源根及原生 `--encodedcwd--/<timestamp>_<original-id>.jsonl` 布局，不再使用 server-ID 目录。它们仍按 owner 私有隔离（`managed` origin），分享排除 cwd 也可创建私有会话。文件出现前 DB 同时预约 canonical source path 与原始 Pi ID，排他创建后绑定 inode。创建失败和删除保留 source 墓碑，扫描不能将私有文件提升为共享。旧 server-ID 引用保持可读，不移动或迁移文件。`DATA_DIR` 仍默认 `~/.pi/agent`；覆盖它不会移动 source root，隔离部署须显式设置 `PI_SESSION_SOURCE_DIR`。首版 backup/restore 显式拒绝原生引用（也影响 migration/owner-transfer pre-backup），不会静默漏掉历史；启用前需另行安排原生来源备份。启动此版本前须离线 apply 新增 v2 migration，再重启；启动仍只 verify。实现待 review，不代表生产验收。

项目发现每次请求最多推进 100 个目录/header 条目，每轮最多 4096 个顶层条目、每目录 4096 个条目；完整扫描缓存 5 秒，重复请求继续推进游标。自动项目由系统管理，不归首个查看者所有；发现不会授予写权限。无效、排除、私有已认领、仅剩墓碑的工作区不创建项目。`GET /v1/projects` 仅列出当前操作者至少可见一个会话的项目（默认项目也过滤），不会删除已存项目或文件；`canDelete` 表示项目所有权。可选 `canCreateSession` 同时体现路由 RBAC 和项目访问资格：有写权限的操作者，即使不是项目 owner，也可在当前策略允许可见共享会话或自己已有私有会话的项目中新建归属于自己的私有会话。其他操作者不能访问这些会话及其附件。项目完全没有当前操作者可见会话时，非 owner 不能新建或上传；exclude 撤销共享入口，但保留通过自己私有会话的访问。项目改名/删除仍仅限 owner；Web 按此创建能力控制，不改投默认 cwd。默认发现归属以当前配置的 `AGENT_CWD` 为准，而非 DB 保留的旧默认行。cwd 从 A 改为 B 后，已索引的共享 native A 会话仅通过索引元数据原子调整到独立的 canonical A 项目；会话 ID 与原始文件不变，B 绑定默认项目。既有私有 A 会话不重新归属或迁移；runtime cwd 身份检查仍强制执行，不兼容的继续操作会安全拒绝。显式创建项目仍返回空项目，Web 在内存保留该草稿以发送首条消息。列表为空时 Web 仍可向 `DEFAULT_PROJECT_ID` 首次发送，不显示空默认项目下拉条目。

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
| `DATA_DIR` | `~/.pi/agent` | JSONL、服务 agent 目录和默认 SQLite 位置 |
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
| `PI_APPEND_SYSTEM` | 未设置 | 追加系统提示词原文，**不是文件路径**；未设置、空串或纯空白不追加，有效多行文本保留原始空白。顺序：Pi 默认或 `PI_SYSTEM_PROMPT` 整体覆盖 → 此原文 → `PI_APPEND_SYSTEM_FILE` 原文 → capability fragments（能力片段）。程序化等价配置为 `StartConfig.appendSystemPrompt`。修改后需重启服务并新建会话；已有冻结提示词按字面量恢复，不再次追加。仍禁用 `APPEND_SYSTEM.md` 自动发现。 |
| `PI_APPEND_SYSTEM_FILE` | 未设置 | 显式 UTF-8 提示词文件；程序化等价配置为 `StartConfig.appendSystemPromptFile`。未设置、空串或纯空白路径不读取；路径首尾空白会去除。支持绝对路径；相对路径基于服务启动时的 `process.cwd()`，**不是** `AGENT_CWD` 或项目 cwd；不展开 `~`。启动时仅读取一次，所有新项目/会话提示词复用同份文本（cwd 或磁盘内容变化不重读）。保留多行空白；空/纯空白内容不追加。不存在、不可读、目录/非普通文件或非法 UTF-8 均拒绝启动，错误含变量名/路径，不含文件正文。顺序：默认/整体覆盖 → 原文 → 文件原文 → 能力片段。不自动发现 `APPEND_SYSTEM.md`。文件/配置修改须重启**并新建会话**；冻结会话不再次追加。 |
| `TOOLS` | 允许全部工具 | 逗号分隔的完整白名单，包含扩展/插件工具；未设置、为空/空白或仅逗号均视为未配置（允许全部）。例如 `read,ls,find,grep` 排除执行/写入工具。程序化 `StartConfig.tools=[]` 禁用全部工具，与环境变量空字符串不同。 |
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
