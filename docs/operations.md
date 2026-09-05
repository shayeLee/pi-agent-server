# 运维任务索引

本文只提供离线工具和运行时探针的入口。工作包状态统一见 [Phase 3 状态台账](phase-3-data-retention-plan.md)，具体安全契约见各专项文档。

## 部署边界

- 每个 logical SQLite DB / PostgreSQL schema 及其 `DATA_DIR` 只支持一个 pi-agent-server 实例；不支持共享同一存储的多副本或重叠滚动升级。
- 备份写入本机 `BACKUP_ROOT`。当前不做异地或独立故障域副本，因此不覆盖主机/磁盘与备份目录同时丢失。
- age identity（解密私钥）由运维托管，只在恢复时通过受控路径提供；仓库、服务和备份包均不保存私钥。
- RPO 目标为 24 小时；RTO 目标为 4 小时，但 signoff 延期到投入使用且具备代表性数据规模后。
- DELETE 会在数据库事务中写入 `file_operations` outbox；当前没有 worker、unlink 或 quarantine，物理 JSONL 不会被删除。
- WP5B 尚未实现。正式启用 `bash`/`edit`/`write`、多实例或公网部署前必须先完成该条件门禁。

## 任务入口

| 任务 | 命令 / 入口 | 权威文档 |
| --- | --- | --- |
| SQLite/PostgreSQL 备份 | `pnpm backup -- create` / `pi-agent-server-backup` | [backup-restore.md](backup-restore.md) |
| 隔离恢复 | `pnpm restore -- restore` / `pi-agent-server-restore` | [backup-restore.md](backup-restore.md) |
| 离线 migration apply/verify | `pnpm migrate -- ...` / `pi-agent-server-migrate` | [backup-restore.md](backup-restore.md) |
| legacy disposable RC cutover | `pnpm cutover -- ...` | [cutover-runbook.md](cutover-runbook.md) |
| IP→IP owner transfer | `pnpm owner-transfer -- ...` | [owner-transfer.md](owner-transfer.md) |
| outbox 只读统计 | `pnpm file-ops -- run` | [file-operations.md](file-operations.md) |
| DB 引用只读分析 | `pnpm reconcile-jsonl -- run` | [reconcile-jsonl.md](reconcile-jsonl.md) |
| `/health`、`/readyz`、`/metrics` | 运行中服务 | [ip-rbac-design.md](ip-rbac-design.md) |
| 备份 freshness 部署/演练 | 部署方审核的 helper/timer | [backup-freshness-exporter.md](backup-freshness-exporter.md) / [SOP](backup-freshness-drill-sop.md) |

`pnpm` 命令只用于人工开发和演练。自动备份必须调用固定编译产物，不能以 `pnpm backup` 作为调度入口。

## 通用安全规则

1. migration、cutover、owner transfer 都是离线操作；先由 service manager 停止服务并独立确认无 writer。
2. `--maintenance-window CONFIRMED` 只是操作员声明，不是进程锁。
3. destructive/apply 操作必须先完成加密备份和包验证；失败时不自动 down、restore 或 retry。
4. restore 只能指向隔离的新目标，禁止覆盖源数据库、正式 schema 或正式 `DATA_DIR`。
5. 路径必须是明确的绝对路径；backup root 不得与源数据、staging 或凭证路径重叠。
6. PostgreSQL 必须显式设置 `PI_STORAGE_DIALECT=postgres` 与 `PI_DATABASE_URL`；server、`pg_dump`、`pg_restore` major 必须匹配。
7. secret 不得进入 argv、manifest、日志或证据包；`age-recipient-file` 只包含公钥 recipient。

## Migration 启动门禁

**当前代码**：`PI_MIGRATION_GATE=verify` 为 opt-in，默认 `off`；`verify` 只读检查 ledger/head，不执行 migration。

**已决策目标，尚未实现**：`PI_MIGRATION_GATE` 默认 `verify`；增加独立 `managed`/`rc` 数据模式，`managed` 必须搭配 `verify`，只有显式 disposable `rc` 才允许 `off`。所有模式都只校验，不自动 migration/reset。首次建立或升级 schema 仍使用离线 migration CLI。

## 验证

日常验证使用 `pnpm verify`，发布验证使用 `pnpm verify:release`。真实 PostgreSQL/age 验收只有在当前环境提供相应 URL/二进制且对应 gate 实际运行时才成立；不以 skip 或历史测试数量代替证据。
