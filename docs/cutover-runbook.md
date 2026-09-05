# WP2A 受控 cutover runbook（仅 legacy disposable RC；当前无目标；实际 cutover 未执行）

> 本工具只用于一次性清理 legacy disposable RC 数据。当前没有需要 cutover 的目标，真实 cutover 从未执行；任何实际运行都必须重新取得目标级明确授权。当前状态统一见 [Phase 3 状态台账](phase-3-data-retention-plan.md)。
>
> 关联：[operations.md](operations.md)（任务索引）、[backup-restore.md](backup-restore.md)（备份/恢复权威 runbook）。

## 1. 工具与安全边界

- CLI：`pnpm cutover -- <args>`（源码）；发布产物 bin `pi-agent-server-cutover`（`dist-cutover/scripts/cutover.js`）。
- 顺序固定：安全 target 解析 → pre-reset 加密备份（`kind=pre-reset`）→ 备份完整性验证 → **target binding 复验** → 受控 reset → Manifest-driven migration apply → 严格 verify head → 脱敏 machine report。备份包 manifest 绑定 canonical source roots 加 SQLite 完整 DB/WAL/SHM 指纹，或 PostgreSQL cluster/database/schema identity（优先 `pg_control_system().system_identifier`，不可用/为空绝不回退同名哈希）；pre-reset 的 SQLite binding 在快照生成时点固定，后续发布/reset 只与该基准比较；`verifyPublishedBackup` 将已发布 manifest ciphertext/COMPLETE/payload 与创建 identity 重新比对（创建后被替换即零 reset 失败，无需私钥解密）。
- **授权链不可绕过**（三者缺一，零删除/零迁移；dry-run 同样要求完整确认，作为 apply 的命令行彩排）：
  - `--reset-rc-data`
  - `--confirm-reset DELETE_RC_DATA`（逐字匹配，大小写敏感；解析层即拒绝）
  - `--maintenance-window CONFIRMED`（只接受逐字 `CONFIRMED`，绝不归一化；这是运维声明，不是进程锁——必须自行确认服务已停、无并发写者）
- 强制绝对路径：`AGENT_CWD`、`DATA_DIR`、`DB_PATH`、`--backup-root`、`--age-recipient-file`；CLI 拒绝从进程 cwd 推断目标。**`DATA_DIR` 必须显式设置**（缺失/空白即拒绝），且解析后的 dataDir 不得与 `AGENT_CWD` 任一方向 overlap。resolver 纳入 `PI_AUTH_PATH`/`PI_AGENT_DIR`：整个 canonical agentDir 根（含 symlink 别名）、解析后的凭证与 `models.json` 与 reset 面任一方向 overlap 都会在任何破坏性步骤前拒绝，且 reset 前复验重新执行同一检查。
- `--dry-run` 零写入：只做 target 解析/只读检查并打印计划。
- 失败语义：备份或其验证失败 → **绝不 reset、绝不迁移、无成功输出**；reset 后 migration 失败 → **保留备份，绝不自动 restore / down / 重试，无成功输出**；成功输出 = 一行脱敏 JSON（无路径/URL/凭证；legacy 库标注 `legacy:true` 且明确**不声称** legacy 数据经 migration verify——只承诺备份包完整性）。
- 本工具不接入 `startServer`，不启动服务，不安装 scheduler/timer。

## 2. Reset 范围（安全边界）

**SQLite**：仅允许解析后的文件 DB（拒绝 `:memory:`、symlink、hardlink、相对路径）；DB 必须位于解析后的 `DATA_DIR` 内；`--backup-root` 与 dataDir/agentDir/dbPath/sessions 根任一方向 overlap 都拒绝。删除范围仅为：DB 文件及其 `-wal`/`-shm`，加 `DATA_DIR/sessions/` 与 `DATA_DIR/projects/` 两个会话 JSONL 根。**保留** agentDir（含白名单服务配置 `models.json`）与 dataDir 其他内容；**永不删除**任何凭证文件（备份白名单也永久排除 auth 文件）；**绝不删除**任意 cwd 目录内容。reset 后对空 DB 执行 Manifest-driven migration（重建 `schema_migrations` 基线）。

**PostgreSQL**：仅接受显式 `--target-schema`，且必须与连接的 effective schema（`current_schema()`）完全一致，否则拒绝歧义 reset；备份验证后的 binding 复验再次断言 effective schema 与 cluster/database/schema identity 全部一致——system identifier 不可查询或为空即安全 fail。schema allowlist 只接受 `pi_cutover_*` 前缀的专用 schema；`public`、`information_schema`、`pg_*`、`pi_restore_*` 一律拒绝；**不支持** public schema 的 reset（如需从 legacy public schema 切换，属未实现场景，必须另行评估与授权）；**绝不 DROP DATABASE**。动作仅为：JSONL 清理（与 SQLite 同一边界）→ `DROP SCHEMA <schema> CASCADE` → `CREATE SCHEMA <schema>` → `GRANT USAGE, CREATE`（最小必要授权）→ migration apply。identity 复验与 DROP/CREATE/GRANT 在**同一个专用 PoolClient 的同一事务**（`BEGIN ISOLATION LEVEL REPEATABLE READ` → 复验 → DDL → `COMMIT`）内完成；复验失败即 ROLLBACK（JSONL 清理尚未开始，schema 与 JSONL 均零删除）；**DDL/COMMIT 失败**即 ROLLBACK（schema 回滚），但 **JSONL 已在 DDL 事务前清理且无法自动恢复**——必须保留 pre-reset 备份由运维人工恢复；绝不自动 restore/down/重试。

## 3. 操作步骤（示例，SQLite）

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

PostgreSQL：额外设置 `PI_STORAGE_DIALECT=postgres`、`PI_DATABASE_URL`（`search_path` 必须指向目标 `pi_cutover_*` schema），并追加 `--target-schema <pi_cutover_*>`。CLI 只打印安全的 host/port/database 摘要与 schema，不打印连接串。

## 4. 服务启动门禁

- 默认（`migrationGate="off"`，或未设置 `PI_MIGRATION_GATE`）：启动行为与 RC 完全一致——不自动 apply migration、不自动 reset、不校验 ledger。
- 严格模式（`PI_MIGRATION_GATE=verify`）：启动时只读校验 migration ledger/head；空库、legacy 无 ledger 库、落后/篡改库一律 fail-fast，错误提示运行离线 cutover（`pnpm cutover`）或 migrate（`pnpm migrate -- --apply`）。启动路径绝不迁移、绝不删除。PG 用独立 gate Pool 校验（校验后销毁），SQLite 真只读（复制 DB/WAL/SHM 到私有临时副本后校验，门禁前后指纹比对，任何变化视为只读边界被破坏）。
- **TARGET（最新决策，未实现）**：`PI_MIGRATION_GATE` 默认 `verify`；另增独立 `managed`/`rc` 数据模式，`managed` 必须使用 `verify`，只有显式 disposable `rc` 才允许 `off`。任何模式都不自动迁移。**CURRENT**：`verify` 仍为 opt-in、默认 `off`。不得把 TARGET 当作已实现。

## 5. 回滚（人工；本工具绝不自动 restore）

- 生产**没有自动 down/自动恢复**。migration 失败后 pre-reset 加密备份原地保留。
- 人工流程：确认故障 → 按 [backup-restore.md](backup-restore.md) 将 pre-reset 备份 restore 到**临时验证环境**（不指向生产）→ 校验 COMPLETE/manifest/hash/ledger 与可恢复业务状态 → 由运维决策后受控恢复 → 重新校验 ledger/head → 恢复服务。
- 备份"有效"的唯一证明是恢复演练通过。age identity（解密私钥）由运维托管，恢复时单独注入。

## 6. 验证入口

- `pnpm test:cutover`：SQLite + real age 隔离演练；
- `pnpm test:cutover-pg`：随机 PostgreSQL schema 隔离演练；
- `pnpm build:cutover`：compiled 与安装包 smoke；
- `pnpm verify:release` 汇总发布门禁。具体用例以测试源码和 `package.json` 为准。

这些门禁不授权真实 cutover。当前无目标；未来执行仍需本 runbook、目标级明确授权和维护窗口。
