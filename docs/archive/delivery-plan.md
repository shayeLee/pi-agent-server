# 交付计划

> **归档提示**：本文是历史平台交付计划，已归档、不再维护更新；不应再作为当前存储计划修改。当前数据库表结构与存储规则见[数据库设计](../database-design.md)。

平台级交付阶段。能力级交付（如知识库问答的检索、同步、发布）见各自能力文档。

> 本文与 needs.md 一起构成需求基线，随需求调整同步更新。实现按[架构文档](../architecture.md)的 TDD 骨架执行。

## 实现进度

阶段 1 核心已完成，并经二十余轮严格 review 收敛（根 245 测试 + web 69 测试 + Playwright E2E 3 条全绿，根/web tsc 干净）。服务端核心、前端交互、安全边界、幂等语义、完成信号、资源生命周期、可观测性、多项目、模型/思考级别选择均通过 reviewer 验证。

### 数据存储演进路线图（RC）

数据存储演进的单一事实来源（含状态与验收）。当前为 RC：schema 变更直接删库重建，不做版本化迁移。

#### 当前决策 / 边界

- 当前为 RC：旧 SQLite 表结构与数据均可直接删除；不支持旧 schema 升级。
- 当前启动只面向空库或已是当前 schema 的数据库执行 bootstrap；旧库需删除重建。
- 保留 Kysely + `node:sqlite` 薄适配器与 Port/Repository 分层，为 PostgreSQL、加表、JOIN、动态查询服务。
- 当前没有 `kysely_migration` / 版本迁移机制（bootstrap 不产生 `kysely_migration`/`kysely_migration_lock` 表）。

#### 阶段表

| 阶段 | 状态 | 目标 | 主要工作 | 验收标准 |
| --- | --- | --- | --- | --- |
| Phase 1 | 已完成 | Kysely + SQLite 新库 bootstrap | Kysely 0.29.5 + `node:sqlite` 薄适配器（`NodeSqliteAdapter`）+ `SqliteDialect`；<br>`db-schema.ts` 类型化 schema：projects / sessions（FK `project_id → projects.id` ON DELETE CASCADE）/ idempotency（复合主键 `session_id + request_id`）；<br>索引：`idx_projects_owner`、`idx_sessions_owner_updated`、`idx_sessions_owner_project`、`idx_idempotency_created_at`；<br>文件库 WAL（`:memory:` 跳过）；<br>Repositories：`SqliteProjectRepository` / `SqliteSessionRepository` / `SqliteIdempotencyRepository`（Port/Repository 分层）；<br>测试：建表/索引/FK、WAL、幂等多启动、不产生 `kysely_migration` 表。<br>仅 bootstrap，**无**迁移机制。 | 全新库初始化出当前 schema（表/索引/FK 就位、WAL 生效）；不产生 `kysely_migration` 表；bootstrap/Repository 测试全绿。 |
| Phase 2 | 下一阶段 | PostgreSQL 空库支持 | `DATABASE_URL` / provider 配置（SQLite 默认、PG 可选）；`pg` 连接池 + Kysely `PostgresDialect`；SQLite/PG 共用 `db-schema.ts`（类型语义一致）；SQLite 与 PG 两套 bootstrap（同一 schema 描述、各自方言）；PG 集成测试。<br>边界：RC 下不做 SQLite→PG 数据迁移。 | 空 PG 库可启动并初始化出与 SQLite 一致的当前 schema；两类库共用 Repository 接口与测试；无数据迁移路径。 |
| Phase 3 | 未开始 | 扩展功能的数据模型和实现 | 开始前产出：实体/字段/关系、查询清单（JOIN / filter / sort / page / aggregation）、索引/权限、Port/Repository 草案；实现顺序：schema → bootstrap → repository/port → service → API → test。 | 新数据模型按草案落地并通过 SQLite/PG 两套 bootstrap 与 Repository 测试；查询清单各项均有测试覆盖。 |
| Phase 4 | 暂缓（临近正式发布） | 数据保留与正式迁移 | 暂缓：只有开始保留用户数据后才引入正式 schema migration、备份、回滚与数据迁移；当前**不**列为工作项。 | 进入 Phase 4 时定义（先冻结 destructive reset）。 |

#### 调整规则

- RC 结构变更可删库重建；每次变更同步更新 `db-schema`、对应 SQLite/PG bootstrap、Repository 与测试。
- 数据保留成为承诺时：先立刻冻结 destructive reset，再进入 Phase 4；不能继续用 `IF NOT EXISTS` 充当迁移。
- 本节是数据存储计划的单一事实来源；计划调整需同步更新状态/验收。

### 已完成

- 工程：pnpm workspace（根 pi-agent-server + `web/` 子包）、ESM + TypeScript + Vitest。
- 核心纯逻辑：任务状态机（idle→queued→streaming→terminal）、并发控制（每用户/全局上限 + 队列 + 超时 + 队列超时调度器）、幂等去重（三层模型）、身份识别（UserIdentity）、CIDR 内网判定。
- 存储：Kysely（0.29.5）+ `node:sqlite` 薄适配器 + `SqliteDialect`；`db-schema.ts` 类型化 schema（projects / sessions / idempotency + 索引 + FK）；`ProjectRepository` / `SessionRepository` / `IdempotencyRepository` Port 分层 + SQLite 实现；文件库 WAL（`:memory:` 跳过）；启动仅对空库/当前 schema 执行 bootstrap，RC 阶段不做旧库迁移（旧库删除重建）。
- Agent 链路：SDK 事件→SSE 事件翻译（9 种）、`AgentAdapter` 接口 + `MockAgentAdapter` + `PiAgentAdapter`（真实 Pi SDK 接入）；adapter 层事件 fencing（abort 后丢弃残余事件）。
- 编排：`SessionRuntime`、`SessionEventBus`（有界缓冲 + `Last-Event-ID` 续传 + backpressure）、`RuntimeRegistry`（删除墓碑 + pending 占位 + 跨会话接续）。
- HTTP：会话 CRUD、messages（图片 + `parentId` 历史重跑）、steer/follow-up/abort、SSE（工具流式 `tool_update`）、会话导出、健康检查。
- 鉴权：Bearer Token + 内网 IP（CIDR）/公网账号识别，会话按 owner 隔离；`subjectHash` 脱敏聚合。
- 删除生命周期：删除墓碑阻断重建 + disposed 检查 + 任务所有权（ownsTask）+ settle 绑定 taskKey + 删除顺序一致性（registry → SQLite → JSONL）+ dispose 释放并发槽位并接续排队。
- 完成信号：以最终 assistant `stopReason` 为结果权威（error/aborted/length→error/stop→completed），prompt resolve/reject 兜底；`agent_end`/`agent_settled` 不直接结算终态。
- 幂等语义：三层模型——in-flight promise（提交决策阶段合并同 key 并发）+ processing 占位（运行期返回「已接受」）+ done 记录（已完成返回原结果）。
- 优雅关闭：closeAllEvents → 等在途任务完成或超时 → abortAll（并行）→ dispose。
- 启动入口：`start.ts` + `main.ts`（环境变量 + 信号）；独立 agentDir（默认 `dataDir/.pi-agent`，承载 models.json 等）+ authPath 默认个人 `~/.pi/agent/auth.json`（与 pi CLI 共用、OAuth 刷新回写，`PI_AUTH_PATH` 可覆盖）、资源发现禁用（noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles）、默认禁内置工具（noTools:all）。
- 多项目：默认项目（服务端固定 `AGENT_CWD`，id="default"，不可删）+ 额外项目（`POST /v1/projects`，cwd 信任登录用户）；会话按 projectId 归属，`?projectId=` 过滤；删除额外项目级联删除其下会话；JSONL 会话目录按项目分（默认项目 `dataDir/sessions/`，额外项目 `dataDir/projects/<pid>/sessions/`）。
- 模型/思考级别：会话级模型（provider + modelId）与思考级别（off/minimal/low/medium/high/xhigh/max）选择；服务端用 `PI_DEFAULT_MODEL=provider/modelId` 与 `PI_DEFAULT_THINKING_LEVEL` 配置新会话默认值；`GET /v1/models` 暴露可用模型、枚举及 Pi SDK 实际解析出的服务端默认值，`PATCH /v1/sessions/:id/config` 切换并持久化（透传 SDK `setModel`/`setThinkingLevel`）；会话创建可指定，重启后按保存配置恢复。
- 安全边界：请求体大小限制、CORS 白名单、SSE 连接数上限（全局 100 + 每用户 10）。
- 可观测：Pino 日志（JSON 单行、LOG_LEVEL、redact 脱敏、subjectHash、异常仅记消息摘要）。
- Web UI：React + Vite 的 agent harness；参考 ChatGPT/Claude 的居中对话布局：左侧会话列表、中间居中聊天区（最大宽度 860px）+ 底部 docked 输入框、右侧 Inspector 面板（事件流 / 工具 / 配置三 tab）；整体视觉重构（现代暗色主题、圆角卡片、头像气泡、彩色事件徽章、毛玻璃 header、状态指示灯）；多项目切换器；会话配置栏（模型 / 思考级别，放在 Inspector「配置」tab）；Markdown 渲染（react-markdown + GFM）、工具调用流式卡片、SSE 事件日志（按类型过滤/清空）、steer/follow-up/abort 控制、会话搜索/重命名/导出、状态栏；token 仅内存（不落 localStorage）；乐观更新（messageId 绑定 + requestId 服务端确认 + 幂等重试对账）。
- E2E：Playwright 真实浏览器跑通「填 token → 新建会话 → 发消息 → SSE 流式显示 → 删除」。

### 阶段 1 剩余（非阻塞，v1 不交付）

- [ ] 会话历史编辑（`PATCH /v1/sessions/:id/messages/:mid`）：SDK 编辑 API 不公开（仅私有 `_replaceMessageInPlace` + 消息无稳定 id），需 entryId 贯穿 + 消息数组替换，留作阶段 1.5 独立功能。
- [ ] 图片大小/媒体类型/数量精细校验（bodyLimit 已限总大小）。
- [ ] token 轮换/过期/撤销/scope（当前是长期静态映射）。
- [ ] SSE 事件缓冲持久化（当前仅进程内，重启无法回放）。
- [ ] 会话列表 `updatedAt` 随消息/终态更新。

**部署环境职责（needs.md §7，非应用核心）**

- [ ] QPS 限流。
- [ ] CIDR IPv6 支持（当前仅 IPv4）。

## 阶段 1：平台核心与首个能力

- 初始化 TypeScript/Fastify 工程、配置与日志（按 needs.md §5 日志设计）。
- 接入 Pi SDK、服务端默认模型（环境变量/密钥系统配置）、持久化会话（JSONL + 服务侧索引/元数据经 repository 抽象存储，本地 SQLite 起步）、SSE、`steer`、`follow-up` 和 `abort`。
- 实现 Token 鉴权、用户识别（内网按来源 IP，`UserIdentity` 抽象）与会话按用户隔离、限流、健康检查和基础测试。
- 会话管理 API：会话列表、删除、重命名、导出（对应 `SessionManager.list/listAll` 等）。
- 会话历史编辑与重新生成：修改历史消息后重跑（对应会话树 `navigateTree`/`branch`）。
- 多模态输入：图片随消息提交（对应 `prompt` 的 `images` 参数）。
- SSE 心跳与断线重连：`Last-Event-ID` 续传，长连接掉线可恢复；SSE 长连接设每用户/全局连接数上限。
- 优雅关闭：停止接收新请求 → 等在途任务完成或超时 → 通知 SSE 客户端重连 → 退出。
- 落地最小能力 manifest 与工具注册表（知识库问答能力据此接入，不硬编码）。
- 实现知识库问答能力；具体范围与验收见[能力文档](../capabilities/knowledge-qa.md)。

**验收：**客户端可创建会话、获取增量回答、在生成期间 steer 或停止；会话可列表/删除、历史可编辑重跑；支持图片输入；SSE 断线可重连；会话按用户隔离；并发受上限控制、消息幂等去重、违反状态约束返回 409；问答 Agent 无法调用通用 Bash 或写文件。

## 阶段 2：能力扩展机制（完善）

- 阶段 1 已落地最小 manifest/注册表；本阶段完善能力配置、启用开关与审计。
- 验证新增一个只读工具无需修改会话、控制和流式核心即可被 Agent 使用。

**验收：**新增工具可经配置接入；未被能力声明的工具不可用；`bash`、`edit`、`write` 默认禁用，需显式开启或开发工具。

## 阶段 3：用户自定义模型与凭证存储

- 支持用户添加自定义模型（OpenAI 账号或 API key），与服务端默认模型灵活切换。
- 凭证走服务端 KMS 加密存储，仅会话期间注入，不落明文库。

**验收：**用户可添加自定义模型并在会话中切换；凭证加密存储、不明文落库。

## 能力 Backlog

阶段 1-3 之后的候选能力，按优先级排列。

### 中期（P1）

- token 用量配额与成本限制：按用户限制模型成本，防止失控。
- 长期记忆：跨会话记住用户偏好与背景。
- 角色与权限：管理员/普通用户分层。

### 远期（P2）

- 子 Agent / 多 Agent 编排：调度 + 执行结构。
- 回答质量评测与 A/B：评测集与指标。
- 相似问题缓存：降低重复提问成本与延迟。
- 音视频输入：ASR 转写 / 视频抽帧预处理后入模型。
