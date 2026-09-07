# 运维任务索引

本文提供首次数据库初始化、离线工具和运行时探针的入口。migration 启动规则以本文和 [ADR 0002](decisions/0002-canonical-baseline-and-migration-gate.md) 为准；备份、恢复及其长期运维边界见 [backup-restore.md](backup-restore.md)。

以下部署示例使用发布包提供的命令。`pi-agent-server` 会在前台启动正式服务；进程守护和重启由 systemd、容器或其他部署系统负责。

## 首次部署：初始化数据库

### SQLite

先准备工作目录和数据目录，再建立并校验数据库：

```bash
export AGENT_CWD=/absolute/path/to/workspace
export DATA_DIR=/absolute/path/to/data
export DB_PATH="$DATA_DIR/pi-agent-server.db"
mkdir -p "$AGENT_CWD" "$DATA_DIR"

pi-agent-server-migrate --bootstrap-baseline --bootstrap-confirm CONFIRMED
pi-agent-server-migrate --verify
```

校验成功后，在同一组环境变量下配置访问范围并启动：

```bash
export PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8
pi-agent-server
```

### PostgreSQL

先创建一个空数据库和空的业务 schema，并确保连接后的 `current_schema()` 是该业务 schema，而不是 `public` 或系统 schema。然后执行：

```bash
export AGENT_CWD=/absolute/path/to/workspace
export DATA_DIR=/absolute/path/to/data
export PI_STORAGE_DIALECT=postgres
export PI_DATABASE_URL='postgresql://user:password@host:5432/database'
mkdir -p "$AGENT_CWD" "$DATA_DIR"

pi-agent-server-migrate --bootstrap-baseline --bootstrap-confirm CONFIRMED
pi-agent-server-migrate --verify

export PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8
pi-agent-server
```

本地 PostgreSQL 环境示例见 [postgres-podman-test.md](postgres-podman-test.md)。后续 schema 升级不要再次运行 `pi-agent-server-migrate --bootstrap-baseline --bootstrap-confirm CONFIRMED`；应按 [backup-restore.md §5.2](backup-restore.md#52-已有唯一-canonical-baseline-的-apply) 执行 pre-backup、`--apply` 和 `--verify`。

## 部署边界

- 每个 logical SQLite DB / PostgreSQL schema 及其 `DATA_DIR` 只支持一个 pi-agent-server 实例；不支持共享同一存储的多副本或重叠滚动升级，架构约束见 [architecture.md](architecture.md)。
- 备份根路径、age 密钥、异地边界、RPO/RTO、保留期和恢复演练要求以 [backup-restore.md](backup-restore.md) 为准。
- DELETE 会在数据库事务中写入 `file_operations` outbox；当前没有 worker、unlink 或 quarantine，物理 JSONL 不会被删除。

### Podman 正式部署计划（部署前执行）

当前仓库尚未提供主服务 Containerfile；`docker/scheduler/Containerfile` 只用于备份调度/演练。正式部署前完成以下事项：

1. 新增主服务 Containerfile，固定受支持的 Node.js 版本，以非 root 用户运行 `pi-agent-server`；
2. 镜像包含经过验证的服务与 migration/backup/restore 编译产物，数据库初始化和升级仍作为显式 one-shot 命令执行；
3. 数据目录和服务专用 `auth.json` 从宿主机挂载，不写入镜像；OpenAI Codex 等 OAuth 凭证先在宿主机通过独立 `PI_CODING_AGENT_DIR` 执行 Pi `/login` 生成，再以可读写方式挂载并通过容器内 `PI_AUTH_PATH` 使用，同时验证容器用户权限、token 刷新回写和停服后重新登录流程；
4. 通过环境变量或容器 secret 注入配置与凭证，镜像层、构建日志和运行日志不包含 secret；
5. 接入 `/health`、`/readyz`、停止信号和有界优雅关闭，并验证容器重启后的数据与凭证行为；
6. 增加镜像构建、启动、首次数据库初始化、升级和恢复 smoke test，形成可复制的 Podman run/部署示例。

验收产物包括主服务 Containerfile、部署说明、固定版本镜像构建命令和自动化 smoke test。该计划默认沿用当前单实例边界；多实例部署需等待对应架构改造。

## 任务入口

| 任务 | 命令 / 入口 | 权威文档 |
| --- | --- | --- |
| SQLite/PostgreSQL 备份 | `pnpm backup -- create` / `pi-agent-server-backup` | [backup-restore.md](backup-restore.md) |
| 隔离恢复 | `pnpm restore -- restore` / `pi-agent-server-restore` | [backup-restore.md](backup-restore.md) |
| 离线 migration bootstrap/apply/verify | `pnpm migrate -- ...` / `pi-agent-server-migrate` | [backup-restore.md](backup-restore.md) |
| legacy / 非 canonical 数据 | 不提供 reset、cutover 或 baseline adoption；无 ledger 或非唯一 canonical baseline 的库 fail-closed，只有重新准备完全空目标后才能用 `pnpm migrate -- --bootstrap-baseline --bootstrap-confirm CONFIRMED` 建立 baseline | [ADR 0002](decisions/0002-canonical-baseline-and-migration-gate.md) |
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

**当前 migration 实现：**

- 数据模式 `PI_DATA_MODE`（默认 `managed`）：`managed` = 正式受管数据，`rc` = 显式 disposable 的 RC 数据；未知非空值拒绝启动。
- `PI_MIGRATION_GATE`（默认 `verify`）为 verify-only：启动前只读检查 migration ledger/head（空库/无 ledger 库/非唯一 canonical baseline/落后库 fail-fast），**绝不自动 migration/reset**；显式 `off` 一律拒绝。
- `PI_DATA_MODE=managed` 与 `PI_DATA_MODE=rc` 均必须搭配 `PI_MIGRATION_GATE=verify`；`off` 在任何资源创建前 fail-closed。
- 完全空 SQLite DB 或完全空 non-public/non-system PostgreSQL schema 必须离线执行 `pnpm migrate -- --bootstrap-baseline --bootstrap-confirm CONFIRMED`；该命令不可混用 backup/maintenance 参数且不会创建 pre-backup。已有唯一 canonical baseline 的数据库才执行 `pnpm migrate -- --apply`，并经过已验证 pre-backup→apply→verify；其他状态均 fail-closed。

## 验证

日常验证使用 `pnpm verify`，发布验证使用 `pnpm verify:release`。真实 PostgreSQL/age 验收只有在当前环境提供相应 URL/二进制且对应 gate 实际运行时才成立；不以 skip 或历史测试数量代替证据。
