# Agent Session 创建与存储解耦计划

> **状态：已实施。** RC 阶段已把 Pi 从在线会话创建、恢复和数据库字段边界中解耦；当前仍只有 Pi 一个实际 Agent。离线 backup/restore/reconcile 目前仍是 Pi-only 实现，并对未知 kind/format fail-closed；不同 Agent 的能力差异及其离线策略等接入第二个 Agent 时再处理。

## 目标架构

当前：

```text
SessionRuntime
  → AgentAdapter
  → PiAgentAdapter

start.ts
  → Pi SessionManager / Pi JSONL / createAgentSession
```

目标：

```text
SessionRuntime
  → AgentAdapter                         # 保持当前完整能力接口

会话创建服务
  → AgentSessionFactoryRegistry
       → PiAgentSessionFactory           # 当前唯一实现

会话存储服务
  → ConversationStorageRegistry
       → PiJsonlConversationStorage      # 当前唯一实现
```

职责划分：

- **SessionRuntime**：状态机、并发、幂等、SSE；不依赖 Pi SDK。
- **会话创建服务**：读取 session 记录并协调引用 reservation；新建 factory 必须预留其唯一且稳定的实际引用。删除与清理 outbox 的同事务登记由 session/project repository 负责。
- **AgentSessionFactory**：创建或恢复某种 Agent Session，并返回 `AgentAdapter`。
- **ConversationStorage**：解释会话引用，提供在线只读导出、删除计划和 reconcile 引用规则；离线 backup/restore 当前仍由 Pi-only core 消费通用 descriptor，后续接入新 Agent 时再纳入同一 registry。
- **Pi 实现**：管理 Pi Session 与 Pi JSONL；在线路径、JSONL v3 校验和 SDK 调用不再散落在通用层。
- **start.ts**：只读取配置、创建依赖，并注册 Pi factory/storage 实现。

## 会话数据模型

直接删除 Pi 专有字段：

```text
pi_session_file
```

改为：

```text
agent_kind           # 当前固定为 "pi"（数据库默认值也是 pi）
conversation_format  # 当前固定为 "pi-jsonl-v3"（数据库默认值也是 pi-jsonl-v3）
conversation_ref     # 当前是 Pi JSONL 路径；首次运行前可为空
```

领域层只把 `conversation_ref` 当作不透明引用。未来其他 Agent 可以用远程 thread ID、对象存储 key 或其他引用形式。

项目尚未部署，因此本次直接修改 RC canonical baseline：不做旧字段兼容、双写或数据迁移。旧开发数据库和旧 checksum 的备份包不再兼容，需由操作者明确清理并重新 bootstrap。

## 核心数据流

### 创建或首次运行

```text
创建 session
  → 写入 agent_kind=pi、conversation_format=pi-jsonl-v3、conversation_ref=null

首次 messages / 需要 runtime 的操作
  → 会话创建服务读取 session
  → Pi factory 准备新的 Pi Session，并给出 conversation_ref
  → 会话创建服务先把 ref 写入数据库
  → Pi factory 创建实际 Pi Session / JSONL，并返回 PiAgentAdapter
  → SessionRuntime 执行任务
```

关键顺序是：**先以 `conversation_ref` reservation 持久化唯一稳定的实际路径，再允许 Pi 写 JSONL；打开成功后只以同一 reservation CAS 确认**。创建失败时 reservation 不会被复用，并登记清理操作，避免文件失去数据库或 outbox 锚点。删除会话时 repository 据此在同一事务登记对应的清理操作。

### Tombstone 语义：禁止复用已删除的 artifact

每次 reservation 都由会话创建服务**先**经 `ConversationStorage.planCleanup` 计算 proposed ref 对应的 `delete-artifact:<agentKind>:<conversationFormat>:<path-digest>` 键（该键不含 sessionId，同一 relative path + agent kind + conversation format 恒定），再把它作为 `tombstoneOperationKey` 传入 `reserveConversation`。删除会话或一次失败创建会把删除操作以同一键写入 `file_operations` outbox，形成 tombstone。

`reserveConversation` 在**同一条条件更新**中同时要求：`sessions.conversation_ref IS NULL` 且 `file_operations` **不存在**该 operationKey（SQLite/PostgreSQL 同语义）。只要 tombstone 存在——无论其状态是 `pending` / `processing` / `completed` / `failed`——reservation 一律被拒，即已删除的 artifact 永久禁止被新的会话复用；因此 SDK 在 reservation 成功前绝不会写 JSONL，也不能因为进程崩溃而重新占用一个已被删除的路径。

### 恢复已有会话

```text
需要 runtime
  → 会话创建服务读取 agent_kind + format + ref
  → 根据 kind/format 找到 Pi factory
  → Pi factory 校验并恢复 Pi Session
  → 返回 PiAgentAdapter 给 SessionRuntime
```

### 导出、删除与离线运维

```text
export
  → ConversationStorage 按 kind/format 只读解析会话历史

delete
  → ConversationStorage 生成清理计划
  → 数据库事务写入 file_operations outbox 并删除业务记录

backup / restore / reconcile（当前 Pi-only）
  → 读取通用 kind/format/ref descriptor
  → 由 Pi JSONL 规则处理 artifact、引用和 DB-only 分析
```

当前只有 Pi JSONL storage：删除仍只写 outbox，暂不物理 `unlink`；reconcile 仍是 DB-only，不读取 JSONL 或扫描文件系统。未知 kind/format 在这些离线入口 fail-closed；接入第二个 Agent 时再把离线规则正式纳入 registry。

## 本期边界

- Pi 仍是唯一注册的 `agent_kind`，客户端不能选择 Agent。
- `AgentAdapter` 仍要求完整实现现有能力；不在本期处理 `steer`、`follow-up`、分支、usage 等能力差异。
- 未注册的 `agent_kind` / `conversation_format` 必须 fail-closed，不能被当作 Pi JSONL 或普通文件处理。
- 新 Agent 接入时，提供自己的 factory 和 storage 实现；届时再设计能力差异、远程清理、备份和恢复策略。
