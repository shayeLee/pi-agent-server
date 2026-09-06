# 单实例本机备份新鲜度契约

> **状态**：部署契约已形成。missing-as-empty 机器报告语义已随 backup/restore 目标语义落地（见 [backup-restore.md](backup-restore.md#2-已落地语义)）。演练 runner 已实现真实一键执行（含临时本地监控栈、告警恢复与完整故障矩阵，见[演练 SOP](backup-freshness-drill-sop.md)）。验收状态见 [Phase 3 状态台账](phase-3-data-retention-plan.md)。

## 1. 范围

本文只覆盖一个 logical DB/schema + `DATA_DIR` 的单实例、本机备份链路：

```text
部署方审核的 helper/timer
  → 固定编译产物 pi-agent-server-backup
  → 校验 published machine report
  → 原子更新 node_exporter textfile 指标
  → Prometheus
  → 外部 Alertmanager
```

仓库不交付或安装 helper、timer、systemd unit、launchd plist、node_exporter、Prometheus 或 Alertmanager；`pnpm backup` 只用于人工开发。

本地备份不覆盖主机/磁盘与 backup root 同时丢失。age identity 由运维托管且不参与备份任务。

## 2. 成功与失败

已落地机器报告语义如下：

```text
backup-json-report: {
  "dialect": "sqlite" | "postgres",
  "status": "published",
  "dryRun": false,
  "finalPath": "<BACKUP_ROOT 下的绝对路径>",
  "payloadCount": N,
  "missingSessionReferences": N
}
```

helper 只有在以下条件全部满足后才更新 freshness：

1. backup CLI exit code 为 0；
2. stdout 恰好包含一条可解析的 `backup-json-report:`；
3. `status=published`、`dryRun=false`；
4. `finalPath` 位于预配置的 `BACKUP_ROOT` 内，包目录及 `COMPLETE` 已存在且属主正确；
5. 没有超时、被杀、输出解析失败或发布后验证失败。

`missingSessionReferences` 可以大于零：缺失历史按业务决策视为空，不阻止发布或 freshness 前进。backup 不解析 JSONL 内容。包/密文/hash、age、数据库快照或发布失败仍不得更新指标。

## 3. 指标

```text
pi_agent_server_backup_last_success_timestamp_seconds
```

- 类型：gauge，Unix epoch 秒；
- 值：调用 backup CLI **之前**记录的 backup start 时间，而非完成时间；
- 仅成功发布后更新；任何失败保留上一次值；
- 同一 target 必须单飞；锁内执行 read/compare/write，禁止时间戳倒退；
- 使用同文件系统临时文件 + fsync + rename 原子替换完整 `.prom` 文件；
- 备份主机与 Prometheus 使用受控时间同步；超过当前时间 300 秒的值视为无效。

为了发现“从未成功、指标不存在”，监控控制面独立提供：

```text
pi_agent_server_backup_expected_target_info{job,cluster,instance}=1
```

它不能由被监控 target 自己生成。

## 4. 部署安全边界

- 使用专用、非 root、不可登录的 backup 账号；backup root 与 plaintext staging 为该账号 0700。
- helper 只调用 root-controlled、非 symlink、不可被 group/world 写的固定 Node 和编译产物。
- `age`、`pg_dump`、`pg_restore` 使用审核过的绝对路径；PostgreSQL server/dump/restore major 一致。
- secret 只通过受限的 0600 配置注入环境，不能出现在 argv、unit、日志或证据中。
- backup 账号不得读取服务 `PI_AUTH_PATH` 内容；对数据目录只授予备份所需的最小读取/遍历权限。
- textfile 目录由 root 管理，node_exporter 只读；指标文件和祖先目录不得是 symlink 或可被非授权账号写入。
- 每 12 小时调度一次；随机延迟、最坏备份时长与告警 `for` 必须共同满足 `12h + D + J < 24h`。

## 5. Prometheus 最小规则

以下规则使用完整 `(job, cluster, instance)` 标签与 expected inventory 匹配：

```yaml
groups:
  - name: pi-agent-server-backup
    rules:
      - alert: PiAgentServerBackupExporterDown
        expr: (pi_agent_server_backup_expected_target_info == 1)
              unless on (job, cluster, instance) (up == 1)
        for: 15m
      - alert: PiAgentServerBackupTextfileScrapeError
        expr: (pi_agent_server_backup_expected_target_info == 1)
              and on (job, cluster, instance) (node_textfile_scrape_error == 1)
        for: 15m
      - alert: PiAgentServerBackupFreshnessMissing
        expr: ((pi_agent_server_backup_expected_target_info == 1)
               and on (job, cluster, instance) (up == 1))
              unless on (job, cluster, instance)
                pi_agent_server_backup_last_success_timestamp_seconds
        for: 15m
      - alert: PiAgentServerBackupStale
        expr: (time() - pi_agent_server_backup_last_success_timestamp_seconds > 24 * 60 * 60)
              and on (job, cluster, instance)
                (pi_agent_server_backup_expected_target_info == 1)
        for: 15m
      - alert: PiAgentServerBackupFutureTimestamp
        expr: (pi_agent_server_backup_last_success_timestamp_seconds > time() + 300)
              and on (job, cluster, instance)
                (pi_agent_server_backup_expected_target_info == 1)
        for: 15m
```

所有告警至少标为 critical，并由外部 Alertmanager 配置隔离 receiver。具体 label selector 由部署环境补齐，禁止无目标范围的全局 `absent()`。

## 6. 验收条件

实际部署演练至少证明：

- scheduler-originated 正常备份成功，机器报告通过，指标更新；
- missing reference 仍成功发布，报告缺失数量，指标更新；隔离恢复后对应 session 历史为空；
- age/数据库/发布/报告校验失败时指标不更新；
- 并发、时钟倒退、symlink/权限漂移时 fail-closed；
- missing、stale、future、exporter-down、textfile scrape error 告警触发并在恢复后自动清除；
- evidence 只包含枚举、计数、版本、digest、时间戳和 opaque reference，不包含 secret、URL、绝对路径、session id 或正文。

演练未实际完成并签署前，备份新鲜度部署保持未验收。
