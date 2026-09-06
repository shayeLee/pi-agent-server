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
| 离线 migration bootstrap/apply/verify | `pnpm migrate -- ...` / `pi-agent-server-migrate` | [backup-restore.md](backup-restore.md) |
| legacy disposable RC 数据 | 已移除受控 cutover 工具；无 ledger 或非唯一 canonical baseline 的库由 bootstrap/migration 引擎 fail-fast 拒绝，需手动重置数据库后用 `pnpm migrate -- --bootstrap-baseline --bootstrap-confirm CONFIRMED` 重建唯一 canonical baseline | — |
| IP→IP owner transfer | `pnpm owner-transfer -- ...` | [owner-transfer.md](owner-transfer.md) |
| outbox 只读统计 | `pnpm file-ops -- run` | [file-operations.md](file-operations.md) |
| DB 引用只读分析 | `pnpm reconcile-jsonl -- run` | [reconcile-jsonl.md](reconcile-jsonl.md) |
| `/health`、`/readyz`、`/metrics` | 运行中服务 | [ip-rbac-design.md](ip-rbac-design.md) |
| 备份 freshness 部署/演练 | 部署方审核的 helper/timer | [backup-freshness-exporter.md](backup-freshness-exporter.md) / [SOP](backup-freshness-drill-sop.md) |
| 备份 freshness 演练门禁/清理/run 资格 | `pnpm drill -- preflight` / `pnpm drill -- cleanup` / `pnpm drill -- run`（`pi-agent-server-drill`） | [SOP](backup-freshness-drill-sop.md) |

`pnpm` 命令只用于人工开发和演练。自动备份必须调用固定编译产物，不能以 `pnpm backup` 作为调度入口。`pi-agent-server-drill` 是隔离的一键演习执行器：`preflight` 只做安全门禁；`run` 自动执行合成 SQLite/PostgreSQL fixture、容器内真实 cron、编译产物 backup/restore/migrate、隔离恢复校验、临时 node_exporter/Prometheus/Alertmanager/测试 webhook 及完整故障矩阵，输出真实 `PASS`/`FAIL`/`DEFERRED`（仅在缺少 podman/age/pg 工具时 `DEFERRED`），绝不通过环境变量自证 `PASS`。本次运行专属 Podman 资源在结束后验证删除，脱敏 summary 保留。`cleanup` 先执行完整 preflight 且要求两个固定 secrets 均有效，只清空已知运行目录并固定保留 `$PI_DRILL_ROOT/secrets/`。

## 通用安全规则

1. migration、owner transfer 都是离线操作；先由 service manager 停止服务并独立确认无 writer。
2. `--maintenance-window CONFIRMED` 只是操作员声明，不是进程锁。
3. destructive/apply 操作必须先完成加密备份和包验证；失败时不自动 down、restore 或 retry。
4. restore 只能指向隔离的新目标，禁止覆盖源数据库、正式 schema 或正式 `DATA_DIR`。
5. 路径必须是明确的绝对路径；backup root 不得与源数据、staging 或凭证路径重叠。
6. PostgreSQL 必须显式设置 `PI_STORAGE_DIALECT=postgres` 与 `PI_DATABASE_URL`；server、`pg_dump`、`pg_restore` major 必须匹配。
7. secret 不得进入 argv、manifest、日志或证据包；`age-recipient-file` 只包含公钥 recipient。

## Migration 启动门禁

**当前实现（Phase 3 第 1 项）**：

- 数据模式 `PI_DATA_MODE`（默认 `managed`）：`managed` = 正式受管数据，`rc` = 显式 disposable 的 RC 数据；未知非空值拒绝启动。
- `PI_MIGRATION_GATE`（默认 `verify`）为 verify-only：启动前只读检查 migration ledger/head（空库/无 ledger 库/非唯一 canonical baseline/落后库 fail-fast），**绝不自动 migration/reset**；显式 `off` 一律拒绝。
- `PI_DATA_MODE=managed` 与 `PI_DATA_MODE=rc` 均必须搭配 `PI_MIGRATION_GATE=verify`；`off` 已删除并在任何资源创建前 fail-fast。
- 完全空 SQLite DB 或完全空 non-public/non-system PostgreSQL schema 必须离线执行 `pnpm migrate -- --bootstrap-baseline --bootstrap-confirm CONFIRMED`；该命令不可混用 backup/maintenance 参数且不会创建 pre-backup。已有唯一 canonical baseline 的数据库才执行 `pnpm migrate -- --apply`，并经过已验证 pre-backup→apply→verify。

## 验证

日常验证使用 `pnpm verify`，发布验证使用 `pnpm verify:release`。真实 PostgreSQL/age 验收只有在当前环境提供相应 URL/二进制且对应 gate 实际运行时才成立；不以 skip 或历史测试数量代替证据。
