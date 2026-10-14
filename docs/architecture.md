# 架构速览（核心数据流）

需求基线见 [needs.md](../needs.md)。

## 一、核心数据流

### 一次 `POST /v1/sessions/:id/messages` 请求

```text
① 准入   socket IP → CIDR / disabled / token → request.user + request.access
                                            network-admission.ts

② 授权   role + 路由 permission → allow / 401 / 403
                                            route-rbac.ts

③ 归属   private owner 校验 / shared native 来源策略校验
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
  → 内存未命中：KyselyIdempotencyRepository.reserve()
      → 已完成：校验 fingerprint 后返回终态，不调用 Agent
      → 已预约：保留状态未知屏障，不重跑
      → 取得唯一 token：执行 Agent turn
  → settle：内存 complete() + token CAS 写入持久化终态
```

`idempotency` 以 `(session_id, request_id)` 为复合主键，保存预约或 JSON 终态与 fingerprint。共享请求绑定 actor；未确认预约及文件请求屏障不按 TTL 清理。见[数据库设计](database-design.md#5-请求幂等与-ttl)。

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
- **删除**：旧 managed 引用在删除事务登记 outbox；source claim 仅保留索引墓碑。当前没有物理 `unlink` worker，`file-ops` 仅安全只读规划。
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

当前注册 `pi + pi-jsonl-v3`（managed）及 `pi + pi-native-jsonl-v3`（shared native）：Pi factory 管理 Pi SDK Session，对应 storage 校验和读取 Pi JSONL。新增 Agent 只需新增对应 factory/storage 注册，不改变 runtime、HTTP 或通用 session schema。

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

### 统一 Pi JSONL 落点与访问策略

生产新建 Web 会话和 CLI 来源共用 `PI_SESSION_SOURCE_DIR`（默认 CLI agent 的 `sessions`，通常为 `~/.pi/agent/sessions`），按 canonical cwd 编码目录和 SDK header timestamp/original ID 命名。`DATA_DIR` 默认 `~/.pi`，覆盖它不覆盖 source root；隔离部署/测试必须显式设置来源根。旧 server-ID 路径仅兼容读取，不移动文件。

Web 会话保持 private/managed，来源发现保持 shared/native；不新增第三种格式。既有 v2 `native_session_sources.binding` JSON 增加可选 `private` 标记，不改 schema/migration/checksum。source path 与 original ID 的既有唯一约束在排他创建文件前预约，随后写回 dev/ino；失败和删除保留 source 墓碑，扫描不得将私有文件认领为共享。源文件仅逻辑删除，不经 managed outbox 物理 unlink。准备中的 inode 使用 -1 哨兵，不可恢复；完成前中断保持 fail-closed。后续若确需新列，须新增 canonical migration，不重写 frozen v2。

`PI_SESSION_SHARE_EXCLUDE_CWDS` 只限制共享，不禁止该 cwd 使用 Web 私有会话；私有 FD 仍校验 canonical cwd/inode 与固定来源 allowroot，但不套 share exclusions。新建及恢复均由 FD `_persist` 追加，不调用 SDK 路径迁移。原始 Pi ID 与 server registry ID 分别保留，由 source claim 一对一绑定。没有 CLI/服务跨进程锁，禁止同时写同一文件。共享及私有 source claim 的文件预览仅采用校验后的 binding cwd。FD `_persist` 单次追加一行，短写/异常使 runtime 永久 poison，部分写入不回滚；校验与追加不是原子文件系统/DB 事务。导出与备份使用前后校验的只读 FD 快照，不重新打开路径。SSE live/replay/heartbeat 共用当前写入 FD 的 size/mtime/ctime/path identity 与 poison 校验（无 runtime 时仅校验有界 header），检测到外部修改即撤销旧 runtime，不逐 delta 重读全文。

SSE HTTP 层一次预取 output guard，在 heartbeat/live/replay 的每次 socket write 前同步检查。共享来源撤权关闭流并中止 runtime；私有 HTTP guard 不访问文件系统。检查不读取 JSONL full entries，路径政策失效不能只在 HTTP 入口拦截。

### 相关设计

- [IP RBAC](ip-rbac-design.md)
- [数据库设计](database-design.md)
- [备份与恢复](backup-restore.md)
- [reconcile JSONL](reconcile-jsonl.md)
