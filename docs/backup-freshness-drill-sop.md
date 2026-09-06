# 单实例备份新鲜度演练 SOP

> **状态**：演练 runner 已实现真实的一键执行（`pi-agent-server-drill run`）：容器内 cron、
> SQLite/PostgreSQL 合成数据、真实编译 backup/restore/migrate、隔离恢复校验、临时本地
> node_exporter/Prometheus/Alertmanager/测试 webhook，以及完整故障注入与恢复矩阵。判定只来自
> 本次运行采集的证据，绝不通过环境变量自证 `PASS`。

权威契约见 [backup-freshness-exporter.md](backup-freshness-exporter.md)，备份恢复流程见
[backup-restore.md](backup-restore.md)。

## 1. 目的与范围

在 disposable、target-like 环境证明：

```text
scheduler → fixed backup CLI → published report → textfile
→ node_exporter → Prometheus → Alertmanager notification/recovery
```

只使用合成 SQLite/PostgreSQL fixture、测试 age recipient/identity、隔离 backup root、textfile
目录与 receiver。不得使用正式数据库、JSONL、密钥、服务、备份目录或监控接收方。

missing-as-empty 机器报告语义已随 backup/restore 目标语义落地（见
[backup-restore.md](backup-restore.md#2-已落地语义)）。

## 2. Preflight 与安全边界

`pi-agent-server-drill` 只操作 `PI_DRILL_ROOT` 内路径，以及名称以
`pi-agent-server-disaster-recovery-drill-` 前缀命名的 Podman container/network/volume/自建
image；绝不触碰正式 data/backup/staging/auth/PG/receiver。任一正式路径与演练根重叠即
fail-closed。

前置（`preflight`，全部通过才 PASS，否则 FAIL）：

1. 显式设置绝对 `PI_DRILL_ROOT`（任意绝对路径；需精确 0700、当前用户/root 属主、非 symlink、
   无 special bits；mac 示例可
   `~/Library/Application Support/pi-agent-server-disaster-recovery-drill`，但非固定默认值，
   **且该路径不能位于 sticky/shared 目录（如 `/tmp`）下**，否则备份 plaintext staging 守卫会
   fail-closed）；
2. 固定保留 `$PI_DRILL_ROOT/secrets/` 中的演习专用 age identity/recipient（精确 0600、非
   symlink/hardlink/special bits），runner 从该固定位置读取，无需每次重新提供；
3. 正式路径按服务默认解析 `AGENT_CWD`/`DATA_DIR`/`DB`/`PI_AGENT_DIR`/`PI_AUTH_PATH` 并检查根
   重叠；正式 backup root/recipient/identity 用显式
   `PI_FORMAL_BACKUP_ROOT`/`PI_FORMAL_BACKUP_RECIPIENT`/`PI_FORMAL_BACKUP_IDENTITY` 比较，
   缺失时不宣称已隔离，也绝不因缺失/不可访问而报错泄密；正式 `PI_DATABASE_URL` 对演练
   postgres target 做目标一致性判断；
4. 数据库/schema、recipient/identity、Prometheus、receiver 均为隔离测试资源，由 runner 自动
   证明，不依赖操作员人工判断；
5. `cleanup` 必须先通过完整 preflight（root + 固定 secrets + 正式路径重叠 + 资源隔离）且两个
   secrets 均有效存在，任一失败即拒绝删除；只清空 `fixtures`、`backups`、`restore`、`staging`、
   `textfile`、`textfile-pg`、`logs`、`faultbin`、`scheduler`、`monitor`、`evidence` 与 `runs/*`，固定保留
   `secrets/`，绝不删除根或 `secrets`。

### 最小操作命令

```bash
export PI_DRILL_ROOT="$HOME/Library/Application Support/pi-agent-server-disaster-recovery-drill"

# 只检查目录、固定演习 key 与正式路径隔离性；不执行备份。
pnpm drill -- preflight

# 执行完整一键演习；自动运行 cron、备份/恢复、监控与故障矩阵。
pnpm drill -- run

# 演习结束后清空已知运行产物，保留演练根与 secrets/。
pnpm drill -- cleanup
```

`run` 产出真实 `PASS`(0)/`FAIL`(2)/`DEFERRED`(3)；`DEFERRED` 仅在 podman/age/pg 工具等明确
先决条件缺失时出现（并把对应 observation 记为 DEFERRED），其余任何未通过步骤均为 `FAIL`。
`run` 从不通过环境变量自证 `PASS`（没有 `PI_DRILL_VERIFIED` 之类的 bypass）。

### 正式运维执行步骤

正式运维只需要在**演习主机**执行下面命令；不要把正式数据库 URL、正式数据复制到演习根，也不要把正式私钥复制到 `secrets/`。`PI_FORMAL_*` 只提供正式路径给 preflight 做“不能重叠”的自动检查，值是路径，不是密钥内容：

```bash
export PI_DRILL_ROOT="/absolute/path/to/pi-agent-server-disaster-recovery-drill"

# 正式 SQLite 环境路径；按实际部署填写
export AGENT_CWD="/absolute/path/to/formal/data"
export DATA_DIR="/absolute/path/to/formal/data"
export DB_PATH="/absolute/path/to/formal/data/pi-agent-server.db"
export PI_AGENT_DIR="/absolute/path/to/formal/data/.pi-agent"
export PI_AUTH_PATH="/absolute/path/to/formal/auth.json"
export PI_BACKUP_STAGING_ROOT="/absolute/path/to/formal/backup-staging"

# 正式备份路径；只用于隔离检查，不会被 runner 写入
export PI_FORMAL_BACKUP_ROOT="/absolute/path/to/formal/backups"
export PI_FORMAL_BACKUP_RECIPIENT="/absolute/path/to/formal/age-recipient.txt"
export PI_FORMAL_BACKUP_IDENTITY="/absolute/path/to/formal/age-identity.txt"

pi-agent-server-drill preflight
pi-agent-server-drill run
```

如果从仓库源码执行，把最后两行替换为：

```bash
volta run pnpm drill -- preflight
volta run pnpm drill -- run
```

`preflight` 失败就停止；`run` 返回 `0` 才是通过，返回 `2` 是失败，返回 `3` 是工具等先决条件不足。成功或失败后都不需要人工删除 Podman 资源：runner 会清理本次运行的 container/network/volume/自建 scheduler image；如需清空演习文件，执行 `cleanup`，它会保留演习根和 `$PI_DRILL_ROOT/secrets/`。

## 3. 成功路径（已实现）

1. `provision`：校验 podman/age/pg 工具链；创建本次运行唯一的隔离 network、scheduler、
   PostgreSQL 与监控资源；资源名均以前缀 `pi-agent-server-disaster-recovery-drill-` 开头；
2. `fixture-sqlite` / `fixture-postgres`：合成数据，各含一个有效 JSONL 的 session 与一个缺失
   引用 session；SQLite 建空库并 bootstrap 唯一 canonical baseline；PostgreSQL 使用 disposable
   PG16（非 `public`、非系统 schema）并 bootstrap 唯一 canonical baseline；
3. `backup-*-success`：请求由容器内真实 cron 领取并调用固定编译产物
   `pi-agent-server-backup`；验证 cron trigger/time 与唯一 published machine report；统一安全 helper
   校验 finalPath/COMPLETE/属主/权限并通过 O_EXCL 单飞锁、fsync、原子 rename、no-regress/clock
   门禁更新 textfile；
4. `restore-*-success`：调用真实编译产物 `pi-agent-server-restore` 到隔离目标；校验 canonical
   单基线 ledger、有效 JSONL 历史、missing→NULL、非 invalid 历史；
5. `monitor-normal`：启动临时隔离 node_exporter + Prometheus + Alertmanager + 测试 webhook，
   验证 freshness、expected inventory、target up 与无遗留告警。

## 4. 失败注入矩阵（已实现）

| 注入 | 必须结果 |
| --- | --- |
| age recipient、数据库快照或 PG 工具失败 | CLI 非零，无新 COMPLETE/成功报告，freshness 不更新 |
| exit 0 但报告缺失、重复、不可解析或 `dryRun=true` | helper 拒绝，freshness 不更新 |
| backup finalPath 越界或包属主/权限不符 | helper 拒绝，freshness 不更新 |
| 两次并发调度 | 同 target 单飞，无并发写 `.prom` |
| 旧 run 迟到或时钟回拨 | freshness 不倒退 |
| helper 在 rename 前/后崩溃 | 无半写指标；锁可恢复；下一次成功运行可更新 |
| 指标文件/目录改为 symlink，或放宽非授权写权限 | fail-closed，原指标不变 |
| 保留 inventory、删除 freshness | missing 告警触发 |
| freshness 设为 25 小时前 | stale critical 告警触发 |
| freshness 设为 `time()+600` | future critical 告警触发 |
| 停止 node_exporter | exporter-down critical 告警触发 |
| 制造 textfile scrape error | scrape-error critical 告警触发 |

这些故障场景（`fault:guard:*` / `fault:recovery:*`）由执行器在隔离资源内真实注入并验证：
备份/PG 工具实际失败；独立 helper 子进程解析报告；两个进程争抢单飞锁；rename 前后真实
`SIGKILL` 并回收 dead-PID lock；Prometheus 当前状态与本轮 webhook generation 同时证明告警触发
和恢复。任何 guard 或 recovery 未通过均输出 `FAIL`。

## 5. Stop 条件

立即停止并保持现场：

- 发现任何正式路径、URL、进程、数据、密钥或 receiver；
- secret、数据库 URL、绝对路径、session id 或正文出现在日志/证据；
- 失败路径推进了 freshness；
- 指标半写、倒退、跨 target 污染或无法恢复的锁；
- cleanup 无法证明只作用于本次隔离资源。

不得自动 retry、restore、down migration 或删除未知备份。

## 6. 证据与结论

`run` 默认保留证据到 `$PI_DRILL_ROOT/runs/<run-id>/summary.json`（脱敏），供查看；本次运行
专属的 container/network/volume/自建 scheduler image 无论成功失败都会在退出前验证删除。显式
`pnpm drill -- cleanup` 清空已知文件运行产物，但保留 root 与 `secrets/`。

证据包只保留：授权引用、隔离 target opaque ID、版本 major、构建 digest、时间戳、计数、布尔
结果、PromQL/告警截图引用和 cleanup 结果。删除 secret、recipient/identity 内容、URL、
host/database、绝对路径、原始 argv/stderr、session id 和正文。

结论只能是：

- **PASS**：成功路径 + 全部失败注入 + 告警恢复 + cleanup 均通过；
- **FAIL**：任一强制项失败；
- **DEFERRED**：缺 podman/age/pg 工具等明确先决条件（不因环境变量自证通过）。
