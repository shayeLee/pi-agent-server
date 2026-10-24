# 小派管家设计

> 状态：第一期已实现（2026-10-24，见 §8 与 §11），第二、三期未开工；§9 待定项已全部定下（2026-10-23）。2026-10-23 经 Astra 审核（结论「修改后开工」），并定下 §0 的决策；与 §0 冲突的旧写法以 §0 为准。登录三期已于 2026-10-23 合入 `main`，§10 按实际实现补了衔接点并更正了 §2、§5 里过时的写法。

## 0. 已定决策（2026-10-23）

1. **先做用户登录，再做管家；每个账号一个管家，第一版只给 admin 开**（2026-10-23 修订，取代「固定系统身份 / admin 看全部」的早先写法）。
   - 背景：Astra 复审指出 admin 仍受 owner 隔离（`src/server/route-rbac.ts:8-9`），「admin 看全部」不是现有能力；用户又要用手机经局域网 IP 访问，按 IP 认身份时手机和电脑是两个 owner。
   - 身份改为账号（`user:<账号>`），浏览器登录换 cookie，Claude Desktop bridge 用个人 token 映射到同一账号；IP 白名单保留为第一道门。登录另写设计稿（精简版，不是 `docs/archive/identity-access-plan.md` 的公网 IAM）。
   - 管家归账号所有，每个账号最多一个；工具一律用管家主人的权限查，代码里没有 admin 特例。第一版用开关只允许 admin 使用。
   - 费用：每个管家的花费计入它主人账号的用量。
   - 不做 admin 跨账号只读（全服务总览）；以后需要再单独决定。
2. **关卡 1：只给只读工具**。管家用精确白名单，只写 `butler_*` 工具名；名单外的工具（内置、插件、扩展、MCP）一律不能用，SDK 已支持并有测试（`tests/agent/tool-selection-sdk.test.ts:109`）。另外两处单独堵：
   - 管家会话不加载扩展、skills、上下文文件，不挂 MCP 与 codemode，只保留连接模型必需的 provider 适配（扩展的事件钩子不受白名单约束）。
   - 服务端拒绝管家会话的 `POST /v1/sessions/:id/commands`。
   - 改法：白名单从 factory 共用的 `agentToolConfig` 改为按会话类型选择；`createSessionResourceLoader` 对管家走精简版。
   - 验收：环境里故意放一个注册 `bash` 的扩展并接上 MCP，新建、恢复、切换模型后 `getActiveToolNames()` 都只有 `butler_*`。
3. **关卡 2：输出前查权限**。管家只看得到它主人看得到的：主人自己的会话和项目，加上共享的 native 会话（§0.1 已定不做 admin 跨账号）。每次工具调用都经 `SessionService` 按主人的 ownerKey 过滤，不另设「是不是 admin」的旁路。native 会话共享被撤销后的处理仍按现有规则：新增读取路径在输出前复检 native 会话是否仍可用；管家尽量只记摘要和链接，不大段搬原文。
4. **关卡 3：防提示注入外发**（权限越大越要做）：
   - 管家回答用 `imagePolicy="link"`，不自动加载远程图片。
   - 工具只喂结构化摘要（标题、状态、受控错误信息），不给思考过程、工具原始输出和图片。
   - 系统提示写明工具返回的会话内容是数据不是指令；工具调用次数和结果大小设上限。
5. **事实更正**：幂等表有 `created_at` 索引（缺的是面向运行结果统计的查询模型）；`AgentSessionContext` 已有 `sessionId`，缺的是 `PiResourceLoaderRequest`；resource loader 会加载上下文文件和 skills，所以「没有文件工具就读不到 cwd」不成立，管家必须走精简 loader。

## 1. 目标

把数字人「小派」从「只看着当前会话的陪伴者」升级为 **agent server 管家**：

- **感知**：知道调用者能看到的所有会话在跑什么、哪些刚完成或失败，并主动告诉你。
- **对话**：可以直接问它「今天哪些任务失败了」「上周哪个项目花得最多」「worker 那个会话卡在哪了」，它用只读工具查服务端后回答。

入口三处：Web UI 任何页面都能叫它；页面不在前台时用系统通知；Claude Desktop 通过 pi bridge 也能问它。

不做的事（第一版）：

- **不替你动手**：不建会话、不发消息、不重试、不中止、不改设置。管家工具全部只读，Pi 内置的 bash / edit / write 等工具对管家会话关闭。
- 不做定时巡检（已有 Claude Desktop 的 pi-daily-check）。
- 不让模型为每一条提醒写话：提醒用本地句子，模型只在你和它对话时才调用，控制花费。

## 2. 现状与缺口

| 需要 | 现状 | 缺口 |
|---|---|---|
| 所有会话的运行状态 | 只有单会话 SSE `/v1/sessions/:id/events`；侧栏只标当前会话；`RuntimeRegistry` 不对外列举 | 需要服务端的跨会话运行动态 |
| 运行结果历史 | 幂等表存 24 小时（有 `created_at` 索引，但没有面向运行结果统计的查询）；JSONL 里有 `stopReason` / `errorMessage` | 「今天哪些失败了」需要冷扫 JSONL（同 `usageReport` 的做法） |
| 结束事件的统一出口 | `ObservabilityPort` 已在 `SessionRuntime.settle` 发出 `turn{sessionId, requestId, outcome, durationMs}`，但 `start.ts` 没接 | 接上即可，补 ownerKey 由 sessionId 查 |
| 给单个会话加工具 | `customTools` 是整个 factory 共用；每会话的扩展在 `createSessionResourceLoader` 里组装，但请求里没有 sessionId / 会话类型 | 把会话类型传到 resource loader，按类型追加管家扩展 |
| 隐藏管家会话 | `sessions` 表没有 kind / hidden 列 | 迁移 v8 加 `kind` 列和 `butlers` 表（v7 已被账号表占用，见 §10） |
| 模型调用 | 开场白的 `completeWith` 是一次性、无工具、400 token | 管家用完整 Pi 会话，不复用它 |

身份取决于 `PI_AUTH_MODE`：`ip` 模式是 `ip:<地址>`，`accounts` 模式是 `user:<账号 id>`。「每个用户一个管家」即每个 ownerKey 一个，两种模式写法相同（见 §10）。

## 3. 总体结构

```
                 ┌──────────── pi-agent-server ─────────────┐
SessionRuntime ──settle/start──> RunActivityHub（内存）       │
                 │                 │  最近结果环形缓冲 + 订阅   │
                 │                 ├─> GET /v1/activity        （快照）
                 │                 └─> GET /v1/activity/events （SSE，按 canAccess 过滤）
                 │                                            │
                 │  管家会话（kind = butler，每个 ownerKey 一个）│
                 │    扩展 pi-agent-server-butler：只读工具 ──> SessionService（带 ownerKey）
                 └────────────────────────────────────────────┘
Web UI：常驻小派 ← activity SSE；点开 → 管家对话面板（复用现有会话接口）
Claude Desktop：pi bridge 新增 pi_ask_butler
```

## 4. 感知：跨会话运行动态

### 4.1 RunActivityHub

- 进程内服务，实现 `ObservabilityPort`，在 `start.ts` 的 `buildApp` 接上。
- 关心三类事件：运行开始（`submitting` / `queued` → `streaming`）、运行结束（`completed` / `error` / `aborted`，带错误信息与耗时）、会话标题变化。运行开始需要在 `SessionRuntime` 补一个 `turn_started` 观测事件。
- 每条动态：`{ id, at, sessionId, projectId, title, kind: "started" | "completed" | "failed" | "aborted", durationMs?, message? }`。`message` 只取首行并截到 200 字。
- 内存里保留每个 ownerKey 最近 24 小时、最多 200 条结果，以及当前正在跑的会话集合；重启后清空（历史由管家工具冷扫 JSONL 补）。
- 只记录 managed 会话；共享的 native 会话按 `canAccess` 同样能看到。管家会话自己的运行不进动态。
- 实现（第一期）：hub 不按 ownerKey 分桶，全进程保留最近 24 小时、最多 1000 条结果，读取时逐条按 `SessionService.activitySubject`（`findOwned` / `canAccess`）过滤，删掉或取消共享的会话随即消失；单个调用者一次最多拿 200 条。标题在读取时现查，所以不单独记录标题变化。

### 4.2 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/activity` | `{ running: [...], recent: [...] }`，只含调用者能访问的会话；权限同 `sessions:list` |
| `GET` | `/v1/activity/events` | SSE：连上先发一条 `activity_snapshot`（同快照），之后每条变化发 `activity`；不支持 `Last-Event-ID`，重连拿新的快照；占用一个每用户 SSE 名额（`MAX_SSE_PER_USER`）；权限同 `sessions:list` |

过滤一律经 `SessionService.canAccess`，不直接查仓库。

### 4.3 侧栏顺带受益

拿到 `running` 集合后，侧栏标出所有正在跑的会话，不再只标当前会话。已定在第一期一起做（§9.4）。

## 5. 对话：管家会话

### 5.1 会话

- 迁移 v8：`sessions` 加 `kind TEXT NOT NULL DEFAULT 'chat'`，取值 `chat` / `butler`；新表 `butlers(owner_key 主键, session_id, created_at)` 保证每个 owner 最多一个管家（schema manifest 不支持带条件的唯一索引，所以不靠 `sessions` 上的索引来保证）。
- `listSessions`、`listProjects`、侧栏、`@` 补全一律排除 `butler`。用量统计**计入**管家的花费，并在 `/v1/usage` 里单独标出（§9.1）。
- 项目：管家不属于任何用户项目，cwd 用服务 agentDir 下的 `butler/` 目录（只为满足 Pi 会话需要一个目录；它没有文件工具，读不到）。
- 模型：默认模型；用户可在管家面板里切换，记在管家会话上。
- 历史：一个长会话，开启自动压缩；面板提供「重新开始」，丢弃旧的管家会话、新建一个。
- 系统提示词：说明它是谁（名字与说话风格取自人设）、只能查不能改、回答要给出会话链接、看不到的就说看不到。

### 5.2 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/butler` | 返回调用者的管家会话 `{ session \| null }` |
| `POST` | `/v1/butler` | 没有则创建，有则返回；`{ reset: true }` 时新建并逻辑删除旧的 |

之后发消息、SSE、中止、步骤全部走现有的 `/v1/sessions/:id/...`，因为管家会话的 owner 就是调用者。权限：`sessions:create`；viewer 没有管家（只能看动态）。

### 5.3 工具注入

- `AgentSessionContext` 与 `PiResourceLoaderRequest` 增加 `sessionId`、`kind`、`ownerKey`。
- `createSessionResourceLoader` 在 `kind === "butler"` 时追加一个内联扩展 `pi-agent-server-butler`，用 `pi.registerTool` 注册下列工具；同时把内置工具白名单收成空，项目 MCP 不加载。
- 工具实现闭包持有 `SessionService` 与该会话的 ownerKey，每次调用都经 `SessionService`，权限与 Web 看到的一致。

### 5.4 只读工具

| 工具 | 作用 | 数据来源 |
|---|---|---|
| `butler_list_projects` | 项目列表 | `listProjects` |
| `butler_list_sessions` | 会话列表，可按项目、时间、关键词过滤，带当前是否在跑 | `listSessions` + RunActivityHub |
| `butler_recent_runs` | 一段时间内的运行结果，可只看失败 | RunActivityHub；超出内存范围时冷扫 JSONL 的 `stopReason` |
| `butler_usage` | 按天 / 周 / 月、按模型与项目的花费 | `usageReport` |
| `butler_session_brief` | 一个会话的标题、模型、最近几条消息摘要、最后的错误 | `getSessionSteps`（截取尾部） |
| `butler_subagents` | 一个会话的子代理运行与状态 | `getSubagents` |

工具输出都有长度上限，大段内容只给摘要与会话链接。

## 6. Web UI

### 6.1 常驻小派

> 2026-10-24 修订：页面上只留一只小派。原稿在侧栏底部再放一只小号小派，实际同屏两只显得重复，改为侧栏底部放文字入口「运行动态」，跨会话的话由输入框上（或起始态居中）的那只小派说。

- 侧栏底部（§9.3）是文字入口：平时写「运行动态」，有会话在跑时换成「N 个在跑」并用强调色；侧栏收起时只剩图标，右上角小圆标显示数量。
- 其他会话刚完成或失败时，小派冒一句话（本地句子，按说话风格），点击话泡跳到那个会话；当前正看着的会话不重复冒话。会话里由输入框上的那只说，它自己会话的话优先；起始态由居中的小派在头顶说，不挤动下方的开场白和快捷入口。空闲时表情跟着变（完成开心、失败沮丧），正在为当前会话干活时表情不变。小派收起时不冒话。
- 点击入口打开**管家面板**：右侧抽屉（与轨迹面板同一位置，二者互斥，§9.2），上面是「正在跑」和「最近结果」两个短列表，下面是和管家的对话，沿用账本的消息样式与输入框（不带 `@` 和 `/` 菜单）。
- 减少动态效果、收起小派等现有规则照旧。

### 6.2 系统通知

- 默认关闭；在小派的设置里打开，打开时才请求浏览器通知权限。
- 只在页面不在前台时发：其他会话（或当前会话）运行完成或失败。中止不发。
- 同一会话 10 秒内只发一条；点击通知回到页面并打开那个会话。
- 开关按浏览器保存（`accountScopedKey("pi:companion-notify")`，换账号不串）。原定存进人设的 `notify` 字段，第一期改为按浏览器：浏览器授权本来就按浏览器给，在一台机器上打开不该让另一台也弹。

## 7. Claude Desktop

pi bridge 增加两个工具：

- `pi_ask_butler`：向管家提问并等待回答（复用 `pi_send` + `pi_wait` 的实现），返回回答与 Web 链接。
- `pi_activity`：读取 `/v1/activity` 快照，不经模型，适合 Claude 快速看一眼。

pi-daily-check 保持不变；以后可以改为调用 `pi_activity`。

## 8. 分期

| 期 | 内容 | 可独立交付 |
|---|---|---|
| 一（已完成，2026-10-24） | RunActivityHub + `/v1/activity`（含 SSE）+ 侧栏标出所有在跑的会话 + 侧栏运行动态入口与跨会话话泡 + 系统通知 | 是：不涉及模型，花费为零 |
| 二 | 迁移 v8 + 管家会话 + 工具注入 + 只读工具 + 管家面板 | 是 |
| 三 | bridge 的 `pi_ask_butler` / `pi_activity`，正式部署副本同步 | 是 |

每期都补单元测试、HTTP 测试与 E2E 分组（按 `pnpm run e2e`），并更新 DESIGN.md §6.6、docs/web-ui.md、docs/api.md；如涉及 README，同步中英文两份。

## 9. 已定（原待定项，2026-10-23）

1. **管家的花费计入 `/v1/usage`，并单独标出**：总数是真实花费，同时能看出管家花了多少。
2. **管家面板与轨迹面板共用右侧位置、互斥**：打开一个就收起另一个，布局最简单，不遮挡对话。
3. **跨会话入口放在侧栏底部**：不遮挡对话；会话内停在输入框上的小派保留。2026-10-24 起侧栏底部只放文字入口，不再放第二只小派（§6.1）。
4. **第一期就让侧栏标出所有在跑的会话**：拿到 `running` 集合后几乎没有额外成本。

## 10. 与登录的衔接（2026-10-23，按已合入的实现）

| 位置 | 要怎么做 |
|---|---|
| 身份与开关 | 管家归 `request.user` 算出的 ownerKey，两种模式同一套代码。「第一版只给 admin」用 `request.access.role === "admin"` 判断：`accounts` 模式下是账号的角色，`ip` 模式下是 IP 策略里的角色。不在代码里写死 `user:` 前缀 |
| 迁移版本 | v7 是 `accounts`，管家用 v8；备份、恢复要认 v0…v8 前缀，与以往每次加迁移一样 |
| `claim` | `butlers` 表加进 `CLAIM_TABLES`（`src/accounts-cli/claim.ts`）。源和目标都已有管家时算唯一约束冲突、整体拒绝，与 `companion_personas` 一样；管家会话本身是 `sessions` 行，已在转移范围内 |
| activity SSE | `/v1/activity/events` 照搬会话 SSE 的认证复核（`src/server/app.ts` 的 `recheckWithin` 与 `auth_expired` 关闭逻辑）：账号被禁用、改密码、token 吊销后在下一次复核时断开，Web 收到 `auth_expired` 回登录页；不影响在跑的任务 |
| Web 状态 | 管家面板的草稿、展开状态等本地缓存用 `accountScopedKey`（`web/src/auth/storage-scope.ts`），换账号不串；通知开关按浏览器保存，同样用 `accountScopedKey`（§6.2） |
| bridge | `pi_ask_butler` 问的是 token 所属账号的管家；token 吊销后返回 401，提示重新签发 |
| ops-viewer | 列会话时排除 `kind = 'butler'`，或单独标出；第一版排除 |
| 恢复 | 恢复已经会清空登录、吊销 token；管家数据随数据库恢复，不需要额外处理 |

## 11. 第一期实现记录（2026-10-24）

- 服务端：`src/application/run-activity-hub.ts`（hub 与 `fanOutObservability`）、`src/application/activity-service.ts`（按调用者过滤）、`src/shared/activity.ts`（类型）；`SessionRuntime` 在回合开始时发 `turn_started`。失败的回合等一个微任务，把同一次结算里的错误信息带上。
- 路由：`GET /v1/activity`、`GET /v1/activity/events`，与会话 SSE 共用名额预留、写入和认证复核（`auth_expired`）的同一套辅助函数，服务关闭前一并断开。
- Web：`useActivity` 订阅动态，服务端返回 404（没有这项功能）时停止重连；侧栏按 `running` 集合标出所有在跑的会话；侧栏底部的「运行动态」入口显示在跑数量，点开是下拉菜单，含「正在跑」「最近结果」各 5 条与通知开关；其他会话完成或失败时，输入框上（或起始态）的小派冒话泡（6 秒，点击打开该会话）。§6.1 的右侧管家抽屉随第二期的管家对话一起做。
- 与原稿的出入：通知开关按浏览器保存（§6.2）；SSE 用连上即发快照代替 `Last-Event-ID` 补发（§4.2）；hub 全局保留、读取时过滤（§4.1）。
- 测试：`tests/application/run-activity-hub.test.ts`、`tests/server/activity-http.test.ts`、Web 端 `useActivity` / `useRunNotifications` / `useElsewhereBubble` / `SidebarActivity` / `CompanionDock` 单测，E2E `web/e2e/activity.spec.ts`。自带 mock 服务的 E2E 夹具改为只把 `/v1/sessions/:id/events` 当会话流，`/v1/activity` 归入可选功能返回 404；一个页面现在自带两条 SSE（运行动态 + 会话），E2E mock 的每用户名额从 2 调到 3，配额用例屏蔽页面自己的运行动态流。
