# pi-agent-server 平台需求基线

基于 Fastify 与 Pi SDK 的长期运行 Pi Agent 服务。它提供与具体能力解耦的会话、控制、流式输出、鉴权和安全边界；能力通过显式注册的工具、提示词片段和（可选）后台 Worker 扩展，权限由各能力单独声明。

当前首个能力是[知识库问答与钉钉文档同步](docs/capabilities/knowledge-qa.md)。

> 本文是平台级需求基线；能力级需求以对应能力文档为准。核心数据流与模块解耦见[架构文档](docs/architecture.md)。

## 1. 目标

- 构建长期运行、能力可扩展的 Pi Agent 服务。
- 为 Agent 能力提供统一的 HTTP 会话 API、持久化会话与流式回答。
- 支持生成期间的 `steer`、`follow-up` 和 `abort` 控制。

**能力模型：**服务核心（会话生命周期、控制 API、SSE、鉴权与安全边界）与具体能力解耦。一项能力由 Pi 自定义工具（结构化工具）、项目命令（检索命令与构建命令）、系统提示词片段、能力 HTTP 接口，以及可选的后台 Worker 和数据源组成。新增能力以版本化 manifest 声明（工具类别、schema、权限范围、检索命令、构建命令、系统提示词（内联或文件路径）、HTTP 接口、Worker、数据源），作为注册、启用、会话冻结与审计的唯一来源，并在配置中显式启用；未被能力声明的工具与命令一律不可用。`dataSource` 涵盖目录（人工文档/同步/元数据/资源）、仓库与发布分支、外部来源（如钉钉 DWS 定位与凭证引用）与索引策略；敏感凭证仅允许引用密钥系统，不内联。

## 2. 非目标

- 默认禁用内置 `bash`、`edit`、`write`；需要时显式开启，或开发权限受限的 Pi 自定义工具。
- 当前阶段不要求 WebSocket；使用 SSE 下行流与 HTTP 控制接口。

各能力的业务非目标见其能力文档。

## 3. 平台架构

```text
客户端/UI
   │ HTTP + SSE
   ▼
pi-agent-server：Fastify + Pi SDK
   ├── 会话生命周期、控制、流式事件、鉴权与审计
   ├── 能力注册表、提示词组合与工具白名单
   └── AgentSession / SessionManager
             │
             ├── 已启用的能力工具
             └── 独立 Worker（能力需要时执行受控异步任务）
```

会话、控制与流式 API 面向所有能力通用。能力决定该会话可见的工具、数据源和提示词；核心不感知知识库、钉钉或其他业务语义。

## 4. 平台服务设计

### 4.1 技术选型

- 运行时：Node.js + TypeScript。
- HTTP 框架：Fastify，使用内置 Pino 日志（详见 §5 日志设计）。
- Agent：Pi SDK 的 `AgentSession` 与 `SessionManager`；用到的 SDK API 清单与官方文档定位方法见 [Pi SDK API 使用清单](docs/pi-sdk-api.md)。
- 流式输出：Server-Sent Events（SSE）。
- 会话存储：Pi JSONL 会话文件；服务数据库另存会话索引、任务状态和业务元数据。服务侧索引/元数据经存储访问层抽象（repository）读写，本地 SQLite/文件起步（SQLite 用 WAL 模式 + 写串行化，应对多用户写并发），预留外部数据库迁移。JSONL 与服务库写入按固定顺序（先 JSONL 后索引），启动时对账修复孤儿 JSONL 与无 owner 会话；跨存储非原子写入用状态标记避免重复任务。
- 后台任务：独立 Worker 处理经授权的异步任务；Job 进入持久化队列，按 Worker 并发数消费，超出排队；Job 需持久化状态机、幂等键、重试退避、租约/心跳与崩溃恢复，避免重启后重复执行副作用。
- 能力扩展：工具经统一注册表接入，系统提示词按已启用能力组合生成；核心不感知具体能力。

### 4.2 API（能力无关，第一版）

```text
GET    /v1/models                       可用模型、思考级别枚举与实际服务端默认值
GET    /v1/projects                     项目列表（默认项目 + 额外项目）
POST   /v1/projects                     创建项目（name + cwd）
DELETE /v1/projects/:id                 删除项目（级联删除其下会话；默认项目不可删）
POST   /v1/sessions                     创建会话（可选 projectId/modelProvider/modelId/thinkingLevel，未指定 projectId 时归默认项目；默认项目 id 为服务端固定常量 DEFAULT_PROJECT_ID，详见 docs/database-design.md）
GET    /v1/sessions                     会话列表（可选 ?projectId= 过滤）
DELETE /v1/sessions/:id                 删除会话
PATCH  /v1/sessions/:id                 重命名会话
PATCH  /v1/sessions/:id/config          切换模型/思考级别（持久化 + 透传 SDK）
GET    /v1/sessions/:id/export          导出会话
POST   /v1/sessions/:id/messages        发送输入（支持图片与从历史节点重跑）
PATCH  /v1/sessions/:id/messages/:mid   编辑历史消息
POST   /v1/sessions/:id/steer           向正在运行的会话插入指令
POST   /v1/sessions/:id/follow-ups      在当前任务结束后追加指令
POST   /v1/sessions/:id/abort           中止当前生成或工具调用
GET    /v1/sessions/:id/events          SSE 订阅回答、工具与状态事件
GET    /health                          存活与依赖检查
```

鉴权与用户标识：所有业务接口经 Bearer Token 鉴权（接入鉴权）；用户身份另由来源 IP（内网）或 pi-agent-server 签发的账号（公网）识别，统一抽象为 `UserIdentity`，Token 与身份分离——Token 校验通过后，身份取自 IP 或账号；每个用户只能访问自己的会话。内网以来源 IP 作为身份的前提是内网设备 IP 固定；NAT、共享出口或伪造 IP 的风险由网络边界控制，不在应用层解决。模型配置：服务端默认提供模型，用户可添加自定义模型（自己的 OpenAI 账号或 API key），默认与自定义模型可灵活选择使用；凭证归属用户（按 `UserIdentity` 隔离）、脱敏返回；自定义模型额度耗尽或凭证删除时回退服务端默认模型，平台总 token/成本配额另设、超限拒绝；存储见 §7。

**服务端默认模型配置：**可设置 `PI_DEFAULT_MODEL="provider/modelId"`（例如 `openai-codex/gpt-5.5`）与 `PI_DEFAULT_THINKING_LEVEL="medium"`。两者仅作用于未在会话中显式选择配置、且尚未产生 JSONL 历史的新会话；会话级模型/思考级别优先，已有历史会话会恢复其历史配置。配置的模型不存在、没有凭证或思考级别不合法时，服务启动失败而非静默回退。`PI_MODEL_PROVIDER`/`PI_MODEL_API_KEY` 仅用于注入服务端 API 凭证，不选择默认模型。

**系统提示词：**未设置 `PI_SYSTEM_PROMPT` 时使用 Pi SDK 的内置默认提示词；pi-agent-server 仍禁用项目与个人目录的自动发现，因此不会加载个人 `AGENTS.md`、skills 或 extensions。创建会话时按项目 cwd 生成并记录实际提示词，右侧 Inspector 可查看；设置 `PI_SYSTEM_PROMPT` 才会覆盖 Pi 默认提示词。

同一会话同一时刻只允许一个活动任务：

- 空闲时通过 `messages` 调用 `session.prompt()`。
- 流式生成中通过 `steer` 调用 `session.steer()`。
- 流式生成中通过 `follow-ups` 调用 `session.followUp()`。
- 中断通过 `abort` 调用 `session.abort()`，并向 SSE 发送 `aborted` 事件；并发槽位在任务确认终止（上游调用已停止或超时隔离）后释放，排队中的任务被取消时从队列移除。
- 不符合上述状态约束的请求返回 `409 Conflict`。

任务状态机：`idle → queued → streaming → terminal`，任务 `completed`/`aborted`/`error` 后回到 `idle`。`queued`（进入模型队列）可 `abort`（从队列移除）、不接受 `steer`/`follow-up`；`messages` 在 `queued`/`streaming` 时返回 `409`。

模型调用并发：全局与每用户设并发上限，超出排队；每用户队列有长度上限（如 10）与排队超时（如 5 分钟），超上限返回 `429`，排队状态通过 SSE 可见；并发上限可配置（起步：每用户 2、全局 20，取上游 rate limit 的 60–80%），按 SLO 观察调优；全局超载时返回 `429`/`503` 让客户端退避。

消息发送幂等：`messages` 请求必须携带客户端生成的 `requestId`，服务端按 `requestId` 去重——同一请求重复提交返回同一结果，不重复执行。

SSE 至少包含：`text_delta`、`tool_start`、`tool_update`、`tool_end`、`status`、`queued`、`error`、`completed`、`aborted`。事件带递增 id，支持 `Last-Event-ID` 断线续传；事件流持久化到服务库的有界缓冲，断连窗口内的事件可从缓冲补发；任务完成后提供按 owner 授权的会话消息/事件回放（复用 `GET /v1/sessions/:id/events`，带 `Last-Event-ID` 或时间范围参数）。SSE 长连接设每用户/全局连接数上限，超出返回 `429`。

### 4.3 工具与权限

默认仅启用内置只读工具 `read`、`ls`、`find`、`grep`，不启用 `bash`、`edit`、`write`，也不加载开发者个人全局配置。工具必须通过注册表显式声明读/写/执行类别、输入输出 schema、权限范围和输出上限；只有默认只读工具或已启用能力所声明的工具才对 Agent 可见。

只读工具须限制授权根目录或数据域、防止路径穿越、截断大输出，并保留来源信息。`bash`、`edit`、`write` 默认禁用，需要时显式开启，或开发最小权限的 Pi 自定义工具。

## 5. 日志设计

日志是运行与排障的核心，采用统一规范，贯穿 HTTP 服务与 Worker。

### 5.1 选型与形态

- 使用 Fastify 内置的 Pino，单行 JSON 输出，便于 Docker、Loki、ELK 等采集。
- 日志级别（`trace`/`debug`/`info`/`warn`/`error`）由 `LOG_LEVEL` 配置，生产默认 `info`。
- 通过 `redact` 在序列化阶段自动脱敏，避免敏感字段落入日志：

```ts
logger: {
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["req.headers.authorization", "token", "apiKey"],
    censor: "[REDACTED]",
  },
}
```

### 5.2 关联字段

每条日志应尽可能携带以下上下文字段，便于按请求、会话、任务串联：

- `requestId`：HTTP 请求级，`messages` 由客户端必填、用于幂等去重，其余请求未传由服务端生成；同时作为日志关联键。
- `sessionId`：Agent 会话；
- `jobId`：后台 Job；
- `capability`：能力名；
- `model`：模型标识；
- `tool`、`durationMs`、`status`：工具调用与结果状态。
- `subjectHash`：脱敏后的用户主体标识（`UserIdentity` 哈希），用于按用户聚合限流/成本/滥用，不记录原始 IP 或账号。

### 5.3 分级约定

- `debug`：内部细节、经白名单脱敏后的工具入参摘要；
- `info`：请求/任务生命周期、工具调用、生成阶段；
- `warn`：可恢复异常、重试、降级；
- `error`：失败、超时、中止异常。

### 5.4 生命周期日志

- HTTP 请求：记录开始、结束、状态码、耗时（Fastify 自动，附 `requestId`）。
- Agent 任务：`prompt` 开始，`steer`/`follow-up`/`abort` 触发，完成或中止。
- 工具调用：`tool_start`、`tool_end`，含工具名、耗时、结果状态。
- SSE 长连接：HTTP 请求日志只能反映连接整体耗时，生成开始、增量、工具调用、完成/中止等过程需单独记录。

### 5.5 脱敏与红线

记录：`requestId`、`sessionId`、`jobId`、能力名、模型、耗时、工具名、结果状态；且只记录经白名单生成的摘要，禁止直接序列化请求体、工具输入输出与原始异常对象。

不记录：`Authorization`、模型/钉钉/Git 等密钥、完整用户输入、系统提示词、文档正文、工具返回的敏感内容。

工具 schema 中的 secret 字段需标记并递归脱敏，嵌套凭证不得依赖固定 `redact` 路径。

### 5.6 Worker 日志

Worker 无 HTTP `request`，使用 `logger.child({ jobId, capability })` 创建带 Job 上下文的日志器，记录任务开始、步骤、重试、完成与关联提交/PR。

### 5.7 采集与保留

应用只输出 stdout，采集与保留属部署层决策，分两档：

- 起步（内网）：本地文件 + logrotate——stdout 重定向到文件，按体积/时间轮转，保留约 7 天。
- 规模化/公网：集中采集——Promtail/Filebeat → Loki/ELK，仅加采集器、应用代码不变；本地保留可缩短至约 3 天，集中库按查询需求保留约 30–90 天。

具体保留期由部署配置决定。

## 6. 可观测性与质量监督

日志与会话存储配合，共同承担服务质量监督，但职责与权限不同。

### 6.1 分工

| 维度 | 日志（§5） | 会话存储（JSONL + 服务库） |
|---|---|---|
| 关注点 | 运行健康（SLO/SLI） | 业务事实与内容质量 |
| 内容 | 延迟、错误、重试、工具起止、状态码 | 完整对话、工具结果、usage/cost |
| 敏感度 | 已脱敏，不含正文 | 含全文，权限更严 |
| 生命周期 | 高频、可聚合、短期 | 低频、可回放、按策略保留 |

### 6.2 关联键

`requestId`、`sessionId`、`jobId`、`subjectHash`（§5.2）贯穿两层：日志用于定位异常请求，`sessionId` 用于回放对应 JSONL 的完整上下文，`subjectHash` 关联服务库的 owner 映射（原始身份仅存于受控存储）。

### 6.3 质量指标分层

- 可用性/性能：日志聚合——请求与工具耗时、错误率、重试率、SSE 断连率、内存使用率，产出 SLO 告警。
- 成本：JSONL `usage.cost` 汇总，按能力/模型/会话聚合。
- 回答质量：采样 JSONL，校验引用路径与行号真实性、工具调用合理性。
- 异常追溯：日志定位 → JSONL 回放。

### 6.4 会话存储治理

Pi SDK 不设会话数量或文件体积上限，会话 JSONL 随对话单调增长；`compaction` 只压缩进 LLM 的上下文，不缩小文件。pi-agent-server 须自行制定：

- 活跃会话：有活动即保留，不归档；容量告警时优先归档最旧的不活跃会话，持续不足时进入拒写或人工处置。
- 不活跃会话：超过 N 天无活动 → 归档到冷存储 → 冷存储再保留 M 天 → 删除（归档 ≠ 立即删除）。
- Job 元数据：完成态 Job 保留 N 天可查后归档或清理；运行中/待重试的 Job 不清理。
- 备份：JSONL 不可重建，须定期备份（增量 + 全量，备份介质与生产磁盘分离）；服务库定期备份——索引可重建是兜底，业务元数据（owner 映射、凭证元数据、Job 状态）不可重建，不替代备份。备份须加密、受访问控制，并定期恢复演练校验。

N、M 天数由部署配置决定。

### 6.5 权限分级

- 日志：运维可读，已脱敏，用于聚合监控。
- JSONL：质量/审计专用，需更强访问控制与保留策略，不默认全团队可读。

### 6.6 存储容量治理

磁盘容量不足不得导致服务崩溃或数据损坏：

- 磁盘使用率纳入 SLI 监控，分级告警：

| 阈值 | 级别 | 动作 |
|---|---|---|
| 80% | 警告 | 开始归档清理最旧的不活跃会话 |
| 90% | 严重 | 停止接收新会话与 Job，只读继续，触发降级预案 |
| 95%+ | 临界 | 写操作可能开始失败，人工立即干预 |

- 内存使用率纳入 SLI 监控，同样分级告警：每个并发会话占上下文内存，内存不足会触发 OOM；监控进程堆与系统内存，长期运行关注堆增长趋势（排查泄漏）。

- 日志轮转与保留：应用只输出 stdout，轮转由部署层（Docker `max-size`/`max-file`、systemd journald 或 logrotate）配置；集中采集时本地保留期可相应缩短。
- 会话 TTL 归档：按 §6.4 保留周期主动归档或删除过期会话。
- 写路径优雅降级：磁盘满时写操作（新会话、追加消息、Job 结果）返回明确状态码（如 `507 Insufficient Storage`），不静默丢数据；读路径尽量保持可用。
- 日志尽力而为：日志写入失败不阻塞请求。
- 存储分卷：至少三个独立卷——日志（增长最快、可丢弃）、会话 JSONL（不可重建、最重要）、服务数据库（含可重建索引与不可重建业务元数据，如 owner 映射、凭证元数据、Job 状态）；日志必须与会话、数据库隔离，避免日志暴涨挤占。

## 7. 安全与运维要求

- 默认绑定 `127.0.0.1` 或内网网卡；业务 API 一律经 TLS（内网亦要求），公网部署额外增加 pi-agent-server 账号鉴权与网络边界控制。传输层与鉴权层预留 TLS 与账号签发接入点，不写死内网假设。
- 所有业务 API 使用 Bearer Token；部署环境增加每用户限流（QPS）、请求体大小限制和 CORS 白名单。
- 使用独立 `agentDir`、固定 `cwd`、固定系统提示词和固定工具列表，避免继承个人 Pi 配置；工具列表是已启用能力所声明工具的并集；系统提示词与工具列表按会话创建时的已启用能力生成并冻结，配置变更不影响既有会话。禁用项目目录自动发现（`.pi/extensions`、skills、prompts、`AGENTS.md`、themes），只从 manifest 显式注入受控资源，避免仓库中未声明的扩展被加载执行。
- 服务端默认模型用 API key（环境变量/密钥系统读取）；各能力凭证同理；不得写入仓库、会话或日志。
  - 实现例外（本机开发便利）：凭证文件默认指向开发者本机个人 `~/.pi/agent/auth.json`（与 pi CLI 共用，OAuth token 刷新由 SDK 回写该文件，同文件带锁并发安全）；**生产部署必须**通过 `PI_AUTH_PATH` 指向服务端独立凭证文件或 KMS，不得沿用默认个人路径。
- 用户自定义模型凭证：统一服务端加密存储（KMS）。支持 OAuth 登录（`login()` 授权、token 入库）或 API key 两种方式；不采用浏览器 localStorage 明文保存——XSS 可窃取、明文传输可被抓包、共享设备易残留；凭证不落明文库，按用户/会话独立 ModelRuntime 承载，会话期间经 `setRuntimeApiKey` 注入、结束后清零，禁止在共享实例上可竞争地设置用户密钥；日志按 §5 脱敏。
- **多项目 cwd 安全边界**：`POST /v1/projects` 允许指定任意 cwd，因此**公网部署不得开放创建项目接口**（应仅内网/管理面开放）。若未来开放公网创建项目，必须先限制 cwd 到服务端配置的项目根目录下（`realpath` 防 `..` 与符号链接逃逸），否则启用文件/命令工具后用户可将 Agent 指向服务账号可访问的任意目录。
- **内网免 token 与反向代理的组合边界**：内网免 token 依据 `request.ip` 判定来源；服务位于反向代理后且未配置 `TRUST_PROXY` 时，`request.ip` 是代理自身地址（常为 `127.0.0.1` 或私网 IP），会使所有经代理进入的公网请求被误判为内网、绕过 token。因此反向代理部署时**必须**配置 `TRUST_PROXY` 为具体代理 IP（并确保代理覆盖而非透传不可信的 `X-Forwarded-For`）；或将公网入口与内网免 token 入口隔离（不同端口/监听地址），避免公网链路上启用 IP 免鉴权。
- 日志字段、脱敏与分级遵循 §5 日志设计。
- 有副作用的流程应使用独立 Worker 或权限受限的 Pi 自定义工具；写仓库、创建 PR、构建和部署等权限必须按能力最小化授予并审计。
- 审计：有副作用的工具调用与 Job 须记录持久化审计——`UserIdentity`、会话/Job、工具/能力、授权范围、目标、结果、时间与关联 ID；不记录密钥与正文；审计记录单独定义保留期与访问权限，写入失败须告警。
- 优雅关闭：停止接收新请求 → 等在途任务完成或超时（超时后 abort、SSE 发送 `aborted` 并标记终态）→ 通知 SSE 客户端重连 → 退出；排队中的 Job 已持久化，重启后恢复。

## 8. 交付计划

当前数据库设计见[数据库设计](docs/database-design.md)；Phase 2 执行计划见[Phase 2 执行计划](docs/phase-2-execution-plan.md)；历史平台交付计划见[归档交付计划](docs/archive/delivery-plan.md)；能力级交付见各自能力文档（如[知识库问答](docs/capabilities/knowledge-qa.md)）。
