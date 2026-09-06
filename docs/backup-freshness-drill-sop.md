# WP5C 单实例备份新鲜度演练 SOP

> **状态**：实际演练 deferred、未授权、未执行。未来执行前必须由用户明确授权隔离环境、窗口和负责人。本文不授权启动服务、安装 timer、接触正式数据或使用正式 Alertmanager receiver。

权威契约见 [backup-freshness-exporter.md](backup-freshness-exporter.md)，备份恢复流程见 [backup-restore.md](backup-restore.md)，工作包状态见 [Phase 3 状态台账](phase-3-data-retention-plan.md)。

## 1. 目的与范围

在 disposable、target-like 环境证明：

```text
scheduler → fixed backup CLI → published report → textfile
→ node_exporter → Prometheus → Alertmanager notification/recovery
```

只使用合成 SQLite/PostgreSQL fixture、测试 age recipient/identity、隔离 backup root、textfile 目录和 receiver。不得使用正式数据库、JSONL、密钥、服务、备份目录或监控接收方。

missing-as-empty 机器报告语义已随 backup/restore 目标语义落地（见 [backup-restore.md](backup-restore.md#2-已落地语义)）；实际演练仍为 NO-GO（未授权、未执行）。

## 2. Preflight

开始前必须全部满足：

1. 用户对本次具体环境、窗口、operator 和允许的故障注入重新授权；
2. 证明所有路径、数据库/schema、recipient/identity、Prometheus 和 receiver 均为隔离测试资源；
3. 固定编译产物、Node、age、PG 工具路径和版本已记录，PG 三个 major 一致；
4. backup 账号权限最小化，不能读取 `PI_AUTH_PATH`；secret 仅经受限环境注入；
5. textfile 原子替换、同 target 单飞、时钟同步与 expected inventory 已配置；
6. helper 校验的是目标 published machine report，不再要求 `strict=true` 或 `missingSessionReferences=0`；
7. 已制定只删除本次隔离资源的 cleanup 清单。

任一条件不满足即保持 DEFERRED/NO-GO。

## 3. 成功路径

1. 用合成数据分别准备 SQLite 和 PostgreSQL target；至少包含一个有 JSONL 的 session 和一个缺失引用 session。
2. 由实际 scheduler/timer 触发，而不是手动模拟调度；记录上次/下次 trigger、实际 backup start 和不超过 12 小时的 cadence 配置。
3. helper 调用固定 compiled backup CLI；exit 0 且唯一 machine report 为 published、非 dry-run。
4. 缺失引用计数允许大于零；确认最终包与 `COMPLETE` 存在，freshness 更新为本次 backup start。
5. node_exporter scrape 成功，Prometheus 中 expected target、up、freshness 和 textfile scrape 状态标签一致。
6. 在隔离目标执行恢复：缺失历史对应 `pi_session_file=NULL`；有效 session 可读取。使用运维提供的测试 identity，证明 age 解密路径可用。
7. 确认 Alertmanager 没有遗留告警，再进入失败注入。

## 4. 失败注入矩阵

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

每项故障恢复后，下一次成功 run 必须更新指标并让对应告警自动清除；恢复通知是验收证据的一部分。

## 5. Stop 条件

立即停止并保持现场：

- 发现任何正式路径、URL、进程、数据、密钥或 receiver；
- secret、数据库 URL、绝对路径、session id 或正文出现在日志/证据；
- 失败路径推进了 freshness；
- 指标半写、倒退、跨 target 污染或无法恢复的锁；
- cleanup 无法证明只作用于本次隔离资源。

不得自动 retry、restore、down migration 或删除未知备份。

## 6. 证据与结论

证据包只保留：授权引用、隔离 target opaque ID、版本 major、构建 digest、时间戳、计数、布尔结果、PromQL/告警截图引用和 cleanup 结果。删除 secret、recipient/identity 内容、URL、host/database、绝对路径、原始 argv/stderr、session id 和正文。

结论只能是：

- **PASS，待用户验收**：成功路径、全部失败注入、告警恢复和 cleanup 均通过；
- **FAIL**：任一强制项失败；
- **DEFERRED**：未获授权或未执行（当前状态）。

只有用户明确接受证据后，才能在状态台账中把 WP5C 标为已验收。
