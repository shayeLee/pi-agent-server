# Tool timeline export / 工具时间线导出

`GET /v1/sessions/{id}/export` remains owner-scoped and read-only. Pi transcript messages add `sourceId`, the actual JSONL message-entry id; it exactly joins `timeline[].messageId`. Existing legacy `messages[].id` is never rewritten. The additive `timeline` array is the ordered current Pi JSONL branch; it never includes sibling/orphan branches or thinking blocks. Image-only and empty-text prototype messages retain `sourceId`, so clients must join by id rather than text.

每次 `GET /v1/sessions/{id}/export` 仍按 owner 隔离且只读。Pi transcript 的消息新增 `sourceId`，它是真实 JSONL message entry id，且与 `timeline[].messageId` 精确关联。既有 legacy `messages[].id` 绝不会被改写。新增 `timeline` 是当前 Pi JSONL 分支的有序记录，不含兄弟/孤立分支或思考内容。仅图片和 text 为空的原型消息也保留 `sourceId`，客户端必须按 id 关联，不能按文本猜测。

```json
{
  "messages": [{ "role": "assistant", "text": "I will inspect it." }],
  "timeline": [
    { "id": "assistant-text:a1:0", "type": "message", "role": "assistant", "messageId": "a1", "turnId": "u1", "text": "I will inspect it.", "order": 1 },
    { "id": "tool-call:a1:1", "type": "tool_call", "messageId": "a1", "turnId": "u1", "callId": "call_7", "toolCallId": "call_7", "toolName": "read", "args": { "path": "a.ts" }, "status": "completed", "order": 2 },
    { "id": "tool-result:r1", "type": "tool_result", "messageId": "a1", "turnId": "u1", "callId": "call_7", "toolCallId": "call_7", "toolName": "read", "result": { "content": [{ "type": "text", "text": "full received output" }] }, "isError": false, "order": 3 }
  ],
  "lastEventId": 42
}
```

`callId`/`toolCallId` are the SDK call id and are the SSE merge/deduplication key. `id` is a stable JSONL-entry-derived timeline item id; `messageId` is the assistant entry that declared a call, and `turnId` is the current user entry. `no_result` means the persisted branch declares a call but has no persisted `toolResult` (for example after abort); it does **not** imply success. Timestamps and tool metadata such as exit codes appear only when Pi persisted evidence for them.

`callId`/`toolCallId` 是 SDK 调用 id，也是 SSE 合并/去重键。`id` 是由稳定 JSONL entry 派生的时间线项 id；`messageId` 是声明该调用的 assistant entry，`turnId` 是当前 user entry。`no_result` 表示持久化分支声明了调用但没有持久化 `toolResult`（例如 abort 后），**不**表示成功。时间戳及 exit code 等工具元数据仅在 Pi 已持久化证据时出现。

## Model failback SSE contract / 模型回退 SSE 合同

A `model_failback` SSE event always carries the request-local `attemptId`; `phase` is `start` or `end`. The terminal event may additionally contain `from`, `to`, and the safe classification `reason`, plus `outcome`. Clients should render/update one system event by `attemptId`; these model identifiers are not transcript content or provider error text.

`model_failback` SSE 事件始终带有请求内的 `attemptId`；`phase` 为 `start` 或 `end`。终态事件还可能带有 `from`、`to`、安全分类 `reason` 和 `outcome`。客户端应按 `attemptId` 渲染/更新同一个系统事件；这些模型标识不是 transcript 内容，也不是 provider 错误原文。

Persisted failback custom entries project as `timeline` `system_event` items. New engine entries include the exact internal continuation template; only its direct matching user child is hidden. For old entries, only the complete historical fixed template is hidden; unknown or ambiguous historical records remain visible rather than hiding real user input.

持久化的 failback custom entry 会投影为 `timeline` 的 `system_event` 项。新引擎 entry 包含精确的内部 continuation 模板；只隐藏其直接且完全匹配的 user 子项。旧 entry 仅在完整匹配历史固定模板时才隐藏；未知或歧义的历史记录保持可见，绝不隐藏真实用户输入。

## Client reconciliation / 客户端对账

While a turn is running, clients may merge tool lifecycle events by `toolCallId` and model failback events by `attemptId`. After reconnect, refresh, or session restore, fetch export and reconcile historical items by `timeline[].id`; reconcile live calls by `callId`. Render persisted tool results without an arbitrary client-side length cap.

会话运行时，客户端可按 `toolCallId` 合并工具生命周期事件，按 `attemptId` 合并模型回退事件。重连、刷新或恢复后，拉取 export 并按 `timeline[].id` 对账历史项，按 `callId` 对账仍在运行的调用。展示已持久化工具结果时不应设置任意客户端长度截断。

The host adds no 4096/240 KiB result cap: persisted text/JSON is returned in full. Data already truncated by the SDK/tool before it was written to JSONL cannot be reconstructed. Credential-like keys are redacted and image binary payloads are omitted. Sanitization and cloning are iterative; cyclic, non-JSON, or nesting deeper than 512 levels are represented as `{ "type": "export_unavailable", "reason": "..." }` so one payload cannot make the whole export fail. No separate detail endpoint is needed in v1.

宿主不增加 4096/240 KiB 结果上限：已持久化的文本/JSON 会完整返回。SDK/工具在写入 JSONL 前已经截断的数据无法重建。凭证类键会脱敏，图片二进制会省略。脱敏和 clone 使用迭代实现；循环引用、非 JSON 值或深度超过 512 层的结构会表示为 `{ "type": "export_unavailable", "reason": "..." }`，避免单个 payload 导致整份 export 失败。v1 不需要独立详情 endpoint。
