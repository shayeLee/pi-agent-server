# 备份与恢复 Runbook

本文是 SQLite/PostgreSQL 备份、恢复和 migration pre-backup 的权威操作文档。工作包状态见 [Phase 3 状态台账](phase-3-data-retention-plan.md)，备份新鲜度部署见 [backup-freshness-exporter.md](backup-freshness-exporter.md)。

## 1. 固定边界

- 备份写入本机绝对路径 `BACKUP_ROOT`；不做异地/独立故障域副本，因此不覆盖主机、磁盘与备份目录同时丢失。
- 使用 age recipient 公钥加密。age identity 私钥由运维托管，只在恢复时通过受控路径提供，不进入仓库、应用服务、备份包、argv 或日志。
- 凭证和 auth 文件不进入备份；PostgreSQL 凭证使用私有临时 `PGPASSFILE`。
- 仓库不安装 scheduler、retention worker，也不自动回滚 migration。
- 每个 logical DB/schema + `DATA_DIR` 只允许一个服务实例；migration 和 restore 前必须停服务并确认无 writer。

## 2. 当前行为与已决策目标

以下目标**尚未实现**，操作员必须以“当前行为”理解现有 CLI。

| 场景 | 当前代码 | 已决策目标 |
| --- | --- | --- |
| DB 引用的 JSONL 缺失 | 普通备份记录到 manifest 后发布；`--require-complete-session-references` 与 owner-transfer strict 路径会失败 | 一律按 `missing-as-empty` 记录并允许发布 |
| backup 读取已有 JSONL | 稳定复制时逐行 `JSON.parse`，非法内容导致失败 | 仅作 opaque bytes 稳定复制，不检查内容合法性 |
| restore 遇到 manifest 中的 missing | 保留一个指向不存在目标的路径 | 对应 `sessions.pi_session_file` 写为 `NULL` |
| restore 遇到内容无效 JSONL | 整体恢复失败 | 丢弃该历史、对应引用写为 `NULL`，报告 `invalidSessionHistories` 数量 |
| 包/密文/hash 损坏 | 整体失败 | 仍整体失败；不得降级为空历史 |

目标落地时将退役或重定义 `--require-complete-session-references`，并同步更新机器报告与 WP5C 契约。在此之前，不得按目标语义部署自动备份。

## 3. 备份包契约

- **SQLite**：以 `VACUUM INTO` 生成数据库一致性快照，再稳定复制白名单内 JSONL 和服务 `agentDir/models.json`。
- **PostgreSQL**：在一个专用只读 `REPEATABLE READ` 连接上完成身份校验与 `pg_export_snapshot()`，`pg_dump --format=custom --no-owner --no-privileges --schema=<schema> --snapshot=<id>` 消费同一快照。
- manifest 与每个 payload 均由 age 加密；记录 plaintext/ciphertext hash 与 size。
- `COMPLETE` 最后写入并绑定 encrypted manifest hash；只有同文件系统原子 rename 完成后的目录才算发布。
- plaintext staging 必须是私有 0700 目录，不能位于 backup root 或其父目录；失败路径清理 staging。backup root 内 staging 只含密文。
- restore 验证 `COMPLETE`、manifest、payload hash、migration ledger、schema 以及 package allowlist。任何密文、hash、manifest 或解密错误都 fail-closed。
- v1 包恢复时校验 `file_operations` 行，但绝不执行其中的删除任务。

## 4. 人工备份

```bash
AGENT_CWD=/absolute/application/cwd \
DATA_DIR=/absolute/application/data \
DB_PATH=/absolute/application/data/pi-agent-server.db \
PI_STORAGE_DIALECT=sqlite \
pnpm backup -- create \
  --backup-root /absolute/backup-root \
  --age-recipient-file /absolute/secure/age-recipients
```

PostgreSQL 改为显式设置：

```bash
PI_STORAGE_DIALECT=postgres
PI_DATABASE_URL=postgresql://...
```

要求：

- `AGENT_CWD`、`DATA_DIR`、`DB_PATH`、backup root、recipient file 均使用绝对路径；
- recipient file 只包含公钥 recipient，0600 或更严格，非 symlink regular file；
- `age`/`age-keygen` 版本固定；PostgreSQL server、`pg_dump`、`pg_restore` major 完全一致；
- `--dry-run` 不发布任何包；
- 当前 `--require-complete-session-references` 的行为见 §2，它不是目标自动化契约。

`pnpm backup` 只用于人工开发/演练。自动备份由部署方审核的 helper/timer 调用固定编译产物。

## 5. Migration 前置备份

正式 migration 顺序固定：

1. 在窗口前用最近可用备份完成隔离恢复演练；
2. 停服务并独立确认无 writer；
3. `pnpm migrate -- --dry-run` 审核目标与计划；
4. 无停顿执行 `--apply`，由 CLI 创建并验证 pre-migration 加密备份后才迁移；
5. 执行 `pnpm migrate -- --verify`；
6. 仅在 verify 成功后启动服务并检查 `/readyz`。

```bash
pnpm migrate -- --apply \
  --backup-root "$BACKUP_ROOT" \
  --age-recipient-file "$AGE_RECIPIENT_FILE" \
  --maintenance-window CONFIRMED
pnpm migrate -- --verify
```

`CONFIRMED` 不是进程锁。CLI 不自动 startServer、down、restore 或 retry。迁移失败时保留 pre-migration 包，由运维评估恢复。

## 6. 隔离恢复

```bash
pnpm restore -- restore \
  --input-backup /absolute/backup-root/backup-<id> \
  --target-root /absolute/isolated/restore-target \
  --age-identity-file /absolute/ops-managed/age-identity
```

- 先在明确隔离的新目标上执行，禁止覆盖源数据库、正式 schema 或正式 `DATA_DIR`。
- SQLite restore 写入新的绝对 target root；PostgreSQL restore 需要明确的 disposable empty database/schema，拒绝 `public` 和系统 schema。
- restore 不自动迁移；恢复旧版本包后，需对隔离目标另行执行 migration apply/verify。
- age identity 由运维在执行时提供。一次成功解密和恢复演练是“私钥可用”的必要证据。
- 目标 missing/invalid-as-empty 语义落地前，当前恢复行为仍以 §2 为准。

## 7. 失败处理

- 备份、age、manifest、hash、target、schema 或版本校验失败：不执行后续 migration，不更新 freshness。
- migration 失败：保留已发布 pre-migration 包，不自动 down 或恢复。
- restore 失败：不发布部分 target；保存脱敏错误和证据，由运维处理。
- 日志和证据不得包含数据库 URL、密码、token、age identity、原始 argv、会话路径或正文。

## 8. RPO、RTO、保留期

- **RPO 目标：24 小时**。部署计划以固定不超过 12 小时的完整备份节奏留出执行和告警预算。
- **RTO 目标：4 小时；signoff 延期**。项目投入使用且有代表性数据规模后，再授权隔离环境完成 `restore → migration verify → start → health/readyz → 合成业务检查 → serviceable` 全流程计时；此前只记录功能性恢复证据，不宣称 RTO 已验收。
- **备份保留：30 天**。自动删除未实现；由运维人工审核并清理过期备份。
- **恢复演练：每季度及重大 migration 前**。当前 RTO signoff 延期不取消功能性恢复演练要求。
