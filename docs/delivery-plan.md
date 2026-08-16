# 交付计划

平台级交付阶段。能力级交付（如知识库问答的检索、同步、发布）见各自能力文档。

> 本文与 README 一起构成需求基线，随需求调整同步更新。实现按[架构文档](architecture.md)的 TDD 骨架执行。

## 实现进度

阶段 1 核心已完成（TDD，根 214 测试 + web 51 测试 + Playwright E2E 2 条全绿）。

### 已完成

- 工程：pnpm workspace（根 pi-server + `web/` 子包）、ESM + TypeScript + Vitest。
- 核心纯逻辑：任务状态机（idle→queued→streaming→terminal）、并发控制（每用户/全局上限 + 队列 + 超时）、幂等去重（requestId）、身份识别（UserIdentity）、CIDR 内网判定。
- 存储：`SessionRepository` 抽象 + SQLite（WAL）实现。
- Agent 链路：SDK 事件→SSE 事件翻译（9 种）、`AgentAdapter` 接口 + `MockAgentAdapter` + `PiAgentAdapter`（真实 Pi SDK 接入）。
- 编排：`SessionRuntime`（状态机+并发+幂等+Agent 串成会话任务生命周期）、`SessionEventBus`（SSE 有界缓冲 + `Last-Event-ID` 续传）、`RuntimeRegistry`。
- HTTP：会话 CRUD、messages（图片 + `parentId` 历史重跑）、steer/follow-up/abort、SSE（工具流式 `tool_update`）、会话导出、健康检查。
- 鉴权：Bearer Token + 内网 IP（CIDR）/公网账号识别，会话按 owner 隔离。
- 优雅关闭：停止接收新请求 → 等在途任务完成或超时 → abort。
- 启动入口：`start.ts`（`ModelRuntime` + `SessionManager` + `createAgentSession` 组装）+ `main.ts`（环境变量 + 信号）。
- Web UI：React + Vite；会话管理、聊天、SSE 流式渲染、工具调用流式卡片；token 仅内存（不落 localStorage）。
- E2E：Playwright 真实浏览器跑通「填 token → 新建会话 → 发消息 → SSE 流式显示 → 删除」。

### 阶段 1 剩余 TODO

**安全与边界**

- [ ] 删除会话时清理对应 Pi JSONL 文件（持久化与重启恢复已实现：`piSessionFile` 字段 + `SessionManager.open` 恢复）。
- [ ] 请求体大小限制、图片大小/媒体类型/数量校验、CORS 白名单（README §7）。
- [ ] token 轮换/过期/撤销/scope（当前是长期静态映射）。

**功能完整性**

- [ ] 会话历史编辑（`PATCH /v1/sessions/:id/messages/:mid`）：SDK 编辑 API 待确认（`parentId` 重跑已支持）。
- [ ] 队列超时调度器：`expireQueued` 目前无调用方，需定时/提交时触发并回传 runtime 恢复状态。
- [ ] runtime/事件缓冲/幂等记录 TTL/LRU：避免长期运行内存增长（`RESUME_REGISTRY` 模块级全局 map 同样需要清理）。
- [ ] SSE 长连接每用户/全局连接数上限 + 慢客户端 backpressure。
- [ ] SSE 事件缓冲持久化（当前仅进程内，重启无法回放）。

**可观测性与运维**

- [ ] Pino 日志设计（README §5）：JSON 单行、`LOG_LEVEL`、redact 脱敏、`subjectHash`、任务/SSE 生命周期日志。
- [ ] QPS 限流（README §7 部署环境职责）。
- [ ] CIDR IPv6 支持（当前仅 IPv4）。
- [ ] 会话列表 `updatedAt` 随消息/终态更新。

**能力机制（阶段 2）**

- [ ] 版本化能力 manifest + 工具注册表：禁用了内置工具后，知识库问答等能力经 manifest 显式注入（`customTools`/`additionalExtensionPaths`/`extensionFactories`）。

## 阶段 1：平台核心与首个能力

- 初始化 TypeScript/Fastify 工程、配置与日志（按 README §5 日志设计）。
- 接入 Pi SDK、服务端默认模型（环境变量/密钥系统配置）、持久化会话（JSONL + 服务侧索引/元数据经 repository 抽象存储，本地 SQLite 起步）、SSE、`steer`、`follow-up` 和 `abort`。
- 实现 Token 鉴权、用户识别（内网按来源 IP，`UserIdentity` 抽象）与会话按用户隔离、限流、健康检查和基础测试。
- 会话管理 API：会话列表、删除、重命名、导出（对应 `SessionManager.list/listAll` 等）。
- 会话历史编辑与重新生成：修改历史消息后重跑（对应会话树 `navigateTree`/`branch`）。
- 多模态输入：图片随消息提交（对应 `prompt` 的 `images` 参数）。
- SSE 心跳与断线重连：`Last-Event-ID` 续传，长连接掉线可恢复；SSE 长连接设每用户/全局连接数上限。
- 优雅关闭：停止接收新请求 → 等在途任务完成或超时 → 通知 SSE 客户端重连 → 退出。
- 落地最小能力 manifest 与工具注册表（知识库问答能力据此接入，不硬编码）。
- 实现知识库问答能力；具体范围与验收见[能力文档](capabilities/knowledge-qa.md)。

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
