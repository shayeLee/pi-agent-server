# IP→IP Owner Transfer 设计（WP5D-4）

> **状态：✅ 已验收** —— 离线 CLI `owner-transfer` 已实现。用户提供的完整真实 PG16+age
> `pnpm verify:release` 成功证据中，真实 PostgreSQL owner-transfer gate、真实 age gate，以及
> compiled + installed-npm PostgreSQL E2E smoke 均通过。本文不记录测试数量。本工具从未对任何
> 真实用户 SQLite/PG/JSONL 执行过转移；对真实目标执行需运维/用户明确授权。
>
> 关联文档：[ip-rbac-design.md](ip-rbac-design.md) §7、[identity-access-plan.md](identity-access-plan.md)、
> [backup-restore.md](backup-restore.md)、[database-design.md](database-design.md)、[needs.md](../needs.md) §4.2/§7。

## 1. 动机、范围与非目标

RC 阶段「一个 IP = 一个用户」：`owner_key`（`ip:<canonical IP>`）是资源隔离键。当网段内
IP 身份变更（例如机器换 IP、运维把手动分配的地址换给人）时，需要把某个 IP 身份名下资源的
归属整体转到另一个 IP 身份。WP5D-4 交付一个**离线、显式、fail-closed** 的 DB 层 owner
转移工具。

**范围（冻结，不得偏离）**：

- **只做 DB 层 IP→IP 转移**：仅更新 `projects.owner_key` 与 `sessions.owner_key` 两列；
  不迁移 `PI_IP_ACCESS_POLICY_FILE` 的 IP 条目、token 绑定与角色——接收方继承自己的 IP 画像，
  与原 owner 画像无关（[ip-rbac-design.md](ip-rbac-design.md) §7 冻结语义）。
- **不合并**：target owner 名下必须完全为空（无 projects 且无 sessions）；source owner
  必须持有至少 1 个资源。
- **默认项目行**（`DEFAULT_PROJECT_ID`，`owner_key=''`，共享）必须存在且 owner 保持空串；
  其下 source session 的 `owner_key` 正常转移。
- **错位引用即失败并整体回滚**：source session 引用非 source 自定义项目、或他人 session
  引用 source 自定义项目 → 整个事务 ROLLBACK，零生效。
- **维护窗口是声明，不是进程锁**：`--maintenance-window CONFIRMED` 只是运维授权声明；
  DB 侧串行化由 SQLite `BEGIN IMMEDIATE` 与 PG 的 session-level advisory lock 承担
  （`POSTGRES_MIGRATION_LOCK_KEY`：事务外参数化 `SELECT pg_advisory_lock($1)` 取得，与
  迁移引擎同 key 的 xact lock 冲突；COMMIT/ROLLBACK 后显式 `pg_advisory_unlock($1)`
  验证返回 true 才把 client 归还池），绝不基于该声明获取任何分布式锁。

**明确不做**：策略文件 / token / 角色迁移、账号维度（legacy 账号/token）迁移、admin 跨
owner 只读、HTTP 接口、自动 restore、任何 schema 变更（无 migration）。

## 2. 冻结决策

1. **身份 = canonical IP**（与 WP5D-2 同源）：`--source-ip`/`--target-ip` 必须是严格
   canonical IP 文本（`parseIpStrict` 的 canonical-or-mapped 之外一律拒绝；mapped 形式
   拒绝，绝不隐式归一）；`owner_key := identityKey(ip) = "ip:<canonical>"`。
2. **确认与维护窗口缺一不可**：`--confirm-transfer TRANSFER_IP_OWNERSHIP` 逐字匹配 +
   `--maintenance-window CONFIRMED` 逐字匹配；dry-run 与 apply 要求同一套完整确认。
   dry-run 是 apply 的命令行彩排，零写入，**不创建备份**（SQLite 用只读快照副本 + 字节指纹
   断言；PG 用独立 READ ONLY 只读事务）。
3. **参数 failclosed**：未知/重复/变体参数一律拒绝且不回显值（命令行可能含 token/密钥）。
4. **apply 顺序固定**：strict pre-owner-transfer 加密备份 → `verifyPublishedBackup`
   （COMPLETE/manifest/payload）→ target binding 复验 → 事务内 transfer/verify。任何失败
   = 零写入/回滚，**无自动 restore**；pre-transfer 备份保留作为人工恢复锚点。
5. **SQLite**：显式 `AGENT_CWD`/`DATA_DIR`/`DB_PATH`（三者都必填绝对路径，绝不静默派生）；
   **DB_PATH 解析后必须位于 DATA_DIR 内**（与受控 cutover 同一安全基线，canonical 双端比较）；
   事务用 `BEGIN IMMEDIATE`；事务内 pre/post 计数双向校验；dry-run 断言目标 DB/WAL/SHM
   字节零变。
6. **PostgreSQL**：显式 `PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL` + `--target-schema`；
   **允许 public 业务 schema**，拒绝 `information_schema`/`pg_*`/`pi_restore_*`/`pi_cutover_*`；
   effective schema（`current_schema()`）必须与 `--target-schema` **exact** 一致。
   **同一专用 leased client：先在**事务外**以参数化 `SELECT pg_advisory_lock($1)`
   （$1 = `POSTGRES_MIGRATION_LOCK_KEY`）取得 session-level advisory lock**（与迁移引擎
   事务内同 key 的 xact lock 冲突 → 串行化），取得后才 `BEGIN ISOLATION LEVEL REPEATABLE
   READ`；binding 复验 → plan/update/post-verify → COMMIT 全链同此快照（绝无复验与写入
   之间的 rollback/重连窗口）；COMMIT/ROLLBACK 后显式 `pg_advisory_unlock($1)` 并验证
   返回 true，**之后才** release 归还池；解锁未确认/失败则 `release(error)` 销毁连接，
   绝不把可能持锁的连接交回池；跳过 binding 复验直接 apply 一律拒绝（零 connect/零写入）；
   dry-run 走独立 READ ONLY 事务、可无 backup，零写入。
7. **backup kind `pre-owner-transfer`**：
   - SQLite：与 `pre-reset` 同级——快照生成时点绑定完整 DB/WAL/SHM 树指纹（`sourceTreeBinding`），
     VACUUM INTO 前后断言稳定，之后作为不可变基线只做比对；
   - PG：沿用既有 cluster/database/schema identity binding（`postgres` 元数据）；
     `createPostgresBackup` 以 `backupKind: "pre-owner-transfer"` + `allowPublicSchema: true`
     发布（public 允许，但系统/演练 schema 仍由本工具的 `validateOwnerTransferSchema` 拒绝；
     **`allowPublicSchema=true` 仅对 `pre-owner-transfer` 该 kind 生效，任何其他 kind 直接拒绝**）；
   - **owner-transfer 的备份恒为 strict**：CLI 在 SQLite/PG 两条路径都硬编码
     `requireCompleteSessionReferences: true`——任一缺失的 session reference 都在
     publish/COMPLETE 之前 fail-closed（desensitized 计数错误），绝不接受不完整备份作为
     转移的恢复锚点。
   restore（SQLite 与 PG）接受该 kind 并按其完整快照/转储正常演练——它只是一个带
   更强 binding 的完整备份，恢复语义不变。
8. **报告只含 subject sha256 / counts / backup 元信息**：绝不输出原始 IP/owner/path/url；
   subject 哈希与 admission 后置日志同一派生（`sha256(identityKey).slice(0,16)`）。

## 3. CLI 契约

```
pnpm owner-transfer -- --dry-run|--apply \
  --source-ip CANONICAL_SOURCE_IP \
  --target-ip CANONICAL_TARGET_IP \
  --confirm-transfer TRANSFER_IP_OWNERSHIP \
  --maintenance-window CONFIRMED \
  --backup-root ABSOLUTE_DIR \
  --age-recipient-file ABSOLUTE_FILE \
  [--target-schema SCHEMA（仅 PostgreSQL）]
```

编译/安装产物：`pnpm owner-transfer:compiled` / bin `pi-agent-server-owner-transfer`。
环境变量（与其它离线 CLI 一致）：`AGENT_CWD`/`DATA_DIR`/`DB_PATH`（SQLite，必填绝对）、
`PI_AGENT_DIR`、`PI_AUTH_PATH`（凭证排除白名单用）、`PI_STORAGE_DIALECT`/`PI_DATABASE_URL`
（PG，显式）、`PI_BACKUP_STAGING_ROOT`（可选的私有明文 staging 根）。

校验规则（全部 fail-closed）：

| 输入 | 规则 |
| --- | --- |
| mode | 恰好一个 `--apply` 或 `--dry-run` |
| `--source-ip` / `--target-ip` | 严格 canonical IP；互不相同 |
| `--confirm-transfer` | 必须逐字等于 `TRANSFER_IP_OWNERSHIP`（大小写/空白不容忍） |
| `--maintenance-window` | 必须逐字等于 `CONFIRMED` |
| `--backup-root` / `--age-recipient-file` | 绝对路径 |
| `DB_PATH`（SQLite） | 绝对路径且解析后必须位于 `DATA_DIR` 内 |
| `--target-schema` | 仅 PG：允许 `public`/普通标识符；拒绝 `information_schema`/`pg_*`/`pi_restore_*`/`pi_cutover_*` |
| 未知/重复/变体 | 一律拒绝，值不回显 |

## 4. apply 流程（固定顺序）

```text
1. pre-owner-transfer 加密备份        （source 完整快照；SQLite 树 binding / PG identity binding）
2. verifyPublishedBackup             （COMPLETE marker + manifest ciphertext + payload 逐项 hash）
3. target binding 复验                （重新解析 target；source roots 比对；
                                       SQLite：DB/WAL/SHM 树指纹未变；PG：cluster/database/schema
                                       identity 一致——PG 在本步开启专用 client 的 REPEATABLE READ
                                       事务并保持打开，供下一步复用）
4. 事务内 transfer/verify             （SQLite：BEGIN IMMEDIATE；PG：与第 3 步**同一个事务**内完成
                                       plan/update/post-verify + COMMIT（session advisory lock 已先于
                                       BEGIN 取得并于 COMMIT/ROLLBACK 后显式解锁验证），同一 leased client
                                       同一快照，复验与写入之间无 rollback/重连窗口；pre/post counts；post 校验）
```

编排核心 `runOwnerTransfer`（`src/owner-transfer/owner-transfer-core.ts`）任一步失败即抛错，
CLI 非零退出、不输出成功；备份保留、绝不自动 restore。

## 5. 转移语义（纯函数 `planOwnerTransfer` / `verifyOwnerTransferOutcome`）

- `planOwnerTransfer`（事务前，SQLite 与 PG 共用同一语义）：
  1. 默认项目行存在且 `owner_key === ""`（否则拒绝）；
  2. target owner 名下 projects + sessions 计数均为 0（不合并）；
  3. source owner 名下 projects + sessions 计数 ≥ 1；
  4. source session 只能引用默认项目或 source 自定义项目（引用他人自定义项目 → 拒绝）；
  5. 他人 session 不得引用 source 自定义项目（默认项目共享，不受此限）；
  6. 返回 pre-counts（`projectsTransferred` / `sessionsTransferred`）。
- 事务内执行 `UPDATE projects SET owner_key = target WHERE owner_key = source` 与
  `UPDATE sessions SET owner_key = target WHERE owner_key = source`，随后
  `verifyOwnerTransferOutcome`（事务后）：source 归零、target 恰好持有 plan 数量、
  默认项目 owner 仍为空串；不一致 → ROLLBACK。
- 只触碰两列；`id`/`project_id`/`pi_session_file`/`title` 等全部不动；JSONL 文件、
  models.json、凭证文件零触碰。

## 6. PG 专用：同连接门禁

`openPostgresOwnerTransferGate(pool, database, schema, sourceOwnerKey, targetOwnerKey)`
返回 `{ revalidate, transfer, cleanup }`。该门禁是**不可重入的一次性 phase 状态机**
（`idle → revalidating → revalidated → transacting → done`，任一步失败 → `failed`；
dry-run 走独立 one-shot 路径），全部 fail-closed、绝不覆盖 in-flight client：

- **锁模型（reviewer P1 修复）**：`revalidate(verification)` 租用专用 client 后，先
  **在事务外**以参数化 `SELECT pg_advisory_lock($1)`（$1 = `POSTGRES_MIGRATION_LOCK_KEY`）
  取得 **session-level** advisory lock（与迁移引擎在事务内持有的同 key xact lock 冲突，
  因此与并发 migration/transfer 串行化），取得后才 `BEGIN ISOLATION LEVEL REPEATABLE
  READ`，在本事务内查询 system_identifier/OID/addr/port/cluster_name 并与已发布备份的
  `postgres` binding 逐项比对（缺失任一系统标识即 fail-closed，绝不回退同名哈希）；
  成功后**保持事务打开**，紧接的 `transfer("apply")` 在**同一事务同一连接**内完成
  `current_database()`/`current_schema()` 复验（exact）→ 双表 schema 确认 → plan →
  UPDATE 两列 → post 校验 → COMMIT。复验与写入之间**不存在 ROLLBACK/重连窗口**；
  事务快照自复验起不变。复验失败即本事务 ROLLBACK，且后续 apply 不再重建事务
  （fail-closed）。跳过复验直接 `transfer("apply")` 一律拒绝（零 connect、零写入）。
- **解锁契约（reviewer P1 修复）**：事务 COMMIT/ROLLBACK **之后**显式
  `SELECT pg_advisory_unlock($1)` 并验证返回 true，**之后才** release 归还池；
  解锁未确认 true / 解锁查询失败 / 事务结束失败 → `release(error)` 销毁连接
  （可能仍持锁，绝不回池；错误/cleanup 路径同此规则）。
- **一次性状态机（reviewer P1 修复）**：revalidate 只允许在 idle 执行一次（并发/重复
  一律拒绝，零加连）；`transfer("apply")` 只允许在 revalidated 执行一次（跳过复验/
  复验失败/进行中/完成后复用全部拒绝）；`transfer("dry-run")` 是独立 one-shot 路径
  （READ ONLY 事务，可无 backup/binding，只计划不写入，以 ROLLBACK + 解锁验证结束），
  也只允许执行一次；`cleanup()` 在 idle/done/failed 幂等 no-op、在 revalidated
  （复验后未 apply）执行 ROLLBACK + 解锁验证 + 归还并进入终态，但在 revalidate/transfer
  **进行中调用一律拒绝**（不打断、不破坏 in-flight client 的租约）。
- PG SELECT 列别名一律**显式双引号**（`owner_key AS "ownerKey"` / `project_id AS "projectId"`）；
  project 行 owner 允许空串（共享默认项目行），session 行 owner 必须非空；schema 检查必须
  `count(DISTINCT table_name) = 2` 确认 `projects`+`sessions` 两张表都存在（不允许只存在其一）。

## 7. 安全边界与审计

- 不接入 `startServer`、不启动服务、不安装 scheduler/timer。
- 权限模型：任何写入前必须 `authorizeOwnerTransfer`（确认词 + 维护窗口）。
- 路径安全与 backup/cutover 同一 no-symlink-ancestor + canonical 语义；SQLite 目标 DB 必须位于
  解析后的 `DATA_DIR` 内；backup 校验 backup-root 与 source 面 overlap、凭证排除、recipient 文件安全。
- **统一 CLI 错误边界**：CLI 只输出稳定错误码类别（`code=usage` 退出码 2 / `code=connection` /
  `code=internal` 退出码 1）+ 脱敏文本——绝不透传底层连接/query 原文，输出不得包含任何
  IPv4/IPv6/hostname/path/url/凭证；参数用法文本可保留但不含任何输入值；未知/底层错误一律
  替换为稳定文案（`sanitizeOwnerTransferDiagnostic` + `renderOwnerTransferCliError`）。
- 报告字段白名单：`status/mode/dialect/sourceSubjectHash/targetSubjectHash/transfer.*/backup.*/notes`。

## 8. 测试与门禁

- 单元：`tests/owner-transfer/owner-transfer-args.test.ts`（参数 failclosed）、
  `tests/owner-transfer/owner-transfer-core.test.ts`（转移语义/回滚/只改 owner_key/dry-run 只读）、
  `tests/owner-transfer/owner-transfer-pg-gate.test.ts`（mock client 回归：session advisory lock
  先于 BEGIN 的参数化取得、同 client 同快照至 COMMIT 后显式 unlock 验证 true 才 release、
  unlock 未确认/失败销毁连接、dry-run 独立 one-shot READ ONLY、跳过复验 apply fail-closed、
  并发/重复 revalidate、完成后复用、apply 过程中 cleanup 均 fail-closed（一次性状态机）、
  双引号别名与 count-distinct=2 schema 检查）、
  `tests/owner-transfer/owner-transfer-cli-error-boundary.test.ts`（统一错误边界：稳定类别；
  ECONNREFUSED IPv4/IPv6 环回与 DNS NXDOMAIN hostname 进程级断言不泄露 IP/URL/路径）。
- 真实 SQLite age 门禁：`pnpm test:owner-transfer`（先跑 `pnpm test:age`；环境变量
  `PI_RUN_REAL_AGE_OWNER_TRANSFER=1`）——临时 fixture 全链路 apply（strict 备份通过），
  并断言 **missing JSONL 时无 COMPLETE 且 owner 零变**（strict completeness 计数错误，
  备份 root 不产出包）。
- 真实 PG+age 门禁：`pnpm test:owner-transfer-pg`（`scripts/test-owner-transfer-pg.ts`，
  强制 runner，缺 URL/二进制 fail-closed）——随机隔离业务 schema（真实 app schema +
  migration ledger），全链路 apply / dry-run 零写 / target 非空回滚（复验后同事务）/ 缺引用
  JSONL 零发布零写，绝不碰 public 与其它 schema。
- 构建 smoke：`pnpm build:owner-transfer` → `scripts/smoke-owner-transfer-compiled.mjs`（隔离
  SQLite fixture + 可选真实 PG 随机 schema；wrong-confirmation/dry-run/apply/occupied-rollback/
  **missing-jsonl（无 COMPLETE、owner 零变、stderr 脱敏）**）
  与 `scripts/smoke-owner-transfer-package.mjs`（npm pack → install → bin E2E，含同样的
  missing-jsonl fail-closed 断言）。

## 9. 完成定义（✅ 已验收）

1. 单测/typecheck/全量 test/build 绿；
2. 真实 SQLite age 门禁与真实 PG+age 随机隔离 schema 门禁已在完整 `verify:release` 中实际
   执行并通过；
3. 双库（SQLite/PG）行为一致；
4. 文档（本文、backup-restore、ip-rbac-design、identity-access-plan、README 双语文档）同步。