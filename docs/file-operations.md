# WP4B 离线 file_operations planner：设计与运维 runbook

> **状态：WP4B（方案 A）✅ 已验收，范围仅限安全只读 planner。** 当前交付物只列出/统计持久 `file_operations` outbox 的操作与安全错误/状态计数，**不执行任何文件操作**。`--apply` 立即 fail-closed，无任何确认词可绕过。物理 executor（包括 unlink）、retry/quarantine 仍未实现，真正执行留给未来受审计的 native helper（单独、尚未启动的事项）。**WP4C（方案 A 收敛 DB-only reconcile analyzer）✅ 已验收**（见 [reconcile-jsonl.md](reconcile-jsonl.md)），WP5/WP6 也未开始；该离线工具不启动正式服务或 worker，整体尚非生产就绪。**验收证据**：用户提供的真实 PG16+age `verify:release` 成功证据包含 file-ops planner gate 及 compiled/npm smoke；本文不记录或推导测试数量。发布产物卫生（build 先清理输出 + 禁止残留 executor/file-system-policy/error-codes 文件与符号链接检查）、last_error 固定 allowlist 错误策略（仓库/planner/restore 三处一致）、未知 CLI 参数不回显原始 argv 等约束均纳入已验收范围。

## 1. 职责与边界

`file_operations` outbox（WP4A，已验收）持久化待执行的 JSONL 删除操作。WP4B（方案 A）提供：

- **只读 planner** `src/file-operations/planner.ts`：唯一数据来源是 `store.list()`（WP4A 仓库契约、纯 SELECT）；对 `pending`、lease 已过期的 `processing`（崩溃残留）、`available_at` 已到的 `failed` 记录分别计数，并按状态与脱敏 error code 统计；
- **显式 CLI** `scripts/file-ops.ts`（bin `pi-agent-server-file-ops`）：只支持默认 / `--dry-run` 只读计划；SQLite 以 `readOnly` 打开（缺失 DB 绝不创建 DB/WAL/SHM），PostgreSQL 连接串**严格校验**（协议/host/database 显式、禁止 fragment）且 `options` **只允许 `search_path`**（严格解析，其余一律拒绝），并合并 `default_transaction_read_only=on` 与有界 lock_timeout；CLI 主入口识别零 fs（纯 path/fileURL 判断）；
- **fail-closed `--apply`**：物理执行器未实施，`--apply` 立即以退出码 2 拒绝，零 claim/lease/complete/fail/文件操作；不存在任何确认词/维护窗口词可以绕过。

绝不：claim/lease/complete/fail；扫描文件系统生成新操作（真实 filesystem reconcile 是未来 native helper 的职责；当前 WP4C 仅 DB-only 只读分析，零处置、不生成操作、不读取 JSONL）；自动启动 worker/timer；由 HTTP 请求驱动；把相对/绝对路径写进报告或错误输出。

**native helper 说明**：方案 A 之后的物理执行需要审计过的外部运维工具（人工逐条核对）或未来实现的 native helper（单独工作项，未开始），本 planner 不 pretend 能执行。

## 2. CLI 用法

```bash
# 只读计划（零写入；默认模式）
DB_PATH=/abs/data/pi-agent-server.db \
pnpm file-ops -- run

# 显式 --dry-run（与默认一致）
DB_PATH=/abs/data/pi-agent-server.db \
pnpm file-ops -- run --dry-run

# PostgreSQL（显式方言 + URL；DB_PATH 不需要）
PI_STORAGE_DIALECT=postgres \
PI_DATABASE_URL=postgresql://... \
pnpm file-ops -- run
```

- 参数规则：只接受 `run` 与可选 `--dry-run`（重复出现拒绝）；未知参数、`--apply`、旧执行器参数（`--confirm-maintenance` / `--maintenance-window` / `--limit` / `--max-attempts` / `--backoff-*` / `--lease-ms` / `--remove-empty-parents`）一律拒绝（退出码 2）；**未知参数不回显原始 argv**（未知值可能含路径/凭证），错误输出只含稳定类别；**`--apply` 专门给出“未实施”提示**；
- 连接规则：SQLite 需要显式绝对 `DB_PATH`，以 `readOnly: true` 打开——文件不存在时直接失败（**绝不创建 DB/WAL/SHM**），已存在的库保持字节指纹不变；PG 需要显式 `PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL`，连接串**严格校验**（协议必须是 `postgres://`/`postgresql://`、host 与 database 显式存在、禁止 fragment）；`options` 参数**严格解析，只允许 `search_path`**（至多一次，值为未引用标识符的逗号分隔列表），其余任何选项一律拒绝并 fail-closed——绝不透传、绝不降级为可写连接；CLI 自动合并 `-c default_transaction_read_only=on` 与 `-c lock_timeout=10000`，并以有界超时建池（connect 10s / query 15s / statement 15s，lock 10s）；
- 库头校验：CLI 先以只读 `verify` 模式校验 migration ledger 与 schema head；库不在 head 时拒绝；
- 报告（stdout JSON）只含计数与安全 error codes，**不含任何相对/绝对路径、URL、凭证或操作标识**；每次成功运行在 stderr 输出人类可读的“只读 planner、不执行”说明：

```json
{ "status": "planned", "dialect": "SQLite", "mode": "dry-run", "executable": false,
  "planned": 3, "pending": 2, "processingExpired": 0, "failedDue": 1,
  "stateCounts": { "pending": 2, "processing": 1, "completed": 4, "failed": 1 },
  "errorCodes": { "file operation failed": 1 }, "unsafeErrors": 0 }
```

字段语义：

| 字段 | 含义 |
| --- | --- |
| `executable` | 恒为 `false`：本工具永不执行（执行需受审计外部运维工具或未来 native helper） |
| `planned` | 未来执行器可处理候选 = `pending` + `processingExpired` + `failedDue` |
| `pending` | `state=pending` 的记录数 |
| `processingExpired` | `state=processing` 且 lease 已过期（崩溃残留，未来可重领）的记录数 |
| `failedDue` | `state=failed` 且 `available_at` 已到（未来可重试）的记录数 |
| `stateCounts` | 全量按状态计数（pending/processing/completed/failed） |
| `errorCodes` | `last_error` 安全计数；key 只来自固定、有限的 allowlist（`file operation failed` ＋ 路径/kind/state 防御码；未知/相对路径/`credential=` 等绝不成为 key） |
| `unsafeErrors` | `last_error` 不在固定 allowlist 内的行数（只计数、不泄漏值；fail-closed） |

**last_error 错误策略（仓库/planner/restore 一致）**：持久化只允许固定、有限的 canonical error code（[`FILE_OPERATION_ERROR_CODE_ALLOWLIST`](../src/storage/file-operation-policy.ts)）；任何未知自由文本、相对路径、`credential=` 赋值等一律映射到 `file operation failed` 或计入 `unsafeErrors`，绝不进入报告 JSON key；仓库读取（`toRecord`）与 restore validation 对不合规值 fail-closed。

错误输出只暴露稳定类别（`用法：…` 或 `file-ops error: FILE_OPS_FAILED`），绝不回显环境路径。

## 3. 为什么没有执行器（方案 A 决策）

- WP4B 物理执行器（claim → unlink/quarantine → complete/fail）与 quarantine 布局的纯 Node 实现已按要求**移除**（包括 `file-system-policy.ts`、执行器核心与相关测试）；仓库中不再存在任何路径式 physical executor 或可被内部调用的副作用 API；
- WP4A 的 outbox schema/repository/lease 契约**原样保留**（含 claim/fencing、脱敏 error、相对路径白名单），是未来执行器（受审计外部工具或 native helper）的基础；
- planner 只读、不生成操作，因此不会带来误删/越界风险；执行路径需要另行评审（native helper 为单独事项）。
- **WP4C（方案 A 收敛）DB-only reconcile analyzer 已验收**：只读 DB 引用 + 纯字符串规范布局绑定，固定 issue codes + opaque 引用，`executable:false`，零处置、绝不扫描文件系统/不读取 JSONL，不能探测 orphan/lost/JSONL 损坏；用户提供的完整真实 PG16+age `verify:release` 成功证据包含真实 PG reconcile gate 及 compiled/npm smoke，本文不记录或推导测试数量；详见 [reconcile-jsonl.md](reconcile-jsonl.md)。

## 4. 门禁与测试

- `pnpm test`（无 PG URL）：planner 单元/CLI 集成用例全跑——dry-run 零写、缺失 DB 零创建（无 DB/WAL/SHM）、已有 DB 字节指纹不变、`--apply` 零写零调用 fail-closed、未知参数退出码 2 且不回显原值、无路径泄漏；`tests/postgres/file-operation-planner.test.ts` 按既有门控 skip；
- `pnpm test:file-ops-pg`：**强制真实 PG planner 门禁**（无 `PI_TEST_PG_URL` 非零失败），在随机专属 schema 上跑只读计划用例：零写、无路径泄漏；门禁环境 URL 先经严格校验；只读连接由生产代码（`enforceReadOnlyPostgresUrl`）构造——严格解析仅 `search_path` options 并合并 `default_transaction_read_only=on` 与 `lock_timeout`（`SHOW` 断言：schema 可见 + 服务端只读 + 有界 lock）且写操作被服务端拒绝；**门禁实际运行 source CLI PG 分支**（`scripts/file-ops.ts` 经 tsx），**随机 schema 通过 URL 的 `search_path` options 绑定——绝不创建任何 LOGIN role / 不使用 CREATEROLE**，验证随机 schema 隔离、只读、零 DB 变化、stdout/stderr 无 URL/path/credential 泄漏、finally 语义可靠 DROP SCHEMA；该门禁已包含在用户提供的成功 `verify:release` 证据中。
- `pnpm build:file-ops`：**先清空 `dist-file-ops` 再编译**（残留的旧 executor/file-system-policy/error-codes 编译产物不可能进入发布产物），compiled-CLI smoke 与 npm install bin smoke 均执行禁止文件/符号链接卫生检查（dry-run 零写与指纹、missing DB 零创建、`--apply` exit 2、未知参数 exit 2、报告无绝对路径、包内无残留产物）；build / build:backup 同样先清理输出目录，backup 的 compiled/npm smoke 也带卫生检查；
- `pnpm verify`（日常）、`pnpm verify:release`（发布）均接入 `build:file-ops`；发布链额外接入 `test:file-ops-pg`。用户提供的真实 PG16+age `verify:release` 成功证据包含 file-ops planner gate 及 compiled/npm smoke，因此 WP4B 方案 A 的安全只读 planner 已验收；本文不记录或推导测试数量。

## 5. 相关文档

- WP4C 方案 A 收敛（DB-only reconcile analyzer，✅ 已验收）：[reconcile-jsonl.md](reconcile-jsonl.md)
- [数据保留计划](phase-3-data-retention-plan.md)（WP4B 状态与工作包）
- [备份与恢复](backup-restore.md)（WP4A backup contract；无 quarantine 载荷）
- [运维 runbook](operations.md)（离线工具入口）
- 数据库设计 [database-design.md](database-design.md)（outbox 表与 claim 契约）