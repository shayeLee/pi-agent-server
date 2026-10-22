# 统计计量与前端契约

依据安装版本 Pi SDK / pi-ai **1.1.0** 的 SDK、message-types、session-format、sessions、compaction 文档，以及 `dist/core/agent-session.{js,d.ts}`、`pi-ai/dist/types.d.ts`。本功能只读取宿主已授权会话的 SDK instance；不扫描全局 session、user ledger 或 subagent 账本，不以 rootSessionId 授权，不暴露 SDK sessionFile/path/credentials。

## 确定契约

共享类型：`src/core/usage-snapshot.ts`，从 client 和 public contract 导出。

- 结算 SSE `type: "usage"` 保留原字段 `promptTokens/completionTokens/totalTokens: number | null`、`durationMs/ttftMs: number`、`requestId`，新增 **optional** `lastResponse`、`sessionTotals`、`branchTotals`、`context`、`execution`、`currentPrompt`、`subagentTotals`、`subagentAllTotals`；`status` 可带同样的 optional `execution` 快照。
- `GET /v1/sessions/:id/export` 新增 **optional** `usageSnapshot: UsageSnapshot`。token/速度/context 由已有 runtime 的真实 Pi adapter 提供；沿用当前 owner/session 授权和只读 export 路径，不为刷新创建 runtime。无 runtime 的只读 JSONL export 也恢复执行计数、`sessionTotals`、`branchTotals`、`context`、`subagentTotals` 与 `subagentAllTotals`（`src/agent/cold-usage-snapshot.ts` 按 Pi `getSessionStats` / `getContextUsage` 的同一规则从已存条目计算；模型按 transcript → 数据库记录 → 服务默认模型取，窗口来自模型目录，查不到窗口时 `context` 为 null）；缺失不能当作 0。新建/恢复的 adapter 尚无本轮响应时 `lastResponse: null`，不恢复或推算历史速度。
- 快照外层可缺省（旧 adapter/服务兼容）；对象内如下字段都存在，但数字可为 null；对象自身可为 null。null/缺失均表示未知，0 为有效 SDK 测量。前端不得把 unknown 当 0。

```ts
type UsageTokens = {
  input: number | null; output: number | null;
  cacheRead: number | null; cacheWrite: number | null;
  totalTokens: number | null; costUsdEstimate: number | null;
};
type UsageSnapshot = {
  execution?: {
    scope: "allEntries"; coverage: "complete" | "recorded" | "unknown";
    totalLoops: number | null; totalTurns: number | null;
    recordedLoops: number | null; recordedTurns: number | null;
  } | null;
  lastResponse?: (UsageTokens & {
    ordinal: number | null; // 当前 host prompt 内一基 assistant 序号（含工具循环/重试）
    cacheHitPercent: number | null;
    speed: { outputTokens: number | null; generationDurationMs: number | null; tokensPerSecond: number | null };
  }) | null;
  sessionTotals?: (UsageTokens & { scope: "allEntries" }) | null;
  context?: { tokens: number | null; window: number | null; percent: number | null; estimate: true } | null;
  currentPrompt?: (UsageTokens & { calls: number }) | null;
  subagentTotals?: (UsageTokens & { runs: number; calls: number }) | null;
};
```

## 口径

- `input` 是 SDK 非缓存输入，旧字段映射 `input → promptTokens`、`output → completionTokens`。`output` 已包含 reasoning，不另加。末次 `totalTokens` 原样映射 SDK 值，不重建总和。
- `cacheHitPercent = cacheRead / (input + cacheRead + cacheWrite) * 100`。必须三项都有效且分母有限、大于零；否则 null。
- `costUsdEstimate` 是 SDK 基于模型价格的 USD **估算**（末次为 `usage.cost.total`，累计为 `getSessionStats().cost`）。SDK 返回 0 就传 0，不宣称实际免费或实际账单。缺失、负数、NaN/Infinity 为 null。
- `sessionTotals` 直接投影 SDK `getSessionStats()`：当前 session 文件 **allEntries**，不是 active branch，也不是所有用户 session。包括旧分支、压缩前消息、压缩/分支摘要 usage、standalone usage 和带 usage 的 toolResult。`tokens.total → totalTokens` 是 SDK 的总数；宿主不再把 subagent ledger 加进来，避免重复。它不是只统计本轮，亦不表示已从供应商核实费用。
- `branchTotals` 按与 `sessionTotals` 相同的规则只累加**当前分支**（`getBranch()`）上的条目，`scope: "branch"`；Pi 没有对应 API，由宿主 `entryUsageTotals` 计算。会话从未分叉时两者相同。
- `currentPrompt` 是当前 host prompt 内**每次模型调用**（每个 assistant `message_end`）的 usage 逐字段相加，`calls` 为已完成调用数。任一调用缺某字段，该字段即为 null（未知不当 0）。adapter 观察到本次运行时逐事件累加；未观察到事件（兼容 fallback）时从本次 prompt 新增的 assistant 消息重建；服务重启后没有本次 prompt，返回 null。下一次 prompt、导航、dispose 清零。
- `subagentTotals` 汇总**当前分支** `agent-team:transcript` custom entry 中已完成（`complete: true`）的 assistant 消息 usage，每条消息按其最后存储版本计一次；`runs` 为分支上的子代理运行数，`calls` 为已完成的子代理模型调用数。`subagentAllTotals` 用同一规则统计 session 文件的**所有条目**（含已离开的旧分支）。两者各自独立、口径完整，不混用范围。子代理是独立会话，这部分**不在** `sessionTotals` / `branchTotals` 内，相加不会重复。对应范围内没有子代理时为 null；仅有旧版 agent-team 工具结果、没有 transcript 的运行不计入。
- `context` 是每次直接读取 SDK `getContextUsage()`（无 runtime 时为同规则的只读计算）的当前上下文估算，非累计。`contextWindow → window`；未知/无模型/读取失败返回 null；无效或零 window 不形成 percent。SDK 在 compaction 后无新有效 assistant usage 时可保留 window 而 tokens/percent 为 null。宿主不缓存 context，因此结算/export 在压缩、模型切换、导航后不会复用旧 context。

## 实际执行轮与 model turns

- **轮（host agent loop）**：宿主已接受任务在 SDK 真正发出首个 `agent_start`（或兼容 `turn_start`）才计一次，持续至本次 `prompt` / `sendCustomMessage` 最终 resolve/reject。排队、准入、导航期间取消、扩展消耗输入但未启动 SDK 均不计。已开始后中止仍计一轮。活动期 steer/follow-up/custom follow-up 在同一宿主任务内，不另开轮；idle host custom task 实际执行则是新轮，与是否有 user message 无关。
- **turn**：每次真实 SDK `turn_start` 计一次；工具数量、message_start/message_end/turn_end 不代替该事件。已开始后 aborted/error 仍计；工具后续、活动 follow-up、retry 真正产生的新 turn 都计。compaction 摘要调用不是 agent-core turn，只有恢复后的真实 turn_start 才计；manual compaction 不造轮。
- SDK 1.0.4 的 `agent-core/dist/agent-loop.js` 在 `runAgentLoop` / `runAgentLoopContinue` 均发 `agent_start` 与 `turn_start`，工具/队列后续再发 turn_start。`AgentSession._handleAgentEvent` 可给 agent_end 加 `willRetry`；extension turnIndex 在每次 agent_start 重置，且 public SDK turn_start 本身没有 ID/ordinal。`agent_end`（即使 willRetry=false）不是宿主最终 settle；`agent_settled` 与 prompt promise 才是稳定边界。因此此处明确采用**宿主 loop**，不是每次低层 SDK run 一轮；重试多个 SDK agent_start 不增加轮数。
- `pi-agent-server:execution-metrics:v1` JSONL **custom entry** 保存 baseline（是否完整）、loopId UUID、turnId UUID / loopId / 一基 ordinal。它不是 custom_message，不进入模型上下文，不显示成通知，不改变调度或事件归属。每 session 打开时只读 getEntries 一次建集合；运行中固定一个 adapter 内部 observer，O(1) 更新，一轮一个 loop 记录、每 turn 一个记录，无结束重复记账、不每 delta 扫文件/SDK统计。不随 SSE 订阅数或 adapter 外部退订重订增加。SDK public subscribe 没有历史回放；同一事件对象的重复派发也去重。任意结构相同的新 turn_start 不能当作旧事件（SDK 无稳定事件 ID），否则真实重试会漏计。
- `scope: allEntries` 与 sessionTotals 一致：当前授权 session 文件所有分支，不随 active-leaf 导航减计数；用 loopId / turnId 去重，复制的相同记录不重复计。SDK fork 复制的祖先路径只继承其中仍存在的记录，原文件未复制的其他分支不随 fork 继承。HTTP messages/timeline 仍仅当前分支；**工具次数和用户消息详情仍是当前已加载分支**，不是服务端全会话计数。
- `complete`：从空会话开始记录，totalLoops/totalTurns 是权威累计，新会话确实空为 0。`unknown`：老历史无记录、缺乏 manager 能力或持久化异常，数字为 null。`recorded`：有新记录但旧历史存在缺口，**totalLoops/totalTurns 始终 null**，recordedLoops/recordedTurns 仅表示已记录范围；详情明确“已记录范围 / 全历史未知”，不假装全历史已补齐。不能从相同文本、用户消息数或恢复的 assistant 数反推历史真实执行。
- SSE status 和结算 usage 推送的是**总量快照**（optional 兼容旧 server），不是前端增量；客户端仍先校验 activeRequestId，重复快照幂等，已知 recorded 高水位不被旧 SSE / cachedcursor / export 快照降低。export 恢复计数到同一 session store，其他 session 不共用；同一文件重启恢复集合后继续累计。
- 计数通过 SessionManager custom entry 持久化，不新增 DB migration。source claim 由宿主 FD `_persist` 立即追加，包括 custom-only；旧 managed 路径仍受 SDK 延迟 flush 影响。持久化失败计数返回 unknown，FD 写入失败还会 poison runtime；不承诺 fsync 级抗断电或恢复中断的运行状态。
- Web 展示见下文「Web 统计栏与详情」；未知计数直接省略，不回退 user count。

## 工具执行耗时

SSE `tool_end`、export timeline `tool_result`、client `ToolCall` 支持 `durationMs?: number | null`。仅透传 SDK `tool_execution_end` 及持久化 `toolResult` 的真实执行测量，接受有限非负值（0 有效），null/缺失未知；非法值省略，不用 tool_start 到结束的宿主时间猜测历史值。subagent 工具的 duration 是该工具调用耗时，不代表 child 后台完整运行时间，也不替代响应速度/usage.durationMs。无数据库迁移。SDK `agent_settled.aborted` 不改变宿主 promise + 最终 stopReason 的终态结算；retry 增加实际 turn、不额外增加 host loop。

## 响应计时与生命周期

- 使用注入的 monotonic clock，生产为 `performance.now()`。每个 assistant `message_start` 清末次响应并递增 ordinal；首个**非空** text/thinking/toolcall delta 记起点，`message_end` 携带最终 usage 并记终点。
- `tokensPerSecond = usage.output / (generationDurationMs / 1000)`。duration 是此 assistant 内起点到终点，**不含** request 初始等待、前一次 assistant、后续工具等待。它仍包含此响应内部的 provider/stream 停顿，不声称纯硬件推理吞吐。
- 可靠性阈值明确为 **10ms**：小于 10ms（包括零）速度为 null，原始非负 duration 可保留；10ms 本身有效。不将 duration 截成 250ms，不把速度封顶为 1000，不按字符估算 output，不四舍五入协议值。无 start/非空 delta、倒退/非法时钟、无有效 output → 相应速度未知。
- host `prompt()` 起始清上一轮 lastResponse；最后 assistant 即使 error/aborted，只要最终 usage 有效仍可信。最新消息缺失或非法 usage 不回溯前一次 assistant。最新开始但未结束返回 null。事件权威路径不受 compaction 换掉 messages 前缀影响。
- 无事件的兼容 fake/adapter fallback 仅看本次 prompt 新增的末次 assistant，保留全零；前缀被替换时返回 unknown，绝不回捞历史。此 fallback 无法获取 ordinal/计时，二者为 null。
- shared client reducer 在 `status.agent_start` 清 `lastResponse`，`context` 保留上一次的值直到本次结算 `usage` 替换（前端同时把已加载的 export 快照交给实时统计，避免运行中上下文消失）；结算 `usage` 原样保留新字段，旧事件仍接受。sessionTotals 可保留但须标“上次快照”。前端切换 session/导航/模型变更时也须清或重新读取 export 的 context，不跨 session 复用；只读历史 export 缺失统计要显示未知。实际 token/context 快照不是逐 delta 推送，也没有主动模型/导航 context SSE；结算及已有 runtime export 才是这些快照的采样点。实时字符估算使用下述独立事件，不写入 usage。
- 原 `durationMs` 含工具执行与 usage 等待，原 `ttftMs` 仍是首正文/thinking延迟（无 delta 的历史回填保留）；都**不能作为新速度的分母**。usage 超时/异常不阻塞槽位释放，不虚造统计。

## 流式活动与速度估算

- 真实 Pi adapter 内读取既有 SDK assistant `message_start/update/end`。只对非空 text/thinking/toolcall delta 累加 JavaScript UTF-16 `delta.length`，字符数 / 4 为 token **估算**；中文、emoji、工具参数的 tokenizer 比率可能差异很大，不冒充实际 input/output。工具执行 start/update/end、tool 结果不计入模型 token。
- 使用 adapter 已有注入单调时钟，生产 `performance.now()`。每条 assistant 重置，速度分母为此 assistant 首 delta 至最新 delta，包含该响应内部暂停，不跨工具循环均摊。低于 10ms 或无有效分母仅报告收到输出，不虚造 0/Infinity，也不封顶或人为抬高。
- 可选 SSE `model_output_progress`：`ordinal`、`phase: start|delta|end`、`tokensPerSecondEstimate: number|null`、`includesThinking`、`requestId`，可选 `activityAgeMs`（最后源 delta 在发布时的年龄）、`replay`、`promptTokens`（本次 prompt 已完成模型调用的 totalTokens 合计，首个调用完成前或未知为 null；与 `currentPrompt.totalTokens` 同源）。`ordinal` 即本次 prompt 内的第几次模型调用。旧 adapter 可不提供，旧 client 忽略未知事件，原 text/thinking/tool/usage 协议仍保持。新 client 连接旧服务时无实时数字，仍显示等待/真实工具生命周期，不把缺失当零。
- 事件驱动内存 O(1) 增量计数与快照；250ms 合并发布（持续输出约 4 次/秒），每 adapter **最多一个**脏值 trailing timer。第一批可立即发活动（速度未知），边界立即发送；end flush 脏值后清 timer，prompt resolve/reject、abort、navigate、dispose 均清理。不调用 SDK getSessionStats/getContextUsage，不扫 session/账本，不读取 global ledger，不新增 HTTP 拉取。最终 usage 仍按既有结算读取。只读参考 `tui.ts` 的字符估算/单 timer 合并及 `usage-stats.ts` 的采样和渲染分离；不执行 extension、不复制其全局账本/额度功能。
- Web 运行中统计栏显示 `~100 tok/s`。**活动窗口为最近 2 秒的真实源 delta**：前端 `performance.now()` 记录收到进度时间并扣除 `activityAgeMs`，只设一次到期 deadline，无轮询。文案“最近收到模型输出”不声称服务端此刻绝对正在生成。到期显示“等待模型输出”；仅当前请求真实 tool_start 且尚无 tool_end 的 lifecycle 显示“工具执行中”；终态/新请求清工具活动集，不从历史未完成卡片或孤立 tool_update 伪推断执行状态。工具与模型实际可交错，近窗模型 delta 优先。
- SSE bus 为 progress 补发标 `replay:true`，客户端不以补发续活，不用断线前 delta 计算前端 elapsed。断线立即清活动并显示“连接已断开”；abort/error/completed、历史恢复、session 切换/unmount 清活动和 deadline，只有新 source 事件可恢复。网络缓冲仍可能延迟观测，这不是模型存活探针。
- 完成时只展示后端 SDK `tokensPerSecond`，**无 `~`**；其分母仍为首非空 delta 至 message_end，含响应内暂停，不含工具等待。所有原有末次响应/会话累计/上下文 scope 保留；实时估算不藏 details。数字使用 tabular-nums/稳定最小宽度；aria-live 只播报状态，不播报每次速度数字。

## Web 统计栏与详情

Composer 下方一行，从左到右三组（DESIGN.md §3.1）；点击打开统计详情。数字统一格式（`web/src/i18n/format.ts`）：一万以下显示完整整数（`4403`），以上按 locale 缩写并保留三位有效数字（`1.3万`、`6.46亿`），百分比不带空格（`0.44%`、`95%`），费用为 `$0.0042`。

- **空闲**：`2 次任务 · 3 次调用 · 工具 1 次`（`execution` 的 loops / turns；工具为当前已加载分支）｜`会话 1.3万 tok（子代理 8000） · 缓存 67% · $0.004`（当前分支：`branchTotals` 与 `subagentTotals`，旧服务没有 `branchTotals` 时退回 `sessionTotals`；缓存命中按会话累计计算；费用为会话加子代理，模型未计价——费用为 0 但有用量——时不显示）｜`上下文 4400 / 100万`（`context.tokens / window`，缺任一时退回百分比；占用 ≥80% 显示警示色；没有 context 时显示占位 `上下文 —` 并在悬停说明原因，不整项消失）。运行中上下文保留上一次的值。
- **运行中**：左组换成 `本次 第 4 次调用 · 工具 6 次 · ~124 tok/s`（`model_output_progress.ordinal`、本次用户消息之后的工具、2 秒活动窗口内的估算速度）；中组在本次首个调用完成后换成 `本次 5200 tok`（`promptTokens`），之前仍显示会话累计。
- **放不下一行时**（窄屏或数字很长）：按 `SUMMARY_DROP_ORDER` 依次隐藏工具数、缓存命中、调用数、费用、任务数、实时速度、本次调用序号，直到一行放得下；会话 / 本次用量和上下文始终保留。按实际宽度测量（ResizeObserver），不按视口断点；分隔符由 CSS 生成，跟随仍显示的项。
- **详情**：按口径分组的两列定义列表，口径说明收进各组标题旁的 ⓘ。分组为本次任务（状态、模型调用、工具调用、用量、耗时、首字延迟）、末次模型调用（用量、明细、缓存命中、输出速度；运行中标「上次任务」）、会话累计（任务、模型调用、用户消息、用量、明细、缓存命中、费用；`recorded` 覆盖时标「仅含开始记录之后」）、子代理（会话累计与子代理在当前分支和全部分支不同时分「当前分支 / 全部分支」两列，缺一侧显示 `—`；任务数和调用数只有全部分支口径，用户消息只有当前分支口径；相同时只显示一列）、工具（次数、失败、耗时合计、按工具名分布）、上下文。旧服务只给 `promptTokens/completionTokens/totalTokens` 时，末次模型调用退回显示这三个值。

## 验证

无真实模型、网络或用户数据库；SDK-shaped fake session、内存 SQLite HTTP 测试。`tests/agent/usage-snapshot.test.ts` 验证 cache/cost、零/非法数字、10ms 边界及无封顶、thinking/toolcall 起点、工具等待排除、多 assistant/重试 ordinal、abort unknown、倒退时钟、context 压缩/模型/导航变化、独立恢复 session、前缀压缩污染防护、runtime requestId 与 shared reducer 新/旧字段。HTTP export 测试验证快照透传、owner 隔离和只读刷新不新建 runtime。OpenAPI 源与生成 JSON 同步，保留旧 required 列表，新增字段 optional。

命令：

```sh
volta run npm run typecheck
volta run npm run generate:openapi
volta run node node_modules/vitest/vitest.mjs run tests/agent/usage-snapshot.test.ts tests/agent/pi-agent-adapter.test.ts tests/runtime/session-runtime.test.ts tests/client/client.test.ts tests/public-api/openapi-v1.test.ts tests/server/session-export.test.ts tests/server/session-history-reader.test.ts
```

验证结果（Node v24.19.0，`volta run`）：root typecheck（覆盖 backend/client/tests）与 schema 生成均 exit 0；扩大到 `tests/agent tests/runtime tests/client tests/public-api` 加上述两项 HTTP export 测试，18 文件 / 237 测试通过；定向 diff whitespace 检查通过。

实时扩展验证（均使用 `volta run`，无真实模型/用户 DB）：root typecheck、backend build、Web typecheck 通过；单独 `tsconfig.client.json` typecheck 被已有 `src/server/route-rbac.ts` 的 unused `PLUGIN_ROUTE_ACCESS` 和缺失 `FastifyRequest.access` 声明阻挡，未改动无关权限代码。定向 backend/client/OpenAPI 8 文件 123 测试；StatsBar/Chat Web 4 文件 30 测试。`tests/agent/model-output-performance.test.ts` 用 fake clock 验证 1000 delta / 秒最多 5 次 progress（含首批），最多一个 timer，end/abort cleanup，零额外 SDK stats/context 或 HTTP 调用。`tests/agent/model-output-progress.test.ts` 验证 Unicode/batch/thinking/toolcall、工具排除、独立 assistant、无封顶、replay/terminal 清理及 production adapter → runtime → 实际 usage 分离。

浏览器隔离真实 buildApp HTTP/SSE（内存 SQLite + 受控 SDK-shaped 模型输出，不调用真实模型）：`volta run pnpm exec playwright test --config playwright.live-output-local.config.ts`（在 `web/`）。8096/5196 专用端口，桌面 1280 与移动 390、明暗四组合通过 delayed 首段 → ~100 → 2s 暂停 → tool_update → 交错续输出 → disconnect/replay → 新 delta → 最终 42 tok/s → abort → 切 session。截图 `/tmp/live-output-speed/{light,dark}-{1280,390}-{active,pause,tool,final}.png` 已实际读取检查默认可见、无横向溢出。

执行计数补充验证（Node 22.19.0，均用 volta run）：root/Web typecheck、编译和 OpenAPI 生成通过；backend/client/runtime/OpenAPI/历史 export 24 文件 275 测试通过（另补充取消准入/持久化异常测试）；StatsBar 3 文件 18 测试通过。隔离 `web/e2e/host-followup.config.ts` HTTP/SSE 2 测试通过，宿主 idle/active 归属、独立计数、通知/user 安全断言保留；scroll-follow 1280/390 明暗 4 测试及 chat/SSE 3 测试通过。默认与详情截图在 `/tmp/loop-turn-stats/{light,dark}-{1280,390}[-details].png`，已实际读取默认四组合及详情截图：单行无横向溢出，390 速度可见，Composer 未重做。请求/帧证据在同目录 `http-sse-evidence.json`。所有 DB 为内存或临时路径、SDK 为 fake；未调用真实模型、触及用户数据库/凭证、复用 8080/5173、重启服务或提交 git。

全局报表、真实账单、历史速度、无 runtime 的历史 token 累计不在本期范围。README 不因该内部协议说明另行修改。
