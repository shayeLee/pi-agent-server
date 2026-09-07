# 架构速览

本文件只说明主请求链和 Agent Session 解耦边界；认证、SSE、备份和运维细节见各自文档。

## 主请求链

```text
POST /v1/sessions/:id/messages
  → 网络准入、身份与 owner 校验
  → RuntimeRegistry.getOrCreate(sessionId)
  → SessionRuntime 的幂等、状态机和并发编排
  → AgentAdapter.prompt()
  → Agent 事件转换为 SSE
  → 幂等终态与会话历史持久化
```

`SessionRuntime` 负责状态机、请求幂等、并发槽位和 SSE 内存事件；它只依赖 `AgentAdapter`，不依赖 Pi SDK、JSONL 或其他具体 Agent。

## Agent Session 解耦

会话记录保存通用 descriptor：

```text
agent_kind + conversation_format + conversation_ref
```

当前唯一实现为 `pi + pi-jsonl-v3`，但客户端不能选择 Agent，服务端也只注册 Pi。

```text
首次需要 runtime
  SessionRuntime
    → SessionConversationCoordinator
    → 读取 session descriptor
    → AgentSessionFactoryRegistry[kind + format]
    → prepareNew() 或 restore()
    → AgentAdapter
    → SessionRuntime
```

### 首次创建

```text
factory.prepareNew() 计算会话引用
  → ConversationStorageRegistry[kind + format] 生成清理计划
  → repository 写入 conversation_ref
  → factory.open() 物化 Agent Session
  → repository CAS 确认同一引用
```

### 恢复、导出与删除

```text
恢复
  session descriptor → factory registry → restore() → AgentAdapter

无 runtime 的 export
  session descriptor → storage registry → readExport()  # 只读，不创建 runtime

delete
  session/project repository → storage registry → cleanup plan
  → file_operations outbox                         # 不直接 unlink
```

`conversation_ref` 非空时由 `(agent_kind, conversation_format, conversation_ref)` 唯一约束独占。删除登记使用 artifact 级 outbox key；已登记删除的引用不能再次写入 session。

## 边界

- **Factory**：创建或恢复具体 Agent Session，返回 `AgentAdapter`。
- **Storage**：解释引用，提供导出、清理计划和 reconcile 规则。
- **Coordinator**：协调 session 记录、factory、storage 与失败清理；不包含 Pi SDK 逻辑。
- **Repository**：保存通用 descriptor，并在删除事务中写入 outbox。
- **Pi 实现**：仅位于 `src/agent/pi-*`，管理 Pi SDK 与 Pi JSONL 路径/格式校验。

## 关键位置

| 位置 | 职责 |
| --- | --- |
| `src/runtime/session-runtime.ts` | 请求状态机、并发与事件编排 |
| `src/application/session-conversation-coordinator.ts` | 通用 Agent Session 协调 |
| `src/application/ports/conversation-port.ts` | factory/storage 通用端口与 registry |
| `src/agent/pi-agent-session-factory.ts` | Pi Session 创建与恢复 |
| `src/agent/pi-jsonl-conversation-storage.ts` | Pi JSONL 导出、清理与引用校验 |
| `src/storage/kysely-*-repository.ts` | session/project/outbox 持久化 |

相关文档：[数据库设计](database-design.md)、[备份与恢复](backup-restore.md)、[reconcile](reconcile-jsonl.md)、[IP RBAC](ip-rbac-design.md)。
