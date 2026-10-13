# Agent Server 通用客户端模块

`src/client` 是与渲染无关的客户端模块，对接 Agent Server 的对外契约，可供 Web、macOS 客户端或 Agent 复用。

## 分层

- 通用客户端模块：对接 Agent Server，统一处理请求、实时事件和聊天数据状态。
- 各客户端适配层：根据自身需要组织会话、交互流程和状态展示。
- 展示层：呈现状态并接收用户操作，不直接处理服务端数据流。

Web 通过客户端适配层使用通用模块；其他客户端可以按相同边界接入，而不依赖 Web 的界面实现。

## 上下文压缩元数据（增量兼容）

- SSE `compaction_start`：`reason: manual|threshold|overflow`；`compaction_end`：同样的 `reason`、`outcome: succeeded|failed|aborted`、`willRetry: boolean`，可选 `tokensBefore` / `tokensAfter`。均沿用当前任务的 `requestId`，补发带 `replay: true`。数字仅有限非负，不传摘要或 SDK 原始错误。
- SDK end 判定：`aborted` 优先，其次存在 `result` 为成功，否则失败；`estimatedTokensAfter` 映射为 `tokensAfter`。事件只在现有 streaming/aborting 窗口处理，idle manual 不新增事件，不改变任务结算。
- `ChatState.compaction` 是可选的纯元数据状态（`running|succeeded|failed|aborted|unknown`），不增加历史卡片。start 建立 pre-agent-start 归属、关闭正文/thinking 光标和实时模型进度；同 request 的 agent_start 保留压缩状态，新 request 清除旧状态。旧 request 不覆盖新 request。
- 无明确 end 的任务终止只将 running 转为 unknown（completed）、failed（error）或 aborted。网络断线、无 live stream、会话切换/恢复只将 running 转为 unknown，不取消任务；重放 start 为 unknown，后续 live start 为 running，end 恢复明确终态。
- 现有 export 可选返回 `compaction`，只来自已实例化 runtime 的内存快照，不扫描 JSONL、无 runtime 时不伪造历史。元数据和 `lastEventId` 在异步历史读取前同步捕获；初次进入以该游标订阅时恢复 running 为 unknown，之后的 end 仍由增量/重放确认。返回已缓存会话保留已消费游标，避免快照覆盖漏收事件。旧服务缺字段和旧客户端忽略事件均兼容。

## 回复反馈与中止证据

- 客户端收到归属当前请求的 `aborted` 后，正在流式输出的助手消息保留可选 `stopReason: "aborted"`，并关闭光标；下一次请求不抹除旧消息标记。断线、错误或短文本不会被推断为中止。
- 导出时间线的助手文本块从 SDK 消息的明确 `stopReason` 提取中止证据，Web 历史投影恢复该字段；旧导出缺失时不猜测。
- Web 回复区域在当前用户消息之后尚无助手正文、且请求处于提交确认或运行阶段时显示等待状态。排队保留既有独立提示；正文首字到来或运行结束时关闭等待提示。
