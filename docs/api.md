# API 概览

Pi SDK 与 pi-ai 固定为 **1.1.0**；本次 SDK 升级无需数据库迁移（[原生会话](native-sessions.md)既有的 v2 迁移要求不变）。SSE `tool_end` 与 export `tool_result` 的可选 `durationMs` 是 SDK 实测工具执行时间，不是子 agent 运行时间或模型吞吐；旧记录缺失仍表示未知。export `tool_result` 的可选 `nestedCalls` 是该工具运行中发起的调用（如 codemode 脚本里的 MCP 调用），最多记录 256 次，`complete:false` 表示记录不完整；实时 SSE 中这些调用以带 `parentToolCallId` 的 `tool_*` 事件出现。轮/turn 计数仍表示实际执行。usage 快照另含可选的 `currentPrompt`（本次任务每次模型调用之和）与 `subagentTotals`（当前分支子代理模型调用之和，不含在 `sessionTotals` 内）。见 [SDK 边界](pi-sdk-api.md)与[统计契约](usage-measurement.md)。

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 存活检查 |
| `GET` | `/readyz` | 进程启动与 migration gate 就绪状态 |
| `GET` | `/metrics` | 固定 Prometheus 进程/readiness 指标 |
| `GET` | `/v1/access` | 查询当前用户是否有读取和写入权限，返回 `canRead` 和 `canWrite` |
| `GET` | `/v1/capabilities/<plugin-id>/access` | 查询当前用户可以使用该插件的哪些功能，具体返回字段由插件定义 |
| `GET` | `/v1/models` | 可用模型与默认值；`modelThinkingLevels` 是 Agent 设置里按模型的默认思考档位（键为 `provider/modelId`），新会话没选档位时先用它，再用 `defaultThinkingLevel`。可选 `?projectId=`：再叠加该项目（受信任时）`.pi/settings.json` 里的档位，即这个项目新会话实际用的值；看不到的项目返回 `404` |
| `GET` / `POST` | `/v1/projects` | 列出或创建项目 |
| `DELETE` | `/v1/projects/:id` | 逻辑删除项目 |
| `GET` / `POST` | `/v1/sessions` | 列出或创建会话 |
| `PATCH` / `DELETE` | `/v1/sessions/:id` | 重命名或逻辑删除会话 |
| `PATCH` | `/v1/sessions/:id/config` | 修改模型/思考配置 |
| `POST` | `/v1/sessions/:id/messages` | 提交提示词（必须提供 `requestId`） |
| `GET` | `/v1/sessions/:id/events` | SSE；viewer 对无 live runtime 的会话收到 `204`。所有与 turn 相关的事件都携带产生它们的 `requestId`（`text_delta`、`thinking_delta`、`tool_start`、`tool_update`、`tool_end`、`status`、`usage`、`queued`、`error`、`completed`、`aborted`）。由其他工具（如 codemode 脚本）发起的嵌套调用，其 `tool_start`、`tool_update`、`tool_end` 另带 `parentToolCallId`。会话级 `steps_changed` 与 `subagents_changed`（合并发送，不带 `requestId`）通知客户端重新读取步骤与子代理；会话级 `title_changed`（带新的 `title`）在改名、插件设置标题或自动标题写入时发送，只发给有 live runtime 的会话 |
| `POST` | `/v1/sessions/:id/steer` | 引导运行中的任务；带关联身份的请求返回空 `202`，消费由 SSE 确认，HTTP 准入不代表消费。见[消费确认](steering-confirmation.md) |
| `POST` | `/v1/sessions/:id/follow-ups` | 排队追加 follow-up；带关联身份时准入返回空 `202`，旧版纯文本请求返回空 `204` |
| `GET` | `/v1/sessions/:id/control-queue` | 读取驻留引导/追加项的权威快照 |
| `DELETE` | `/v1/sessions/:id/control-queue/:controlId` | 按控制身份删除排队项 |
| `POST` | `/v1/sessions/:id/control-queue/:controlId/promote` | 将排队的追加项提升为引导 |
| `POST` | `/v1/sessions/:id/abort` | 中止该会话当前正在执行的任务。请求体可以不填；如果填写，必须是 `{ "requestId": "..." }`，只有任务的请求 ID 与它一致时才会中止。ID 不匹配则返回 `409`，任务继续运行。 |
| `GET` | `/v1/sessions/:id/export` | 只读消息快照；绝不创建 runtime |
| `GET` | `/v1/usage?period=day\|week\|month&timeZone=<IANA>&from=&to=` | 调用者能看到的所有会话里每次模型调用的 token 与估算费用，按模型、按日历天 / 周（周一起）/ 月汇总；全部分支和子代理都计入。默认 30 天 / 12 周 / 12 个月，最多 400 个周期，时区非法或范围越界返回 `400`。只读会话文件、不创建 runtime；重启后首次请求要读一遍所有文件，之后只重读有变化的文件。权限同 `sessions:list`。见[统计契约](usage-measurement.md#跨会话用量) |
| `GET` | `/v1/sessions/:id/subagents?runId=<optional>` | 子代理运行列表；带 `runId`（`runs[].id`）时附该子代理的只读会话。不创建 runtime。见[子代理会话](subagent-conversations.md) |
| `POST` | `/v1/sessions/:id/subagents/:runId/steer` | 由用户引导运行中的子代理，请求体 `{ "text": "..." }`，需要 `sessions:control`。空 `202` 只表示子代理控制通道已接收；子代理在下一回合开始前收到，送达以子代理记录为准。不可引导时返回 `409`：`SUBAGENT_NOT_RUNNING`（未在运行）、`SUBAGENT_STEER_UNAVAILABLE`（会话未加载、扩展未提供宿主控制或前台运行）、`SUBAGENT_STEER_FAILED`（发送失败，可重试）。不创建 runtime |
| `GET` | `/v1/sessions/:id/steps` | Inspector 完整步骤快照，数组顺序权威；只读且不创建 runtime |
| `GET` / `HEAD` | `/v1/sessions/:id/system-prompt` | 读取系统提示词并明确标注 `live_effective`、`creation_snapshot` 或 `unavailable` 来源；只读且不创建 runtime |
| `GET` | `/v1/sessions/:id/file-preview?path=<relative>&line=<optional>` | 预览该会话项目目录中的文本文件；`path` 填相对文件路径，`line` 可选，用于定位行号。不能读取项目目录外的文件 |
| `GET` | `/v1/sessions/:id/files?query=<optional>` | `@` 引用的路径建议：最多 20 条项目相对路径（文件与目录），只返回名字、不返回内容。git 项目列出已跟踪及未被忽略的文件，其他项目做有上限的遍历（跳过 `.git`、`node_modules`）；凭据类文件名不出现。`query` 为空时列出项目根目录 |
| `GET` | `/v1/sessions/:id/commands` | `/` 菜单：内置命令 `compact`、`reload`，从项目与服务 agentDir 发现的提示词模板和 `skill:<名字>`，以及显式加载的扩展注册的命令（`source: "extension"`，服务启动时读一次）。不创建 runtime |
| `GET` | `/v1/projects/:id/files?query=<optional>` | 新会话草稿（会话尚未创建）的 `@` 路径建议，规则同上，根目录为该项目当前的规范化目录；需要 `sessions:create` 权限，不可在该项目建会话或目录不可用时返回 `404` |
| `GET` | `/v1/projects/:id/commands` | 新会话草稿的 `/` 菜单：只含提示词模板与 `skill:<名字>`，不含需要已有会话的 `compact`、`reload` 和扩展命令；权限与 `404` 同上 |
| `GET` | `/v1/activity` | 跨会话运行动态快照 `{ running, recent }`：`running` 是正在跑的会话 `{ sessionId, projectId, title, startedAt }`，`recent` 是最近 24 小时结束的运行（新的在前，最多 200 条）`{ id, at, sessionId, projectId, title, kind: completed \| failed \| aborted, durationMs, message? }`，`message` 是失败信息的首行（最多 200 字）。只含调用者能访问的会话，删掉或取消共享的会话不再出现；进程内存保存，重启后清空；权限同 `sessions:list` |
| `GET` | `/v1/activity/events` | 跨会话运行动态 SSE：连上先发 `activity_snapshot`（同上面的快照），之后每次变化发 `activity`（`kind` 另有 `started`）。不支持 `Last-Event-ID`，重连拿新的快照。占用一个每用户 SSE 名额（`MAX_SSE_PER_USER`），认证复核与 `auth_expired` 同会话 SSE；权限同 `sessions:list` |
| `GET` | `/v1/companion/persona` | 调用者保存的数字人人设 `{ persona: { name, style, docked } \| null }`，未保存过时为 `null`；权限同 `sessions:create` |
| `GET` | `/v1/projects/:id/mcp` | 项目的 MCP 设置 `{ configured, canEdit, servers, projectConfig? }`：列出目录中每个 server 的启用状态、exposure、上限、隐藏工具、`adminOnly`、`canEnable`（调用者能否启用它），以及需要每个用户自己授权时的 `oauthLabel`；目录里已删除但项目仍有设置的 server 标为 `missing`；同名 server 换了地址或命令后，之前的设置标 `changed: true` 并停用，重新保存后恢复。`configured` 现在总是 `true`（共享 MCP 读取 Pi 的全局 `mcp.json`，文件不存在时 `servers` 为空），保留它是为了兼容。信任的项目还列出它 `.pi/mcp.json` 里定义的 server（`projectFile: "defined"`，默认不启用），被项目文件改了默认设置的共享 server 标 `projectFile: "overridden"`；项目有 `.pi/mcp.json` 时多一个 `projectConfig: { path, trusted, error?, unavailable }`，`trusted: false` 表示项目不受信任、文件没有加载，`unavailable` 列出没用上的项及原因。项目可见者（含 viewer）可读；见 [MCP 接入方案](mcp-integration.md) §15 |
| `GET` | `/v1/projects/:id/trust` | 项目信任 `{ trusted, source, entryPath?, defaultTrust, canEdit, files }`：读自 agentDir 下 Pi 的 `trust.json`。`source` 为 `project`（项目自己的记录）、`parent`（沿用上级目录 `entryPath` 的记录）或 `default`（没有记录，按 `defaultTrust`，只有 `always` 算信任）；`files` 列出 `.pi/mcp.json`、`.pi/settings.json`、`.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md` 是否存在，这几个文件只在信任时加载。项目可见者可读；服务没配置时返回 `404 trust_not_configured` |
| `PUT` | `/v1/projects/:id/trust` | 设置项目信任 `{ trusted }`，在 `trust.json` 里给这个项目自己记一条（和 `pi` 命令行同一个文件锁、同样的格式，上级目录的记录不变），返回新的状态。只有 admin 可用；`trust.json` 写坏或锁一直被占着时不覆盖，返回 `409 trust_unavailable`。已有会话从下一条消息起按新的信任加载 MCP 与 Agent 设置，提示词文件只影响之后新建的会话 |
| `PUT` | `/v1/projects/:id/mcp/servers/:name` | 保存项目对一个目录 server（含信任项目 `.pi/mcp.json` 里的 server）的设置 `{ enabled, exposure?, hiddenTools? }`，返回 `{ server }`。`exposure` 不能超过目录 `maxExposure`（`null` 用目录默认值），`hiddenTools` 是 server 原工具名的精确列表。项目 owner（`user`/`admin`）可改；启用 `adminOnly` server（`403 mcp_admin_only`）或修改共享的默认项目（`403 mcp_default_project`）需要 admin；目录外的 server 返回 `404 mcp_unknown_server`，未配置目录返回 `404 mcp_not_configured`。只影响之后创建或恢复的会话 |
| `GET` | `/v1/mcp/shared` | 共享 MCP 列表 `{ canEdit, servers, file? }`，按 Pi 全局 `mcp.json` 里的顺序。所有已登录角色（含 viewer）可读，非 admin 只看到能用的 server（名称、类型、说明、提供方式）；admin 另外看到不能用的项和原因、表单内容 `config`（header 与 env 的值打码为 `••••••`，只引用环境变量的值如 `Bearer ${TOKEN}` 照原样显示）、表单管不到的字段 `otherFields`，以及 `file: { path, hash, error? }`。见 [MCP 接入方案](mcp-integration.md) §14.3 |
| `PUT` | `/v1/mcp/shared/:name` | admin 新增或修改一项 `{ hash, server }`，返回新的列表。只改表单字段，其他内容原样保留；传回打码值表示不改。先写临时文件再改名。`hash` 与当前文件不一致返回 `409 mcp_config_changed`；名称非法、与其他项只差 `-`/`_`、或本服务用不了的设置（如 `exposure` 超过 `maxExposure`、`!命令`）返回 `400 mcp_config_invalid`；只缺环境变量的项照样保存，列表里标为不可用。会话从下一条消息起生效 |
| `DELETE` | `/v1/mcp/shared/:name?hash=` | admin 删除一项，返回新的列表；`409 mcp_config_changed` 同上，没有这一项返回 `404 mcp_unknown_server`。项目里对它的设置保留，显示为“已移除” |
| `GET` | `/v1/mcp/connections` | 调用者对目录中每个需要用户授权（`oauth`）的 MCP server 的连接状态 `{ servers: [{ name, label, connected, account?, connectedAt?, expiresAt? }] }`；`account` 只在授权服务器提供账号名时出现。没有这类 server 时为空列表。可选 `?projectId=`：再加上该项目（受信任时）`.pi/mcp.json` 里需要授权的 server，它们的授权按项目分开（下面的发起与断开也要带上同一个 `projectId`）；看不到的项目返回 `404`。`user`/`admin` 可用；见 [MCP 接入方案](mcp-integration.md) §13、§15 |
| `POST` | `/v1/mcp/servers/:name/oauth/start` | 发起授权，返回 `{ authorizationUrl }`，页面整页跳转过去；授权服务器支持时自动注册客户端。待处理授权 10 分钟过期。注册被拒返回 `502 mcp_oauth_registration_rejected`（例如对方只接受 https 回调地址），授权服务不可用返回 `502 mcp_oauth_authorization_unavailable`；不是需要授权的 server 返回 `404 mcp_unknown_server`，服务没有这类 server 返回 `404 mcp_oauth_not_configured` |
| `GET` | `/v1/mcp/oauth/callback` | 授权服务器的回调（`<PI_PUBLIC_URL>/v1/mcp/oauth/callback`），完成后 `302` 回 Web 首页，带 `mcp_oauth=connected` 或失败原因（`expired`、`denied`、`issuer_mismatch`、`server_changed`、`exchange_failed`）与 `mcp_server`。`state` 一次性，只有发起授权的同一调用者能完成。浏览器整页跳回带不上 token，所以这个路径在 `tokenRequired` 画像下免 Bearer，IP 准入与角色授权照旧 |
| `DELETE` | `/v1/mcp/servers/:name/connection` | 断开：授权服务器支持撤销时先撤销 refresh token 与 access token（失败不阻止），再删除凭证，返回 `204`；没有连接返回 `404 mcp_not_connected` |
| `GET` | `/v1/provider-auth` | 模型登录（对应 Pi TUI 的 `/login`）：每个 provider 的登录方式与状态 `{ providers: [{ id, name, oauth?, apiKey?, status, stored? }] }`。`oauth` 有 `name`、`loginLabel?`、`subscription`；`apiKey.interactive` 为 `false` 时只能从环境变量等外部来源读取，不能在这里填；`status` 是 `{ configured, type?, source? }`；`stored` 是 Pi `auth.json` 里存的凭证类型，只有存了的才能删除。已存凭证但 provider 已不存在的也会列出。凭证是整个服务共用的身份，只有 admin 可用；服务没开放时返回 `404 provider_auth_not_configured` |
| `POST` | `/v1/provider-auth/logins` | 发起登录 `{ provider, method: "oauth" \| "api_key" }`，返回 `201` 和登录记录 `{ id, provider, method, state, steps, prompt?, error? }`。之后轮询 `GET /v1/provider-auth/logins/:id`，遇到 `prompt` 就回答，直到 `state` 不再是 `running`。`steps` 按顺序记录 provider 给出的授权链接（`auth_url`）、设备码（`device_code`）、说明和进度；`prompt.type` 为 `text` / `secret` / `select` / `manual_code`。同一个 provider 再次发起会取消上一次，10 分钟没完成自动取消，结束后的记录保留 5 分钟，只有发起者能看到。OAuth 回调落在服务所在机器的 localhost 上，从别的机器访问时，按 `manual_code` 提示把浏览器最后跳到的地址粘回来。未知 provider 返回 `404 provider_auth_unknown_provider`，不支持的方式返回 `400 provider_auth_unsupported_method` |
| `GET` | `/v1/provider-auth/logins/:id` | 登录记录；不存在、已过期或不是调用者发起的返回 `404 provider_auth_unknown_login` |
| `POST` | `/v1/provider-auth/logins/:id/answer` | 回答当前问题 `{ promptId, value }`，返回登录记录。回答内容只交给 provider 的登录流程，不进记录、不进日志。问题已经不需要回答（例如 OAuth 回调先到了）返回 `409 provider_auth_stale_prompt`，`select` 的值不是选项之一返回 `400 provider_auth_invalid_answer` |
| `DELETE` | `/v1/provider-auth/logins/:id` | 取消登录，返回登录记录；已结束的原样返回 |
| `DELETE` | `/v1/provider-auth/credentials/:provider` | 退出登录：从 `auth.json` 删除这个 provider 的凭证，返回新的列表；环境变量和 `models.json` 里的配置不变，provider 那边的授权也不会被吊销。没存凭证返回 `404 provider_auth_not_stored` |
| `GET` | `/v1/settings` | Agent 设置（对应 Pi TUI 的 `/settings`），读自 agentDir 下 Pi 的全局 `settings.json`：`{ canEdit, values, defaults, file? }`。`values` 是服务正在用的值 `{ autoCompaction, autoRetry, maxRetries, modelThinkingLevels }`（分别对应文件里的 `compaction.enabled`、`retry.enabled`、`retry.maxRetries`、`modelThinkingLevels`），文件里没写或写错类型的项用 Pi 的默认值，`defaults` 列出这些默认值。admin 另外拿到 `file: { path, hash, error? }`，`error` 说明文件读不了或哪些值无效（这时服务继续用上次读成功的内容或默认值）。所有能看模型列表的角色可读；服务没配置时返回 `404 settings_not_configured`。可选 `?projectId=`：项目有 `.pi/settings.json` 时多一个 `project: { path, trusted, values, error? }`，`values` 是文件里写了的项（只对这个项目的会话生效），`trusted: false` 表示项目不受信任、文件没有加载；看不到的项目返回 `404` |
| `PUT` | `/v1/settings` | 修改 Agent 设置 `{ hash, values }`，只改 `values` 里给出的项，`modelThinkingLevels` 给出时整份替换（空对象表示全部清除），返回新的设置。只写这几个字段，文件里的其他字段原样保留；和 `pi` 命令行用同一个文件锁。`maxRetries` 为 0–10 的整数，`modelThinkingLevels` 的键是 `provider/modelId`、值是 `off` 到 `max`，最多 500 项。运行中的会话几秒内生效。只有 admin 可用；`hash` 对不上（文件在别处改过）返回 `409 settings_changed`，值不合法或文件本身读不了返回 `400 settings_invalid` |
| `PUT` | `/v1/companion/persona` | 保存调用者的人设：`name` 1–12 个字且不能全是空白（存储时去掉首尾空白），`style` 为 `concise` / `lively` / `formal`，`docked` 为布尔值；返回 `{ persona }`。参数不合法返回 `400`；服务端未配置人设存储时返回 `503 companion_unavailable` |
| `POST` | `/v1/projects/:id/companion/greeting` | 空白会话数字人的开场白：用默认模型，依据项目名、模板与 skill、时段和调用者最近的会话写两句话；按调用者和情境缓存约 30 分钟。未配置默认模型、`PI_COMPANION_GREETING=off` 或模型失败时返回 `503 companion_unavailable`，页面改用本地句子；权限与 `404` 同上 |
| `POST` | `/v1/sessions/:id/commands` | 执行 `{ "command": "compact", "args"?: "总结要求" }`、`{ "command": "reload" }` 或扩展命令 `{ "command": "extension", "name": "antigravity.usage", "args"?: "参数" }`，只能在会话空闲时执行（否则 `409`）。见下文「宿主命令」 |
| `GET` | `/v1/sessions/:id/command-prompt` | 扩展命令正在等待回答的问题 `{ prompt }`，没有时为 `null`；不创建 runtime，viewer 也能读。见下文「扩展命令的对话框」 |
| `POST` | `/v1/sessions/:id/command-prompt` | 回答这个问题 `{ promptId, value?, confirmed?, cancel? }`，先答先得：成功 `204`，已在别处回答、取消或超时 `409`，类型不符 `400` |

队列出队不代表任务完成或控制内容已消费。公开事件边界的队列同步可能延迟；GET 与队列变更会即时对照 SDK 当前驻留对象。变更使用原始 control ID 及 request/acknowledgement 身份。保证与限制见[控制队列](control-queues.md)。

Inspector 读取沿用会话 export 的授权层级，且不创建 runtime。步骤快照包含投影出的完整语义块，包括思考以及分开的工具调用／工具结果；数组顺序权威。已保存历史只能保留记录中的分支／块顺序：重启后无法恢复未持久化的并行工具真实完成时序，因此这不是永久完整的 SDK 事件档案。实时系统提示词来自已有公开 getter，但不证明模型实际收到的内容；创建时快照也不是运行时提示词的重建。现有事件流视图／流保持不变。契约与限制见[会话步骤与 Inspector](session-steps.md)。

## 公共 API 契约 v1

- v1 请求、响应和 SSE 字段见 [OpenAPI 规范](../openapi/v1.json)；客户端可从 `pi-agent-server/contract` 导入对应类型。插件路由及其字段由各插件独立定义，见[插件接入说明](plugin-integration.md)。现有 v1 行为和字段保持兼容；可新增可选内容，破坏性变更需使用新版本。
- `GET /v1/access` 只返回 `{ canRead, canWrite }`：分别表示用户能否使用只读功能、提交或控制任务。`GET /v1/capabilities/<plugin-id>/access` 返回当前用户能使用该插件的哪些功能。权限配置见 [IP 访问控制](ip-rbac-design.md)。
- 每次有意提交消息使用唯一 `requestId`。持久化 fingerprint 在重启后仍以 `409` 拒绝内容变化；无 fingerprint 的旧记录不保证该检查。共享会话的 ID 还绑定操作者。消息图片支持 PNG、JPEG 和 WebP，服务不会压缩图片。非图片上传需显式配置存储与配额，见[附件上传](attachment-uploads.md)。
- `file-preview` 的路径相对于会话的受信项目目录，不能读取目录外文件。没有保存目录快照的旧会话无法使用预览；请新建会话。
- `files` 与 `commands` 同样以会话保存的项目目录快照为根；没有快照的会话（例如还没发过消息）返回 `404`。

### 宿主命令

- `compact`：调用 Pi 的手动压缩，`args` 作为总结要求。执行期间该会话的新提交返回 `409`，子代理通知排队到命令结束；压缩以命令自己的 `requestId` 发出 `compaction_start` / `compaction_end`，成功时先发出一次 `usage`（压缩后 `context.tokens` 为 `null`，要等下一次模型回复才知道实际占用），最后发出 `completed`（成功）、`aborted`（通过 `POST /abort` 取消，HTTP 返回 `409` 与 `COMMAND_ABORTED`）或 `error`（HTTP 返回 `422`，例如没有可压缩的内容）。export 的 `compaction` 只描述仍在进行的任务或命令：所属任务或命令结束（`completed` / `error` / `aborted`）后即不再返回，刷新页面不会重放已结束的压缩（自动压缩与 `/compact` 相同）。
- `reload`：调用 Pi 的 `session.reload()`，重新读取 `AGENTS.md` / `CLAUDE.md`、提示词模板与 skills，并重新执行该会话显式配置的扩展；返回各类资源的数量，不发出 SSE 事件。扩展会收到 `session_shutdown` 与 `session_start`（reason 为 `reload`），运行中的子代理可能因此结束。重新执行扩展会重放扩展的模块级副作用，见 [SDK 边界](pi-sdk-api.md)。
- `extension`：执行显式加载的扩展用 `pi.registerCommand` 注册的命令（例如 `/antigravity.usage`），返回 `{ command, name, output }`。命令执行期间临时给扩展一个 Web 用的 UI：`notify`、`setWidget`、`setStatus` 依次记成输出行（`level` 为 `info` / `warning` / `error`，去掉终端颜色码）；`select`、`confirm`、`input`、`editor` 对话框见下文「扩展命令的对话框」；`custom`（终端界面）在 Web 上做不到，按取消处理并记一行说明。执行完换回原来的状态，平时扩展看到的仍是没有 UI。输出作为 `pi-agent-server:command` custom 条目记进会话 JSONL，不会发给模型；同时发出会话级 SSE 事件 `command_output`，export 的 `timeline` 里也有对应的 `command_output` 条目，Web 显示为一条 SYS 记录。命令抛错时仍返回 `200`，输出里最后一行是错误；超过 3 分钟没结束就不再等待（等人回答对话框的时间不算，回答后重新计时），会话恢复可用，之后的输出不再收集。没有这个命令返回 `422`，缺 `name` 返回 `400`。扩展命令列表在服务启动时读取，改了 `PI_EXTENSION_PATHS` 要重启服务。
- 提示词模板（`/名字 参数`）与 skill（`/skill:名字`）不是宿主命令：作为普通消息提交，由 Pi 在发送时展开。磁盘上新增的模板和 skills 在 `reload` 或新建会话后才对该会话生效。

### 扩展命令的对话框

扩展命令调用 `select`、`confirm`、`input` 或 `editor` 时，命令停下来等回答：

- 服务端挂起一个问题，发出会话级 SSE 事件 `command_prompt`，带上问题 `{ promptId, command, kind, title, message?, options?, placeholder?, prefill?, expiresAt }`。同一个会话同时最多一个问题；扩展同时再开一个，后一个按取消处理。
- 页面打开或 SSE 重连时用 `GET /v1/sessions/:id/command-prompt` 读当前问题（没有时 `prompt` 为 `null`，不会为此创建 runtime）。所有看得到会话的角色都能读，viewer 只能看。
- `POST /v1/sessions/:id/command-prompt` 回答 `{ promptId, value?, confirmed?, cancel? }`：`select` 传选项原文，`input` / `editor` 传文本，`confirm` 传 `confirmed`，`cancel: true` 等于关掉对话框。需要能操作会话（`user` / `admin`）。先答先得：成功返回 `204`，所有页面收到 `command_prompt_closed`（`reason` 为 `answered` 或 `cancelled`）；问题已经在别处回答、被取消或超时返回 `409 command_prompt_closed`；回答和问题类型不符返回 `400 command_prompt_invalid`。回答的内容只交给扩展，不写进会话记录。
- 没人回答时，10 分钟后（扩展给了更短的 `timeout` 时按它的）关闭，`reason` 为 `timeout`，按取消处理并在命令输出里记一行说明；扩展用 `signal` 收起时 `reason` 为 `cancelled`。命令结束、超时或会话被释放时还挂着的问题一并收起。
- Web 在输入框上方显示问题；别的页面先回答时显示“已在别处回答”，直到命令输出出现。
