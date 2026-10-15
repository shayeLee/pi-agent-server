# API 概览

Pi SDK 与 pi-ai 固定为 **1.1.0**；本次 SDK 升级无需数据库迁移（[原生会话](native-sessions.md)既有的 v2 迁移要求不变）。SSE `tool_end` 与 export `tool_result` 的可选 `durationMs` 是 SDK 实测工具执行时间，不是子 agent 运行时间或模型吞吐；旧记录缺失仍表示未知。轮/turn 计数仍表示实际执行。usage 快照另含可选的 `currentPrompt`（本次任务每次模型调用之和）与 `subagentTotals`（当前分支子代理模型调用之和，不含在 `sessionTotals` 内）。见 [SDK 边界](pi-sdk-api.md)与[统计契约](usage-measurement.md)。

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 存活检查 |
| `GET` | `/readyz` | 进程启动与 migration gate 就绪状态 |
| `GET` | `/metrics` | 固定 Prometheus 进程/readiness 指标 |
| `GET` | `/v1/access` | 查询当前用户是否有读取和写入权限，返回 `canRead` 和 `canWrite` |
| `GET` | `/v1/capabilities/<plugin-id>/access` | 查询当前用户可以使用该插件的哪些功能，具体返回字段由插件定义 |
| `GET` | `/v1/models` | 可用模型与默认值 |
| `GET` / `POST` | `/v1/projects` | 列出或创建项目 |
| `DELETE` | `/v1/projects/:id` | 逻辑删除项目 |
| `GET` / `POST` | `/v1/sessions` | 列出或创建会话 |
| `PATCH` / `DELETE` | `/v1/sessions/:id` | 重命名或逻辑删除会话 |
| `PATCH` | `/v1/sessions/:id/config` | 修改模型/思考配置 |
| `POST` | `/v1/sessions/:id/messages` | 提交提示词（必须提供 `requestId`） |
| `GET` | `/v1/sessions/:id/events` | SSE；viewer 对无 live runtime 的会话收到 `204`。所有与 turn 相关的事件都携带产生它们的 `requestId`（`text_delta`、`thinking_delta`、`tool_start`、`tool_update`、`tool_end`、`status`、`usage`、`queued`、`error`、`completed`、`aborted`）。会话级 `steps_changed` 与 `subagents_changed`（合并发送，不带 `requestId`）通知客户端重新读取步骤与子代理 |
| `POST` | `/v1/sessions/:id/steer` | 引导运行中的任务；带关联身份的请求返回空 `202`，消费由 SSE 确认，HTTP 准入不代表消费。见[消费确认](steering-confirmation.md) |
| `POST` | `/v1/sessions/:id/follow-ups` | 排队追加 follow-up；带关联身份时准入返回空 `202`，旧版纯文本请求返回空 `204` |
| `GET` | `/v1/sessions/:id/control-queue` | 读取驻留引导/追加项的权威快照 |
| `DELETE` | `/v1/sessions/:id/control-queue/:controlId` | 按控制身份删除排队项 |
| `POST` | `/v1/sessions/:id/control-queue/:controlId/promote` | 将排队的追加项提升为引导 |
| `POST` | `/v1/sessions/:id/abort` | 中止该会话当前正在执行的任务。请求体可以不填；如果填写，必须是 `{ "requestId": "..." }`，只有任务的请求 ID 与它一致时才会中止。ID 不匹配则返回 `409`，任务继续运行。 |
| `GET` | `/v1/sessions/:id/export` | 只读消息快照；绝不创建 runtime |
| `GET` | `/v1/sessions/:id/steps` | Inspector 完整步骤快照，数组顺序权威；只读且不创建 runtime |
| `GET` / `HEAD` | `/v1/sessions/:id/system-prompt` | 读取系统提示词并明确标注 `live_effective`、`creation_snapshot` 或 `unavailable` 来源；只读且不创建 runtime |
| `GET` | `/v1/sessions/:id/file-preview?path=<relative>&line=<optional>` | 预览该会话项目目录中的文本文件；`path` 填相对文件路径，`line` 可选，用于定位行号。不能读取项目目录外的文件 |

队列出队不代表任务完成或控制内容已消费。公开事件边界的队列同步可能延迟；GET 与队列变更会即时对照 SDK 当前驻留对象。变更使用原始 control ID 及 request/acknowledgement 身份。保证与限制见[控制队列](control-queues.md)。

Inspector 读取沿用会话 export 的授权层级，且不创建 runtime。步骤快照包含投影出的完整语义块，包括思考以及分开的工具调用／工具结果；数组顺序权威。已保存历史只能保留记录中的分支／块顺序：重启后无法恢复未持久化的并行工具真实完成时序，因此这不是永久完整的 SDK 事件档案。实时系统提示词来自已有公开 getter，但不证明模型实际收到的内容；创建时快照也不是运行时提示词的重建。现有事件流视图／流保持不变。契约与限制见[会话步骤与 Inspector](session-steps.md)。

## 公共 API 契约 v1

- v1 请求、响应和 SSE 字段见 [OpenAPI 规范](../openapi/v1.json)；客户端可从 `pi-agent-server/contract` 导入对应类型。插件路由及其字段由各插件独立定义，见[插件接入说明](plugin-integration.md)。现有 v1 行为和字段保持兼容；可新增可选内容，破坏性变更需使用新版本。
- `GET /v1/access` 只返回 `{ canRead, canWrite }`：分别表示用户能否使用只读功能、提交或控制任务。`GET /v1/capabilities/<plugin-id>/access` 返回当前用户能使用该插件的哪些功能。权限配置见 [IP 访问控制](ip-rbac-design.md)。
- 每次有意提交消息使用唯一 `requestId`。持久化 fingerprint 在重启后仍以 `409` 拒绝内容变化；无 fingerprint 的旧记录不保证该检查。共享会话的 ID 还绑定操作者。消息图片支持 PNG、JPEG 和 WebP，服务不会压缩图片。非图片上传需显式配置存储与配额，见[附件上传](attachment-uploads.md)。
- `file-preview` 的路径相对于会话的受信项目目录，不能读取目录外文件。没有保存目录快照的旧会话无法使用预览；请新建会话。
