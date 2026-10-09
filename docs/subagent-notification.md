# 子代理通知展示与宿主自动跟进

保留 run30 的独立持久展示边界，新增会话专属宿主准入。没有修改 SDK，也没有开放其他 idle SDK 事件。

- 受信 `agent-team` 扩展的集成协议要求在原通知边界先 `appendEntry('agent-team:notification', { version: 1, notificationId: UUID, runIds, text })`，作为持久展示事实，再发送专用 `agent-team:results-ready` custom 模型消息。正文保持原文，details 使用同一 notificationId；SDK 将 custom 内容转换为 model user，details 不进入模型。停止、等待、收集机制不变。
- Host factory 必须收到 `{ loader, failbackLifecycleSource }` 包装（同一会话 loader 的 EventBus），不再接受裸 ResourceLoader；缺 bus 在 `createAgentSession` 前 fail fast。生产 `getProviderExtensionEventBus` 缺接线也直接拒绝。`session_start` 先经同一 bus 查询独立 `agent-team:host-identity`，由 adapter 回应 `{ version: 1, host: 'pi-agent-server' }`；该身份为扩展实例本地状态，不读写全局 process.env。Host 身份已确认但 transport 缺失时，只保留展示事实，拒绝自动跟进，不得误用 CLI direct。
- `session_start` 经所属 loader 的 EventBus 同步握手 `agent-team:host-transport`，只得到 `post(payload): Promise<AdmissionAck>`，不传 sessionId，不暴露 runtime/registry。adapter 在 SDK bind 前安装桥，runtime 初始化时接入；尚未接入返回 notready，dispose 撤销。已握手的扩展遇到拒绝/notready/disposed/异常都不得回退 SDK direct。无宿主 CLI 仍保持原 `sendMessage`、`followUp` + `triggerTurn: true`；该 void 返回不代表模型成功。
- append 与 post 前同步登记 inflight 防重入；同通知重试复用 ID，宿主进程内按 notificationId 和载荷去重（拒绝也保留，不重复提交）。只有宿主 accepted ACK 才 markNotified；异常不冒充 ACK。ACK 仅代表宿主准入/有界暂存，不代表完整回合成功。
- 活动宿主任务且 SDK streaming 时，在无 await 的 check→SDK queue 边界追加 custom follow-up，输出继续归属该活动 requestId。preflight/settled/terminal 仍拥有宿主槽位时进入最多 32 项的会话 pending，并立即 ACK；绝不等待所属回合而形成 settled 自等待。真正 release→idle 后微任务重新检查所有权再调度。
- idle 使用内部 `userPrompt | extensionCustom` 判别输入，与原用户任务共用并发准入、容量队列、幂等、取消、测量、stream gate、usage 与终态释放。每个独立通知任务使用新的 UUID requestId，不制造空 prompt/user 消息，不借旧 requestId。SDK custom 消息没有增加用户消息数或标题来源；SSE 使用真实生命周期 requestId，客户端用户 snapshot 仅按其原 requestId 精确匹配，不按通知文本推断确认。
- abort（包括 idle admission await）、poison 和 dispose 撤销 pending，准入存储 await 后重查取消代次和用户任务竞争；不在 settle 后自动复活。主动 abort 后直到下一次新的 userPrompt 成功准入才解除通知阻断；旧 request 的 done 重放、payload conflict、限流/容量拒绝，以及 beforeAccept 失败或被取消都不解除。取消代次仍覆盖取消前已开始的存储 await；新接受的用户任务可恢复后续通知。
- 独立 `entry_appended` 订阅仅接受专用 customType 和 version 1 结构。通知 SSE 无 requestId，不改变 phase、usage 或提交确认。idle/abort discard 不阻断通知，dispose 后拒绝；其他 SDK text/tool/status 仍沿原过滤路径。
- 当前 branch 的专用 custom entry 导出为 `notification:<notificationId>`，保留 entryId。伴随 custom_message 不额外展示。客户端按 ID upsert，历史/replay 去重；通知不是 user，不计用户轮数，不生成标题。
- 客户端 queued/streaming 使用 `activeRequestId` 作为所有权边界，status/queued/text/thinking/tool/progress/usage/terminal 不得抢占另一个活动请求；异属 error 只记录错误结果，不清空 modelOutput、不关闭 streaming 消息、不改 phase。controller 的 SSE 提交确认与 usage invalidation 使用同一所有权判断，HTTP 失败也带原 requestId 进入 reducer。无 requestId 的旧普通事件维持旧 session-stream 兼容；专用 notification 无论何时都只是展示，不改 phase。idle/terminal 可由新 status/queued/输出开启新的通知或用户任务，不需要制造用户 snapshot。
- Web 使用左对齐独立“子代理通知”区域，安全 Markdown 与工具输出相同，不请求 Markdown 图片。状态文案原样保留，stopped 不转换为 completed。

## 边界

初版只提供进程内通知调度，不是持久 crash outbox：持久 marker 可重放展示，但重启不自动补发通知任务，也不承诺跨重启 notificationId exactly-once。pending ACK 不保证后来取得容量或模型成功；排队取消、超时、删除和 SDK 错误仍可能终止任务。展示事实先于任务，展示可见不等于任务成功。重启后只有明确 marker 的通知恢复；历史无 marker 的旧 user 记录不追认，同文普通 user 不猜测。

扩展需显式通过 `PI_EXTENSION_PATHS` 加载；仓库不部署全局扩展。修改已加载扩展后须重启服务，不自动重载在用进程。

## 验证

使用 Volta Node 22.19.0，fake SDK、临时 synthetic JSONL、隔离 HTTP 5248 / Web 5249、Chrome；不访问 live 8080/5173，不调用模型，不写真实 session DB/auth。run30 展示测试入口：`tests/agent/subagent-notification.test.ts`、adapter/runtime/client/export/OpenAPI 相关测试以及 `web/playwright.notification-local.config.ts`。亮/暗 1280/390 截图保留在 `/tmp/subagent-notification/`。

宿主跟进新增 `tests/agent/subagent-host-transport.test.ts`：fake SDK 验证 active 同 requestId、settled 不自等待、idle 先 quota 后 SDK/新 request 唯一终态、queue/full、用户竞争、abort/dispose、存储 await 取消及重复回调；全局扩展片段测试覆盖 host ACK/拒绝/异常不 fallback 与 CLI 原路径。使用 `volta run --node 22.19.0 pnpm exec vitest run …` 与 `volta run --node 22.19.0 pnpm exec tsc --noEmit -p tsconfig.json`。review34 加固验证：backend factory/adapter/runtime/client/export/OpenAPI 定向测试与 Web/controller/StatsBar 测试通过，Host 跟进与原通知 browser 2 项、stats 4 项、scroll 4 项通过（隔离端口，不访问 live/模型/真实 DB）。根 `tsconfig.json` 全类型检查通过。Web 默认类型检查读取旧 dist client 声明，新增源码 API 尚未编译到 dist；临时源码映射又遇到已有后端源文件在 Web 编译选项下的类型错误，未修改无关源文件或 dist。Web 声明构建后类型复验及独立 review 仍需调用方完成；本执行子代理未委派其他代理。日志与本轮扩展备份：`/tmp/subagent-host-hardening/`。

宿主跟进初版新增不可覆盖备份：`/tmp/agent-team-notification-backup/run30-516548596ccc92436901d8bc65d656f1ee5cc1d53e31e6568c8d5b360644563e/index.ts`（及同目录 `extension/`），对应修改前 run30 全局 index.ts 的 SHA-256。既有备份保持不变。
