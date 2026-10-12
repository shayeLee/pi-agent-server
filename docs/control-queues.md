# Control queues / 控制队列

This document describes the implemented resident control queue and its boundaries. Unit, isolated SDK/HTTP and browser checks passed; the verified scope and remaining device/deployment limits are recorded in [DESIGN.md](../DESIGN.md).

## API

- `GET /v1/sessions/:id/control-queue` returns the authoritative `{ requestId, revision, items }` snapshot.
- `DELETE /v1/sessions/:id/control-queue/:controlId` removes one resident steer or follow-up item.
- `POST /v1/sessions/:id/control-queue/:controlId/promote` moves a resident follow-up to steer.
- Both mutations require the control identity (`requestId`, `acknowledgementId`) in JSON and return a snapshot. The actor is taken from authenticated access, not request JSON. Missing sessions return `404`; malformed identity is `400`; unknown, wrong-actor/run identity, or already-dequeued items conflict with `409`. Successful repeated mutations are idempotent within the run.
- Correlated `POST .../steer` and `POST .../follow-ups` admission returns an empty `202`; legacy text-only follow-up remains empty `204`. Admission is not consumption or task completion.

## Guarantees and limits

Queue rows are actual resident SDK objects from the authoritative snapshot, not local pending/submission notices. The snapshot exposes control ID, kind, text, image presence, queued status, acknowledgement ID and revision; it does not expose actor PII, image bytes or custom SDK messages. It is in-memory runtime state: do not rely on persistence across server restart. Revisions use a per-session, process-lifetime clock, including absent-runtime snapshots, so recreating a runtime cannot roll them back. The client carries the known SSE server epoch when reconnecting and resets queue authority on a server-generation change, fencing old in-flight responses.

The integration uses public synchronous SDK queue methods (SDK **1.1.0**): temporarily select `all` mode, enqueue a sentinel, inspect with `peekQueuedMessages()`, clear the matching queue, and restore the original objects synchronously without `await`. Rebuilding entries from text or `Session.clearQueue()` would lose images/custom message objects and is not used. This depends on those public synchronous methods and must be revalidated if the SDK changes. This is a low-level synchronous retrieval/reordering capability, not a guarantee that Session's displayed message list is an authoritative queue view.

The adapter also projects public Session queue getters and `queue_update` subscriptions from resident objects, so extension `hasPendingMessages()` does not retain deleted controls. Reentrant notifications are serialized. Transient extraction failures restore original objects and modes; a permanently broken public queue API aborts and poisons the adapter rather than executing an inspection marker or claiming a successful mutation. Arbitrary side effects followed by permanent SDK exceptions are not an atomic-rollback guarantee.

The service reconciles at preparation and the earliest available public event boundaries. SDK drain can precede those public boundaries, and event listeners may delay propagation; therefore an SSE removal notification is not atomic with drain and can arrive late. GET and DELETE/PROMOTE reconcile immediately against resident objects. If the item has already dequeued, mutation returns `409` and clients refresh authority; it does not reconstruct or revive that item. Network-unknown mutations are not retried automatically.

A successful delete or promotion applies only while the object remains resident. It is **not** withdrawal of content already consumed by the model, and dequeue is not task completion. `steering_consumed` remains a separate, exact-identity acknowledgement (`session/controlId/requestId/acknowledgementId`) and independently clears only the matching steer draft. Queue mutation does not stand in for that acknowledgement. Pending input-extension processing is also separate; withdrawal fences prevent a late enqueue.

Use the authoritative control ID with the request and acknowledgement identity for mutations; do not identify an item by matching its text. The queue has no durable cross-restart persistence, no consumer acknowledgement for follow-up, and no promise of a synchronous UI event at the internal drain point.

## Web UI

Send/Enter starts a primary task when idle or in a new session. During a running task it submits a follow-up into the actual append queue by default; there is no send-mode selector or default direct steering. A follow-up row's guidance button promotes that resident object to steer, preserving its control identity and images. The Composer has no stop button or reserved stop row; backend abort and programmatic API/hooks remain available. Queue rows can be deleted individually. Local primary submission uses `submitting`, never a fabricated queue state. Ordinary HTTP accepted admission remains locked until SSE establishes running; only server queued SSE or explicit queued HTTP admission establishes queue status, and late HTTP cannot rewind SSE-confirmed running/terminal state. Normal submission uses a disabled send button and retains unconfirmed input rather than large duplicate banners; unknown/failed results still show explicit notices. Primary submitting/queued requests cannot accept controls; submission requires a writable, history-ready session with an active streaming request and no blocked/unknown primary submission. Shift+Enter inserts a newline and IME Enter does not submit. The queue view uses only the server snapshot; pending submission notices are separate. Follow-ups support text and images with the complete correlated payload; file attachments are explicitly blocked and retained. Follow-up admission (HTTP or exact queue identity) clears only the original snapshot, not at consumption, preserving newer drafts/attachments. Promoted consumption does not clear that snapshot again. Direct API steer retains its separate exact-consumption contract. Failed/unknown results retain input/state and do not auto-retry; `409` refreshes the snapshot.

Suggested recheck command (not a claim of passing):

```bash
pnpm --dir web exec playwright test --config playwright.control-queue.config.ts
```

Step navigation remains planned and is not part of this queue feature.

---

# 中文说明

本文说明已实现的驻留控制队列及其边界。单测、隔离 SDK/HTTP 与浏览器检查已通过；具体验证范围及未覆盖的真机／部署限制见 [DESIGN.md](../DESIGN.md)。

## API

- `GET /v1/sessions/:id/control-queue` 返回权威 `{ requestId, revision, items }` 快照。
- `DELETE /v1/sessions/:id/control-queue/:controlId` 删除一个仍驻留的 steer 或 follow-up 项。
- `POST /v1/sessions/:id/control-queue/:controlId/promote` 将仍驻留的 follow-up 移入 steer。
- 两种变更都须在 JSON 中提供控制身份（`requestId`、`acknowledgementId`），并返回快照。actor 来自已认证访问，不从请求 JSON 获取。会话不存在返回 `404`；身份格式错误返回 `400`；身份、actor、run 不匹配或已出队返回 `409`。同一 run 中成功操作的重复请求具幂等性。
- 带关联身份的 `POST .../steer` 与 `POST .../follow-ups` 准入返回空 `202`；旧版纯文本 follow-up 仍返回空 `204`。准入不代表已消费或任务完成。

## 保证与限制

队列行是权威快照中的真实 SDK 驻留对象，不是本地 pending/提交通知。快照包含控制 ID、类型、文本、是否含图片、queued 状态、acknowledgement ID 和 revision；不暴露 actor 个人信息、图片字节或 SDK 自定义消息。队列属于 runtime 内存状态，不保证服务重启后保留。revision 使用按会话、跨 runtime 存续的进程内时钟，包含无 runtime 的空快照，重建 runtime 不会倒退。客户端重连携带已知 SSE 服务端 epoch，服务端代际变化后重置队列权威状态并隔离旧在途响应。

集成依赖 SDK **1.1.0** 的公开同步低层队列方法：临时切换到 `all` 模式、放入 sentinel、用 `peekQueuedMessages()` 检视、清理对应队列，并在同一同步调用栈中恢复原始对象，中间不 `await`。重建文本条目或调用 `Session.clearQueue()` 会丢失图片/自定义消息对象，因此不采用。SDK 变更后须重新核验这些公开同步方法。该能力是低层同步取回与重排，不代表 Session 展示的消息列表就是权威队列视图。

适配层同时将公开 Session 队列 getter 与 `queue_update` 订阅映射至驻留对象，使扩展 `hasPendingMessages()` 不保留已删除控制；重入通知串行交付。临时提取异常恢复原对象及模式；若公开队列 API 永久损坏，则中止并禁用该 adapter 的后续执行，不执行检查 marker，也不谎报变更成功。对于任意副作用后持续抛错的 SDK 行为，不承诺原子回滚。

服务在 prepare 阶段和最早可用的公开事件边界同步队列。SDK 出队可能早于这些公开边界，事件监听器也可能延迟传播；因此 SSE 出队通知不与 drain 原子同步，可能晚到。GET 与 DELETE/PROMOTE 会立即对照当前驻留对象。若条目已出队，变更返回 `409`，客户端刷新权威快照；不会重建或复活该项。网络结果未知的变更不会自动重试。

成功删除或提升仅在对象仍驻留时生效；这**不是撤回模型已消费内容**，出队也不等于任务完成。`steering_consumed` 仍是独立的精确身份确认（`session/controlId/requestId/acknowledgementId`），并独立且仅清除匹配的 steer 草稿。队列变更不能替代该确认。输入扩展的 pending 处理同样独立；撤回记录用于阻止迟到的 SDK 入队。

变更时使用权威 control ID 及 request/acknowledgement 身份，不按文本匹配队列项。队列不保证跨服务重启持久化，不为 follow-up 提供消费确认，也不承诺在内部 drain 时同步通知 UI。

## Web UI

空闲或新会话时，发送/Enter 启动 primary 任务。运行中默认提交 follow-up 进入真实追加队列；没有发送模式选择栏，也不默认直接 steer。追加条目的「引导」按钮将驻留对象提升为 steer，保留控制身份与图片。Composer 没有停止按钮或预留停止控制行；后台 abort 与程序 API/hooks 能力保留。队列项可单条删除。本地首发使用 `submitting`，不伪造排队状态。普通 HTTP accepted 后仍锁住入口，直到 SSE 确认运行；只有服务端 queued SSE 或明确 queued HTTP 准入才确立排队，迟到 HTTP 不回退 SSE 已确认的运行/终态。正常提交通过禁用发送按钮与保留未确认输入反馈，不显示重复大 banner；unknown/failed 仍显示明确提示。主请求提交/排队时不能提交控制；提交要求可写、历史已就绪、有活动 streaming request，且首发提交未阻塞/未知。Shift+Enter 换行，IME Enter 不提交。队列视图只使用服务端快照，提交通知独立显示。追加通过完整关联 payload 支持文字与图片；文件附件显式阻止并保留。follow-up 准入（HTTP 或精确队列身份确认）仅清除原提交快照，不等消费，保留用户新草稿/附件；提升后的消费不重复清稿。直接 API steer 仍保留独立的精确消费契约。失败/未知时保留输入/状态且不自动重试；`409` 会刷新快照。

建议复验命令（不是通过声明）：

```bash
pnpm --dir web exec playwright test --config playwright.control-queue.config.ts
```

步骤定位仍待规划实现，不属于本队列功能。
