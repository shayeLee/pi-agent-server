# 架构速览（核心数据流）

需求基线见 [needs.md](../needs.md)。

## 一、核心数据流

### 一次 `POST /v1/sessions/:id/messages` 请求

```text
① 准入   socket IP → CIDR / disabled / token → request.user + request.access
                                            network-admission.ts

② 授权   role + 路由 permission → allow / 401 / 403
                                            route-rbac.ts

③ 归属   session.owner_key == request.user
                                            session-service.ts

④ 会话   getOrCreate runtime → 读取/创建/恢复 Agent Session → AgentAdapter
                                            runtime-registry.ts → session-conversation-coordinator.ts

⑤ 幂等   见下方「⑤ 幂等流程」

⑥ 状态   idle → queued → streaming → terminal → idle
                                            task-state-machine.ts

⑦ 并发   全局/每用户槽位 → run / queue / 429
                                            concurrency-control.ts

⑧ 执行   AgentAdapter.prompt() → 规范 Agent 事件
                                            session-runtime.ts

⑨ 推送   Agent 事件 → SseEvent → 内存事件总线 → SSE 字节
                                            session-event-bus.ts → sse-format.ts

⑩ 持久化 Agent 会话历史 + SQLite/PostgreSQL + 幂等终态/删除 outbox
                                            storage/kysely-*-repository.ts
```

`SessionRuntime` 负责同会话状态机、全局/每用户并发、请求幂等和事件总线；它只依赖 `AgentAdapter`。HTTP 层只做准入、授权与状态码映射，不承载会话编排。没有 live runtime 的 viewer SSE 订阅返回 `204`；export 是只读分支，不创建 runtime。

### ⑤ 幂等流程

```text
POST messages(sessionId, requestId)
  → inFlightSubmits 命中：复用同一个执行 Promise
  → 内存 IdempotencyStore 命中 done：返回内存终态
  → 内存未命中：KyselyIdempotencyRepository.get()
      → 命中 idempotency 表：返回持久化终态，不调用 Agent
      → 未命中：执行 Agent turn
  → settle：内存 complete() + repository.put() 写入终态
```

`idempotency` 表以 `(session_id, request_id)` 为复合主键，`result` 保存 JSON 终态。`KyselyIdempotencyRepository` 以 `ON CONFLICT` 写入，SQLite 与 PostgreSQL 共用；Registry 按 TTL 清理过期记录。

### 控制、持久化和离线操作

```text
steer / follow-up
  → SessionRuntime 状态校验 → AgentAdapter 对应操作 → 保持当前并发槽位

abort / turn 结束
  → AgentAdapter.abort() 或 terminal 事件 → settle() → 释放全局/每用户并发槽位

backup / restore / migration / reconcile / owner-transfer / file-ops
  → 独立 CLI → SQLite 或 PostgreSQL + DATA_DIR
  → 不经 HTTP 主链
```

- **状态与并发**：状态机保证一个 session 同时只执行一个 turn；并发控制负责全局/每用户槽位和队列。
- **数据库**：Repository 保存项目、会话、幂等和 `file_operations`。SQLite/PG schema 均由 manifest 定义；服务启动只校验 migration，不自动迁移。
- **删除**：session/project 删除在数据库事务中登记 outbox；当前没有物理 `unlink` worker，`file-ops` 仅安全只读规划。
- **部署边界**：一个 SQLite 库或 PG schema 及关联 DATA_DIR 只支持一个服务实例；多实例需共享存储和分布式协调改造。

## 二、解耦模块

### Agent Session

会话记录保存通用 descriptor：

```text
agent_kind + conversation_format + conversation_ref
```

```text
首次需要 runtime
  SessionRuntime
    → SessionConversationCoordinator
    → session descriptor
    → AgentSessionFactoryRegistry[kind + format]
    → prepareNew() 或 restore()
    → AgentAdapter
    → SessionRuntime

首次创建
  factory.prepareNew() 给出引用
    → ConversationStorageRegistry[kind + format] 生成清理计划
    → repository 写入 conversation_ref
    → factory.open() 物化 Agent Session
    → repository CAS 确认同一引用

无 runtime 的 export
  session descriptor → storage registry → readExport()

delete
  session/project repository → storage registry → cleanup plan → file_operations outbox
```

Factory 创建或恢复具体 Agent Session；Storage 解释引用、导出历史并生成清理计划；Coordinator 协调三者，不包含 Pi SDK 逻辑。`SessionRuntime` 不依赖 Pi SDK 或 JSONL。

当前只注册 `pi + pi-jsonl-v3`：Pi factory 管理 Pi SDK Session，Pi storage 校验和读取 Pi JSONL。新增 Agent 只需新增对应 factory/storage 注册，不改变 runtime、HTTP 或通用 session schema。

非空 `(agent_kind, conversation_format, conversation_ref)` 由唯一约束独占。删除写入 artifact 级 outbox tombstone，已登记删除的引用不能重新绑定。

### 分层与依赖方向

| 层 | 职责 | 关键位置 |
| --- | --- | --- |
| `core/` | 状态机、并发、身份与策略等纯逻辑 | `task-state-machine.ts`、`concurrency-control.ts` |
| `application/` | 业务服务与通用 ports | `session-service.ts`、`session-conversation-coordinator.ts`、`ports/` |
| `runtime/` | 会话执行、幂等和事件编排 | `session-runtime.ts`、`runtime-registry.ts` |
| `server/` | HTTP、网络准入、RBAC、SSE 与组装 | `app.ts`、`start.ts` |
| `agent/` | Agent adapter 与 Pi 实现 | `agent-adapter.ts`、`pi-*.ts` |
| `storage/` | SQLite/PG repository、schema 与 outbox | `kysely-*-repository.ts`、`schema-manifest.ts` |

依赖方向为 `core/application/runtime → ports ← server/storage/agent`：核心不依赖 Fastify、数据库或 Pi SDK。厂商协议适配仅归一化事件；工具执行仍走 Pi 原生白名单与授权路径。

### 相关设计

- [IP RBAC](ip-rbac-design.md)
- [数据库设计](database-design.md)
- [备份与恢复](backup-restore.md)
- [reconcile JSONL](reconcile-jsonl.md)
- [Agent Session 解耦计划](agent-session-decoupling-plan.md)
