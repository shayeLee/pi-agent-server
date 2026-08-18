# 测试覆盖缺口与质量待办

> 来源：一次 server 层测试用例 review（`tests/server/*.test.ts`、`tests/runtime/session-runtime.test.ts`、`tests/application/session-service.test.ts`、`tests/model-adapters/pi-model-runtime-catalog.test.ts`）。本文只记录**尚未补齐**的缺口与质量问题；本次 review 后已解决的项列在开头，便于追溯。

## 已解决（本次 review 后补齐）

- 鉴权代理边界：trustProxy 白名单下非可信对端伪造 `X-Forwarded-For` → 401；伪造 XFF + token → account 身份（`tests/server/real-auth.test.ts`）。
- 模型失败 HTTP 映射：POST catalog 抛错 503 且不创建会话；PATCH 无效模型 400 / catalog 抛错 503 且不调 `setModel`、不持久化（`tests/server/app.test.ts`）。
- `isAvailable` 测试证明走 `getAvailable`（含认证）而非 `getModel`（仅注册）：用「已注册 ≠ 可用」两个集合 + 断言 `getModelCalls === 0`（`tests/model-adapters/pi-model-runtime-catalog.test.ts`）。

---

## 待补：高优先级缺口

### 1. 优雅关闭全链路（零覆盖）

`src/server/app.ts` 的 `preClose`/`onClose` 与 `src/runtime/session-runtime.ts` 的 `ABORT_TIMEOUT_MS` 均无对应测试。

- preClose 是否先关闭全部 SSE；关闭期间新 SSE 是否 503。
- 在途任务能否在 grace period（30s）内自然完成。
- 超时后是否调用 `abortAll()`；`adapter.abort()` 永不返回时 5s 超时是否释放槽位并结束关闭。
- 多个在途任务是否并行 abort（而非串行累积超时）；queued 任务关闭时是否取消。

**所需基建**：可控 SSE socket、deferred prompt、fake timers。

### 2. SSE 配额、断线清理与关闭竞态

`src/server/app.ts` 的 `sseConnections`/`cleanup()`/`safeClose()`。

- 每用户/全局上限、两身份间配额隔离。
- 客户端断线后配额归还、能否立即重连。
- 背压关闭后配额与订阅是否清理。
- `onClose`/`writeHead`/`flushHeaders`/`write`/`end` 抛错路径；socket factory 抛错不占配额。
- `safeClose()` 与客户端 close、事件总线 `closeAll()` 同时发生是否只清理/关闭一次。
- 已知窗口：`socket.onClose(cleanup)` 注册时 `unsubscribe` 仍是空函数，若连接已关闭或 close 丢失，随后仍可能 `events.subscribe()` 留下无效订阅。

**所需基建**：fake socket 支持同步 close、重复 close、各方法抛错，断言连接数/写次数/end 次数/重连结果。

### 3. SSE 断线续传「不重不漏」未真正验证

现有 `tests/server/sse.test.ts` 只对一批已存在事件做一次连接 + `toContain` 片段；未执行「连接→读 cursor→断开→断线期间产生事件→带 cursor 重连→解析帧断言 id 严格连续、无重复、无遗漏、顺序正确」；「服务重启」用例也未重建 app（只在同一 server 传不匹配 epoch）。

**所需基建**：SSE 帧解析器 + 双 app/epoch 共享可恢复会话存储。

### 4. abort 超时与关键状态竞态

`tests/runtime/session-runtime.test.ts` / `tests/server/messages.test.ts` 已有 idle/queued/streaming/abort 抛错，缺：

- `adapter.abort()` 永不 resolve → 5s 后 poisoned、槽位释放。
- prompt 与 abort 同时自然完成；两个并发 abort。
- navigateTree 期间 abort（不再调 prompt）。
- terminal/usage 读取期间 abort 与新 submit；abort 后迟到 SDK 事件不得进入下一任务。
- HTTP 层 timeout 后 409 poisoned 映射。

**所需基建**：fake timers + 可独立释放 `navigateTree`/`prompt`/`abort` 的 adapter。

### 5. 幂等完整矩阵

现仅覆盖 completed；缺 error/aborted 的同 requestId 重放与跨 runtime 持久化重放、同 requestId 不同 payload 并发（首个获胜且不混用）、429 后重试、queued abort/queue timeout 后重试、幂等仓库 `get`/`put` 失败、持久化未完成时重建 runtime 的竞态。

### 6. 配置切换失败原子性

`configureSession` 顺序为 `setModel → setThinkingLevel → repository update`，缺：

- `setModel` 抛错时数据库不更新。
- `setThinkingLevel` 抛错时（模型已切、库未更新）的契约/补偿策略。
- repository update 抛错/返回 false。
- 配置期间会话被删除；streaming 状态下配置是否允许（当前允许，未锁定契约）。
- 空对象 PATCH 的语义。

---

## 待补：中优先级

- **stopReason 矩阵**：`toolUse`、未知 stopReason、多个 assistant 选最后有效、多个 `agent_end`（含 `willRetry:true` 后成功/失败）、`error` 无 `errorMessage` 的 fallback、`agent_end` 后 abort 竞态。当前实现把除 error/aborted/length 外的所有原因结算为 completed，`toolUse`/未知值尤其值得测（建议 fail-closed 或锁定允许列表）。
- **工具错误预算断言过宽**：现有用例只断言含 error、不含 aborted；未断言前 8 次不 abort 第 9 次才 abort、`abort()` 精确一次、9 个 tool_end 先于终态、无 completed、下一 turn 计数清零、预算 abort 自身抛错后的 poisoned。
- **会话 CRUD/导出基础设施失败**：systemPrompt resolver 抛错、rename/delete 的 repository/runtime/文件删除失败、export adapter 抛错、导出期间删会话、导出「先读 cursor 再导出」的并发不重不漏、项目删除与创建会话并发的 tombstone。
- **trustProxy 策略矩阵边界**：空串、尾随/连续逗号、数组中的空串/number/boolean/null、数组元素含逗号（应整体拒绝）、`linklocal`/`uniquelocal` 别名、数字 0/负数/NaN、`startServer()` 是否在副作用前调用校验。
- **越权「无副作用」断言只查数据库**：未断言 `createAdapter` 未被调用、runtime 未创建、adapter 的 `setModel`/`followUp`/`abort`/`exportSession` 未执行、SSE 配额/订阅未增加。
- **Bearer 与身份切换 HTTP 边界**：真实 auth 接入 `buildApp` 后的 Bearer 大小写/tab/多空格、内网带无效 token 仍保 IP 身份、内网 IP 身份与公网 account 身份的所有权隔离、trustProxy 多跳链的身份切换。

---

## 待补：低优先级

- SSE cursor 输入边界：负数/NaN/Infinity/空 `Last-Event-ID`、cursor 已最新、cursor 大于最新、`X-Server-Epoch` 响应头、SSE 协议头（Content-Type/Cache-Control/Connection）、heartbeat 及 heartbeat 写失败背压。
- HTTP DTO 完整性：`piSessionFile` 不得泄露、默认 project/model/thinking/systemPrompt/capability 字段、thinkingLevels 精确枚举与顺序、catalog 不多返回不可用模型。

---

## 测试质量问题（改进建议）

1. **固定 `setTimeout(0)`/`flush()` 时序脆弱**：一个 event-loop tick 不保证 settle/usage/幂等落账/队列 promotion/abort release 完成。建议改为 adapter 暴露 `promptStarted`/`promptFinished` deferred、以 SSE completed/error 为完成信号、持久化 repo 暴露 `putCalled` promise、超时逻辑用 fake timers。
2. **SSE `toContain` 漏检**：不校验顺序、重复、丢帧、ID 跳号、completed 后继续输出、多余 error。建议解析完整 SSE 帧后用 `toEqual` 比较 `{id,event}` 数组。
3. **背压集成用例接近走过场**：`getWriteCalls()` 返回但未使用，只断言 `ended===true`。建议精确断言第 N 次连续失败关闭、写次数、end 次数、关闭后不再写、关闭后可重连。
4. **`toMatchObject`/`toContainEqual` 掩盖判别联合与多余字段**：判别联合建议按 `kind` 后用完整 `toEqual`。
5. **`MockAgentAdapter` 过强且时序失真**：同步 flush 全部事件并立即 resolve，与真实 SDK 的跨 tick、auto-retry、abort 竞态、迟到事件、usage/export 异步失败、toolUse continuation 不符。建议加协议级 adapter，逐事件推进并分别控制 prompt/abort/usage/navigateTree 完成。
6. **部分用例名称宣称的副作用未实际断言**：如「排队超时释放幂等」未再次提交同 requestId、「先切换 runtime 再持久化」无全局顺序断言、「事件游标递增」仅断言非零。

---

## 断言可能错误/误导的用例

1. 「epoch 不匹配（服务重启）」未真正模拟重启（同一 app 传旧 epoch，只验证 cursor 归零）。
2. 「无 agent_end 仍 completed」锁定 fail-open 语义，若 SDK 契约要求终态 `agent_end`，缺失时应报错而非 completed；建议先明确协议。
3. 「PATCH config 部分更新」用 SQLite 验证，无法证明 service 未发送 null/多余字段；建议在 service 层精确捕获传给 `sessions.update()` 的 patch。

---

## 补测试优先级建议

1. 优雅关闭全链路
2. SSE 资源安全（配额/断线清理/关闭竞态）
3. 真实断线续传（帧解析 + 双 app epoch）
4. 鉴权代理边界（已补）与多跳链
5. 模型失败映射（已补）与 catalog 缺失 fail-closed 的 HTTP 层验证
6. abort 状态矩阵
7. 幂等完整矩阵
8. 配置切换失败原子性
9. stopReason / 工具预算精确断言
10. 用 deferred 信号、fake timers、精确事件/DTO 比较替换固定 flush 与宽泛断言

---

# 附：代码 review 剩余项（P2/P3 待办，待设计决策）

四轮代码 review 的 P0/P1 已全部闭环；以下 P2/P3 因改动较大或需设计决策，暂未实现，记录待办（原记录于已删除的 `automation-test-issues.md`，此处重建）。

## 1. 系统提示词/能力快照未用于 runtime 恢复（P2）

`record.systemPrompt` 与 `capabilityVersions` 已持久化，但 `createAdapter()` 创建真实 `AgentSession` 时仍用全局 `resourceLoader`，未读取会话冻结的快照。重启并修改提示词/能力配置后，旧会话可能漂移，违反「配置变更不影响既有会话」承诺。

**涉及**：`src/application/session-service.ts`、`src/server/start.ts`。**待定**：需调查 Pi SDK 的 per-session systemPrompt 应用方式。

## 2. 全局 registry 回调表（P3）

`RESUME_REGISTRY` / `EXPIRY_REGISTRY` 是模块级全局 Map；同进程多 registry/app 使用相同 `sessionId:requestId` 时会互相覆盖回调。

**涉及**：`src/runtime/session-runtime.ts`。**待定**：下沉到 `RuntimeRegistry` 或 `ConcurrencyController` 实例。

## 3. SQLite 生命周期与并发权衡（P3）

- `DatabaseSync` 未在 `app.close()` 时 `close()`，进程内反复启停会泄漏文件描述符、延迟 WAL 释放。
- 同步 API 会阻塞事件循环（大事务/慢磁盘时整个进程排队）。
- ~~未设 `busy_timeout`~~ ✅ 已补：`new DatabaseSync(..., { timeout: 5000 })`（写锁等待，多连接/多进程冲突时不再立即 `SQLITE_BUSY`）。
- `ensureDefaultProject` 的「读既有行 + INSERT OR IGNORE」是两条独立语句，多连接/多进程下可被并发插入破坏「异常 owner 显式失败」的保证（单进程部署不适用）。
- 测试 mock `MemoryProjects` 未完整模拟 FK CASCADE（只删传入的 sessionIds）；服务路径传完整列表，现有测试不受影响，但非完整等价实现。

**涉及**：`src/server/start.ts`、`src/storage/sqlite-*.ts`、`tests/application/session-service.test.ts`。**待定**：registry/runtime 停止后显式 `close()`；多实例部署前把默认项目不变量纳入事务。
