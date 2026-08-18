# 架构速览（核心数据流）

> 辅助阅读代码：核心数据流 + 关键代码位置 + 解耦边界。需求基线见 README，本文件只讲「代码怎么组织、请求怎么流转」。

## 一、核心数据流

### 一次 `POST /v1/sessions/:id/messages` 请求

```text
① 鉴权    Bearer Token                          src/server/real-auth.ts
② 身份    内网 IP / 公网账号 → UserIdentity      src/core/user-identity.ts（+ cidr.ts）
③ 归属    owner == 该用户？                     src/application/session-service.ts
④ 幂等    requestId 已处理过？                  src/core/idempotency.ts + storage/sqlite-idempotency-repository.ts
⑤ 状态机  idle？否则 409                        src/core/task-state-machine.ts
⑥ 并发    全局/每用户上限 → 放行/排队           src/core/concurrency-control.ts
⑦ 执行    Pi SDK session.prompt()               src/agent/pi-agent-adapter.ts
⑧ 翻译    SDK 事件 → SseEvent → SSE 字节        src/agent/translate.ts → runtime/session-event-bus.ts → server/sse-format.ts
⑨ 持久化  JSONL（Pi 写）+ 服务库 SQLite         src/storage/sqlite-session-repository.ts
```

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
  1. `src/server/start.ts` 初始化：`timeout: 5000` + `enableForeignKeyConstraints: true` + `ensureDefaultProject`（默认项目落库，`owner_key=''` 共享）
  2. `src/storage/sqlite-session-repository.ts`：WAL（`PRAGMA journal_mode=WAL`）+ 外键 `ON DELETE CASCADE` + 事务化重建迁移（`BEGIN IMMEDIATE`）
  3. `src/storage/sqlite-project-repository.ts`：删除项目 `BEGIN IMMEDIATE` 事务 + `ensureDefaultProject` 不变量（拒绝 create/delete 保留 id）
  - **本质**：`DatabaseSync` 同步 API + 单线程事件循环 → 进程内天然串行（一个 `db.run()` 返回前事件循环不切走）；并发风险只在多实例（WAL 单写者 + busy timeout 兑底）。

## 二、目录职责

| 目录 | 职责 | 关键文件 |
|---|---|---|
| `src/core/` | 纯逻辑，零 IO/外部依赖，可独立单测 | `task-state-machine.ts`、`concurrency-control.ts`、`idempotency.ts`、`user-identity.ts`、`cidr.ts` |
| `src/application/` | 应用层：不依赖 Fastify/SQLite/Pi SDK | `session-service.ts`、`ports/`（端口契约）、`capabilities/`（能力组合） |
| `src/runtime/` | 会话任务编排（状态机+并发+幂等+执行+事件） | `session-runtime.ts`、`runtime-registry.ts`、`session-event-bus.ts` |
| `src/server/` | HTTP 层 + composition root | `app.ts`、`start.ts`、`auth.ts`/`real-auth.ts`、`sse-format.ts`、`sse-backpressure.ts`、`sse-socket.ts`、`trust-proxy-policy.ts` |
| `src/agent/` | Agent 适配边界 | `agent-adapter.ts`（接口）、`pi-agent-adapter.ts`（Pi 实现）、`mock-agent-adapter.ts`（测试）、`events.ts`、`translate.ts` |
| `src/storage/` | SQLite 适配器（实现 ports） | `sqlite-session-repository.ts`、`sqlite-project-repository.ts`、`sqlite-idempotency-repository.ts` |
| `src/model-adapters/` | Pi ModelRuntime → ports 适配 | `pi-model-runtime-catalog.ts`、`pi-model-runtime-credentials.ts` |
| `src/provider-adapters/` | 厂商协议适配（与核心数据流解耦） | `registry.ts`、`types.ts`、`openai-tool-policy.ts`、`deepseek-v4/` |

## 三、解耦边界

1. **依赖方向单向**：`core/`、`application/`、`runtime/` 不依赖 Fastify、SQLite、Pi SDK、厂商类型；外部实现（`server/`、`storage/`、`agent/pi-agent-adapter.ts`）通过 [`src/application/ports/`](src/application/ports/) 的接口被核心调用（依赖倒置）。
2. **纯逻辑优先**：①鉴权外的 ④⑤⑥ 是纯逻辑，集中在 `src/core/`，零外部依赖。
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
- 组装根：`src/server/start.ts`（Pi SDK / SQLite / 鉴权 / 能力注册表 → `buildApp`）
- HTTP 路由与 SSE：`src/server/app.ts`
