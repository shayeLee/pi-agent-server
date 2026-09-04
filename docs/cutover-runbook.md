# WP2A 受控 cutover runbook（离线；实际 cutover 尚未执行；复审修复已落地；PG/age 验收受当前环境门控）

> **状态声明（不得曲解）**：本文描述 WP2A **实现**的受控 cutover 工具与流程。**真实 cutover（对任何真实用户 SQLite/PG/JSONL 的 reset）从未执行**，需要用户/运维后续明确目标授权。WP2（最终 reset 切换）整体**未完成**：本工作包（WP2A）只交付了工具、门禁与演练，不构成切换完成。本工具不是 production-ready 承诺。只有当前环境实际提供 PG URL 与 age 工具并运行对应 gate 时才有验收证据；没有这些前置条件不宣称通过。**实际 reset 尚未开始**。
>
> 关联：[operations.md](operations.md)（migration/prebackup runbook）、[backup-restore.md](backup-restore.md)、[phase-3-data-retention-plan.md](phase-3-data-retention-plan.md) §8.1（WP2/WP2A 状态）。

## 1. 工具与安全边界

- CLI：`pnpm cutover -- <args>`（源码）；发布产物 bin `pi-agent-server-cutover`（`dist-cutover/scripts/cutover.js`）。
- 顺序固定：安全 target 解析 → pre-reset 加密备份（`kind=pre-reset`）→ 备份 COMPLETE/manifest/payload 完整性验证 → **target binding 复验** → 受控 reset → Manifest-driven migration apply → 严格 verify head → 脱敏 machine report。备份包 manifest 绑定 canonical source roots 加 SQLite 完整 DB/WAL/SHM 指纹（每个文件的存在性/dev/ino/nlink/mode/size/mtime/sha256）或 PostgreSQL cluster/database/schema identity（优先 `pg_control_system().system_identifier` 以 text 读取，并核对 database/schema OID、server addr/port、`cluster_name`）；pre-reset 的 SQLite binding 在快照生成时点固定（`VACUUM INTO` 前指纹、快照后对已验证相同状态复验、随后在任何 JSONL/age 工作前作为**不可变基准**写入 manifest），后续发布/reset 只与该基准比较（禁止重新采集替换基准）；创建返回 published identity（manifest ciphertext SHA-256 + source roots/binding digest），`verifyPublishedBackup` 将已发布 manifest ciphertext/COMPLETE/payload 与创建 identity 重新比对（创建后被替换的 manifest ciphertext 或 COMPLETE 零 reset 失败，全程无需 private identity 解密）；reset 前重新解析/复验，任何目标变化（包括 WAL-only 提交）或 identity mismatch（含 cluster system identifier 不可用/为空——绝不回退同名哈希）都零 reset 失败。
- **授权链不可绕过**（三者缺一，零删除/零迁移；dry-run 同样要求完整确认，作为 apply 的命令行彩排）：
  - `--reset-rc-data`
  - `--confirm-reset DELETE_RC_DATA`（逐字匹配，大小写敏感；解析层即拒绝）
  - `--maintenance-window CONFIRMED`（只接受逐字 `CONFIRMED`：大小写变体、前后空白一律拒绝，绝不归一化。这是运维声明，不是进程锁——必须自行确认服务已停、无并发写者）
- 强制绝对路径：`AGENT_CWD`、`DATA_DIR`、`DB_PATH`、`--backup-root`、`--age-recipient-file`。CLI 拒绝从进程 cwd 推断目标。
- **`DATA_DIR` 必须显式设置**（缺失/空白即拒绝，绝不从 cwd 静默继承），且解析后的 dataDir 不得等于/包含/被包含于 `AGENT_CWD`（任一方向 overlap 都拒绝）。
- **resolver 纳入 `PI_AUTH_PATH` 与 `PI_AGENT_DIR`**：安全检查针对实际解析后的凭证位置与 agentDir（默认 `$HOME/.pi/agent/auth.json` 与 `dataDir/.pi-agent`），绝不只按 `auth.json` 文件名；整个 canonical `agentDir` 根（含 `PI_AGENT_DIR=DATA_DIR`、dataDir 祖先、symlink 别名）、解析后的凭证与 `agentDir/models.json` 同 reset 面任意方向（含 realpath 别名）overlap 都会在任何破坏性步骤之前拒绝，且 reset 前复验会重新执行同一检查。自定义凭证名/位置因此永远不会被备份、也永远不会被删除（备份白名单按同一解析路径执行同一规则）。
- dry-run（`--dry-run`）零写入：只做 target 解析/只读检查并打印计划。
- 失败语义：
  - 备份或其验证失败 → **绝不 reset**、绝不迁移、无成功输出；
  - reset 后 migration 失败 → **保留备份**，绝不自动 restore / 自动 down / 自动重试，无成功输出；
  - 成功输出 = 一行脱敏 JSON（无路径、无 URL、无凭证；legacy 库标注 `legacy:true` 且明确**不声称** legacy 数据经 migration verify——只承诺备份包完整性）。
- 本工具不接入 `startServer`，不启动服务，不安装 scheduler/timer。

## 2. SQLite 受控 reset 范围

仅允许解析后的文件 DB，且满足：

- 拒绝 `:memory:`、symlink、hardlink、相对路径；
- DB 必须位于解析后的 `DATA_DIR` 内；`--backup-root` 与 dataDir/agentDir/dbPath/sessions 根任一方向重叠都拒绝；
- 删除范围仅为：DB 文件及其 `-wal`/`-shm`，加 `DATA_DIR/sessions/` 与 `DATA_DIR/projects/` 两个会话 JSONL 根；
- **保留** agentDir（含白名单服务配置 `models.json`）与 dataDir 其他内容；**永不删除**任何凭证文件（备份白名单也永久排除 auth 文件）；**绝不删除**任意 cwd 目录内容；
- reset 后对空 DB 执行 Manifest-driven migration（重建 `schema_migrations` 基线）。

## 3. PostgreSQL 受控 reset 范围

- 仅接受显式 `--target-schema`，且必须与连接的 effective schema（`current_schema()`）完全一致，否则拒绝歧义 reset；备份验证后的 binding 复验会再次断言 effective schema 仍等于 `--target-schema`，且 cluster system identifier、database/schema OID、server addr/port、`cluster_name`、database/schema identity 哈希与 canonical source roots 全部一致——system identifier 不可查询或为空即安全 fail，任何不一致零 reset；
- schema allowlist：只接受 `pi_cutover_*` 前缀的专用 schema。`public`、`information_schema`、`pg_*`、`pi_restore_*`（restore 演练专用）一律拒绝；**不支持**对 public schema 的 reset（如需从 legacy public schema 切换，属于未实现场景，必须另行评估与授权）；**绝不 DROP DATABASE**；
- **JSONL 清理与 SQLite 同一边界**：备份验证 + binding 复验之后、schema DROP 之前，仅清理 `DATA_DIR` 下 `sessions/` 与 `projects/` 两个 JSONL 根；保留 agentDir（含 `models.json`）与 dataDir 其他内容，绝不触碰凭证；
- 动作仅为：JSONL 清理 → `DROP SCHEMA <schema> CASCADE` → `CREATE SCHEMA <schema>` → 对连接角色 `GRANT USAGE, CREATE`（最小必要授权），随后 migration apply；identity 复验与 DROP/CREATE/GRANT 在**同一个专用 PoolClient 的同一个事务**（`BEGIN ISOLATION LEVEL REPEATABLE READ` → 复验 → DDL → `COMMIT`）内完成，绝不经 Pool 轮换连接；复验失败即 ROLLBACK 并释放连接（复验在 DDL 事务前即拒绝，JSONL 清理尚未开始，**schema 与 JSONL 均零删除**）；**DDL/COMMIT 失败**即 ROLLBACK（schema 变更回滚），但 **JSONL 已在 DDL 事务前被清理且无法自动恢复**——必须保留 pre-reset 备份由运维人工恢复；**绝不自动 restore、自动 down、自动重试**；绝不 `DROP DATABASE`；
- 备份侧同一连接绑定：备份在单个专用 PoolClient 的只读 `REPEATABLE READ` 事务内完成 identity 复验、cluster identity 查询与 `pg_export_snapshot()` 导出，`pg_dump --snapshot=<id>` 在事务保持期间消费同一快照（导出不支持/失败即 fail-closed）；
- 测试与演练默认使用随机 `pi_cutover_<random>` schema，由 fixture 负责创建与销毁。

## 4. 操作步骤（示例，SQLite）

```bash
# 0. 停服：用部署方自己的 service manager 停止服务并确认无写者（CONFIRMED 不等于停服证明）。
# 1. 准备：绝对路径 + 独立 age recipient 文件（仅公钥，0600）。
export AGENT_CWD=/absolute/application/cwd
export DATA_DIR=/absolute/application/data
export DB_PATH=/absolute/application/data/pi-agent-server.db
export BACKUP_ROOT=/absolute/separate/backup-root
export AGE_RECIPIENT_FILE=/absolute/secure/age-recipient-file

# 2. 彩排（零写入；要求与 apply 完全一致的确认链）：
pnpm cutover -- --dry-run --reset-rc-data --confirm-reset DELETE_RC_DATA \
  --maintenance-window CONFIRMED \
  --backup-root "$BACKUP_ROOT" --age-recipient-file "$AGE_RECIPIENT_FILE"

# 3. 受控执行：
pnpm cutover -- --apply --reset-rc-data --confirm-reset DELETE_RC_DATA \
  --maintenance-window CONFIRMED \
  --backup-root "$BACKUP_ROOT" --age-recipient-file "$AGE_RECIPIENT_FILE"

# 4. 复核：只读校验迁移头（离线）。
pnpm migrate -- --verify
```

PostgreSQL：在环境上额外设置 `PI_STORAGE_DIALECT=postgres`、`PI_DATABASE_URL`（URL 的 `search_path` 必须指向目标 `pi_cutover_*` schema），并追加 `--target-schema <pi_cutover_*>`。CLI 只打印安全的 host/port/database 摘要与 schema，不打印连接串。

## 5. 服务启动门禁（WP2A 起可选）

- 默认（`migrationGate="off"`，或未设置 `PI_MIGRATION_GATE`）：启动行为与 RC 完全一致——不自动 apply migration、不自动 reset，不校验 ledger。
- 严格模式（`PI_MIGRATION_GATE=verify` 或 `StartConfig.migrationGate:"verify"`）：启动时只读校验 migration ledger/head；空库、legacy 无 ledger 库、落后/篡改库一律 fail-fast，错误信息明确提示运行离线 cutover（`pnpm cutover`）或 migrate（`pnpm migrate -- --apply`）。启动路径绝不迁移、绝不删除。
- **PG**：门禁使用独立的 gate Pool/Kysely，校验后（失败亦然）始终销毁；成功后另建全新的 actual Pool 供 bootstrap/app 使用（真实 PG 门禁测试断言 fail-fast 后 schema 内零表、无残余连接）。
- **SQLite 真只读**：DB 文件不存在直接 fail-fast 且绝不创建文件；已存在的库复制 DB/WAL/SHM 到私有临时副本后校验，门禁前后对源 DB/WAL/SHM 做完整 stat+sha256 指纹比对，任何变化都视为只读边界被破坏而失败。
- mock server / 本地开发不要求该模式；HTTP/端口行为不受影响。

## 6. 回滚（人工；本工具绝不自动 restore）

- 生产**没有自动 down/自动恢复**。migration 失败后 pre-reset 加密备份原地保留。
- 人工流程：确认故障 → 按 [backup-restore.md](backup-restore.md) 将 pre-reset 备份 restore 到**临时验证环境**（不指向生产）→ 通过恢复演练校验（COMPLETE/manifest/hash/ledger/JSONL）→ 由运维决策后受控恢复 → 重新校验 ledger/head → 恢复服务。
- 备份"有效"的唯一证明是恢复演练通过。

## 7. 验收与当前状态

- 门禁：`test:cutover`（真实 age SQLite 全链路演练）、`test:cutover-pg`（真实 PG 随机 schema 演练 + 真实 CLI E2E）、`build:cutover`（compiled + installed npm bin E2E/safe-failure smoke）均接入 `verify:release`；缺失前置（URL/工具）时 fail-closed，不允许 skip 假绿。当前环境未运行时不得把历史记录当作本次验收。
- **实际 cutover 未执行**：截至本文更新，WP2A 只在临时目录/随机 schema 内做过演练；没有对任何真实用户 SQLite/PG/JSONL 执行过 reset/删除。执行真实切换需要：本 runbook 步骤 + 用户/运维对目标的明确授权 + 维护窗口。
- WP2 整体未完成：切换后基线备份、"冻结 destructive reset" 承诺与切换记录尚未发生（见 phase-3 计划 §2.1/§8.1）。
