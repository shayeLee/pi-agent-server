# 架构速览（核心数据流）

> 辅助阅读代码：核心数据流 + 关键代码位置 + 解耦边界。需求基线见 [needs.md](../needs.md)，本文件只讲「代码怎么组织、请求怎么流转」。

## 一、核心数据流

### 一次 `POST /v1/sessions/:id/messages` 请求

```text
① 准入   直接 socket IP（remoteAddress，忽略 XFF）→ CIDR/disabled gate → /v1 token gate
                                            src/server/network-admission.ts（+ ip-access-policy.ts / cidr.ts）
② 身份   来源 IP → canonical UserIdentity（IPv4-mapped 归一 v4）→ request.user / request.access
                                            src/core/user-identity.ts
③ 归属   owner == 该用户？                     src/application/session-service.ts
④ 幂等   requestId 已处理过？                  src/core/idempotency.ts + storage/kysely-idempotency-repository.ts
⑤ 状态机  idle？否则 409                        src/core/task-state-machine.ts
⑥ 并发   全局/每用户上限 → 放行/排队           src/core/concurrency-control.ts
⑦ 执行   Pi SDK session.prompt()               src/agent/pi-agent-adapter.ts
⑧ 翻译   SDK 事件 → SseEvent → SSE 字节        src/agent/translate.ts → runtime/session-event-bus.ts → server/sse-format.ts
⑨ 持久化  JSONL（Pi 写）+ 服务库 SQLite         src/storage/kysely-session-repository.ts
```

> ① 是 **WP5D-2 全局准入 + WP5D-3 role 授权**：准入覆盖 `/health`/`/readyz`/`/metrics` 与 `/v1` 全部路由——
> CIDR 外/disabled/socket IP 不可解析 → 403（探针亦同）；`/v1` 与 `/metrics` 且画像 tokenRequired 时缺失/错误
> Bearer → 401（实际 GET/非预检 OPTIONS；合规 CORS 预检免 token；`/health`、`/readyz` 永不要求 token）。
> 授权（`src/server/route-rbac.ts`）基于 `request.access.role` 的逐路由矩阵：探针（/health、/readyz）任意 admitted role、
> `/metrics` 仅 admin/operator（其画像 tokenRequired 时实际 GET 仍须 token）、operator 的 `/v1` 一律 403、viewer 仅纯读
> GET/export/SSE（写与 messages/steer/follow-ups/abort 一律 403；export 绝不实例化 runtime，viewer SSE 无 live
> runtime 返回稳定 204）、user/admin 维持 own-resource 行为（仍 owner 隔离，admin 暂不跨
> owner）；每路由显式 permission、未声明即 default-deny 403。IP-RBAC 不限制 cwd 或 Agent 工具的
> 绝对路径/OS 权限（不是 sandbox；workspace 安全 当前 RC 决策整体延期）。
> WP5D-1 policy core、WP5D-2 HTTP 网络准入与 WP5D-3 role 授权已 ✅ 验收，依据用户提供的在移除 workspaceRoots/`PI_DEFAULT_WORKSPACE_ROOT` 并提交 `5e84a9da` 之后的新 release run 中，完整真实 PG16+age `pnpm verify:release` 成功证据；本次验收仅针对 WP5D，WP5 整体仍未完成（WP5B DEFERRED，WP5C deployment drill 未验收）；admin cross-owner read 未实现；**WP5D-4 owner transfer（DB 层 IP→IP 离线 CLI）✅ 已验收**——用户提供的完整真实 PG16+age `pnpm verify:release` 成功证据中，真实 PostgreSQL owner-transfer gate、真实 age gate，以及 compiled + installed-npm PostgreSQL E2E smoke 均通过；见 [owner-transfer.md](owner-transfer.md)。本文不记录测试数量。
> ④⑤⑥⑦⑧ 的编排集中在 [`src/runtime/session-runtime.ts`](src/runtime/session-runtime.ts)（`submitMessage` → `doSubmit` → `runStreamingTask` → `settle`）。
> HTTP 层（[`src/server/app.ts`](src/server/app.ts)）只把决策映射为状态码（202 放行 / 409 冲突 / 429 排队满），不承载业务编排。

### 控制链路（streaming 期间，旁路）

```text
steer / follow-up / abort
  → ⑤ 状态校验 → ⑦ session.steer()/followUp()/abort() → ⑥ 释放槽位
```
HTTP 路由在 `app.ts`，应用逻辑在 `session-service.ts`，编排在 `session-runtime.ts`。

### 并发模型（⑤⑥ 展开）

并发由两层共同保证，建议按下面顺序读代码：

1. **状态机（同会话串行）** — `src/core/task-state-machine.ts`（全文 ~70 行）：`TABLE` 状态×事件表定义 `idle → queued → streaming → terminal → idle`，仅 `idle` 可 `submit`（否则 409）；`transition()` 是纯查表函数。
2. **并发控制（跨会话）** — `src/core/concurrency-control.ts`：`submit()` 三态（有槽位 `run` / 无槽位 `queue` / 队列满 `reject`→429）；`canRun()` 判断全局/每用户上限；`finish()` + `drainQueue()` 释放槽位并出队；`expireQueued()` 排队超时。
3. **编排（两层串起来）** — `src/runtime/session-runtime.ts`：主线 `doSubmit`（⑤ transition → ⑥ submit → 三态分流）→ `settle`（`finally` 先 `concurrency.finish()` 释放槽位并唤醒其他会话，再 `release` 回 `idle`）→ `startQueuedTask`（出队接续）。`release` 延迟到槽位释放之后，是避免收尾窗口内并发误判的关键。

### IO 持久化并发（单进程、单线程事件循环）

三个组件的并发安全性各有来源，按需查阅：

- **日志（pino）** — `src/server/app.ts` 的 `logger` 配置：异步写 stdout，内部 buffer + 背压，不阻塞业务。
- **会话 JSONL** — `src/server/start.ts` 的 `createAdapter`：只记录 `piSessionFile` 路径，不直接读写文件；同会话由状态机串行保证单文件无并发写。
- **数据库（SQLite）** — 读代码顺序：
  1. `src/server/start.ts` 创建 `DatabaseSync`（`timeout: 5000` + `enableForeignKeyConstraints: true`），初始化后 `ensureDefaultProject`（默认项目落库，`owner_key=''` 共享）
  2. `src/storage/bootstrap.ts`：文件库启用 WAL（`:memory:` 跳过）+ Kysely schema builder 幂等 bootstrap（全部 `IF NOT EXISTS`，只面向新库/已是当前 schema 的库；RC 阶段无旧库兼容/版本化迁移，演进走完整重建）
  3. 三个 Repository（`kysely-session-repository.ts` / `kysely-project-repository.ts` / `kysely-idempotency-repository.ts`）仅 CRUD；项目删除由 Kysely `transaction` 与 FK `ON DELETE CASCADE` 兜底（`sessions.project_id → projects.id`）
  - **本质**：`DatabaseSync` 同步 API + 单线程事件循环 → 进程内天然串行（一个 `db.run()` 返回前事件循环不切走）；并发风险只在多实例（WAL 单写者 + busy timeout 兑底）。

## 二、目录职责

| 目录 | 职责 | 关键文件 |
|---|---|---|
| `src/core/` | 纯逻辑，零 IO/外部依赖，可独立单测 | `task-state-machine.ts`、`concurrency-control.ts`、`idempotency.ts`、`user-identity.ts`、`cidr.ts`、`ip-access-policy.ts`、`ip-access-config.ts`、`ip-access-policy-file.ts` |
| `src/application/` | 应用层：不依赖 Fastify/SQLite/Pi SDK | `session-service.ts`、`ports/`（端口契约）、`capabilities/`（能力组合） |
| `src/runtime/` | 会话任务编排（状态机+并发+幂等+执行+事件） | `session-runtime.ts`、`runtime-registry.ts`、`session-event-bus.ts` |
| `src/server/` | HTTP 层 + composition root | `app.ts`、`start.ts`、`network-admission.ts`（WP5D-2 全局准入）、`route-rbac.ts`（WP5D-3 role 授权：中央 permission + default-deny hook）、`sse-format.ts`、`sse-backpressure.ts`、`sse-socket.ts` |
| `src/agent/` | Agent 适配边界 | `agent-adapter.ts`（接口）、`pi-agent-adapter.ts`（Pi 实现）、`mock-agent-adapter.ts`（测试）、`events.ts`、`translate.ts` |
| `src/storage/` | 存储适配器（实现 ports；SQLite/PG 各自方言 bootstrap + 方言中立 Repository） | `bootstrap.ts`、`postgres-bootstrap.ts`、`schema-manifest.ts`、`schema-builder.ts`、`node-sqlite-adapter.ts`、`db-schema.ts`、`kysely-session-repository.ts`、`kysely-project-repository.ts`、`kysely-idempotency-repository.ts` |
| `src/model-adapters/` | Pi ModelRuntime → ports 适配 | `pi-model-runtime-catalog.ts`、`pi-model-runtime-credentials.ts` |
| `src/provider-adapters/` | 厂商协议适配（与核心数据流解耦） | `registry.ts`、`types.ts`、`openai-tool-policy.ts`、`deepseek-v4/` |

## 三、解耦边界

1. **依赖方向单向**：`core/`、`application/`、`runtime/` 不依赖 Fastify、SQLite、Pi SDK、厂商类型；外部实现（`server/`、`storage/`、`agent/pi-agent-adapter.ts`）通过 [`src/application/ports/`](src/application/ports/) 的接口被核心调用（依赖倒置）。
2. **纯逻辑优先**：①准入（CIDR/disabled/token 判定）与 ④⑤⑥ 均为纯逻辑，集中在 `src/core/`（`cidr.ts`、`ip-access-policy.ts`）与 `src/server/network-admission.ts`（接线闭包，无 IO）。
3. **厂商协议隔离**：`src/provider-adapters/` 只做「厂商流 → 规范事件」的归一化，绝不执行工具、不进入 HTTP/存储/工具授权路径；工具执行始终走 Pi 原生白名单路径。
4. **执行唯一入口**：适配器只产生规范化调用事件，Pi Agent 的工具白名单、schema 校验、权限钩子是唯一执行路径。

## 四、端口契约（`src/application/ports/`）

| 端口 | 职责 |
|---|---|
| `session-runtime-port.ts` / `runtime-lifecycle-port.ts` | 会话运行时（业务端口 / 生命周期端口） |
| `session-store-port.ts` / `project-store-port.ts` / `idempotency-store-port.ts` | 会话 / 项目 / 幂等存储 |
| `model-catalog-port.ts` / `credential-port.ts` | 模型目录 / 凭证 |
| `system-prompt-port.ts` / `tool-authorization-policy-port.ts` | 系统提示词 / 工具授权策略 |
| `observability-port.ts` | 观测订阅口（turn/usage/队列/错误，脱敏） |

## 五、关键入口

- 进程入口：`src/main.ts`（环境变量 → `startServer`）
- 组装根：`src/server/start.ts`（Pi SDK / SQLite / 网络准入 / 能力注册表 → `buildApp`）
- HTTP 路由与 SSE：`src/server/app.ts`
