# ADR 0001：Phase 3 数据保留基线

- **状态**：决策已确认；WP1 离线迁移基础、WP3A SQLite 备份核心、WP3B1 SQLite restore drill、WP3B2 PG backup/restore 与 WP3C migration prebackup/runbook 均已完成并通过各自真实 gate；WP3（备份/恢复/pre-migration/runbook）基础工作包已完成；WP2A 受控 cutover 实现已完成并通过真实 PG16+age verify:release 门禁验收；WP2B 实际 cutover 仍未执行。WP5B durable idempotency/shutdown persistence 按用户决定 **DEFERRED（暂缓）且不算完成**；当前仅有进程内 in-flight 去重与持久化终态读取，终态落库前崩溃可能导致相同 `requestId` 重执行，不承诺 exactly-once 或 durable at-most-once；仅在 side-effect tools 正式启用、多实例、公开服务或明确严格防重放要求时重新触发。WP5C 方案 B 部署演练 SOP 已形成但实际演练按用户决定 deferred；strict foundation accepted，WP5C/WP5 未验收，服务非 production-ready
- **日期**：未记录

## 决策

### 1. 数据保留起点与最终 reset

当前 RC 数据不保留。未来切换到数据保留承诺时，采用一次受控的最终 reset，同时清空 DB 与 JSONL；不迁移当前 RC 数据，也不做 Baseline Adoption。

最终 reset 只能在以下条件同时满足后，由明确的操作人员显式触发：

- migration 引擎已经实现并通过后续 WP 验收；
- 备份、恢复流程与恢复演练已经就绪并通过验收。

禁止自动或静默删除 DB、JSONL 或其中的数据。WP1 仅在显式隔离的离线 SQLite/PG 目标上运行迁移核心；不执行生产 reset、备份或恢复，也不接入正常服务启动。

### 2. Migration 引擎选型

采用 **Manifest-driven migration 引擎**，不采用 Kysely Migrator。理由如下：

1. **Manifest 是唯一来源**：以现有 Schema Manifest 作为 schema head 的唯一事实来源，避免迁移脚本引入第二份 schema 真相。
2. **适配 SQLite 事务与锁**：可按项目需要控制 SQLite 的事务、单写者锁与启动门禁语义。
3. **复用 schema compatibility**：可直接复用现有 `assertSchemaCompatible` 及其 SQLite/PG 契约校验，避免另起一套兼容判断。

WP1 已完成离线 ledger、checksum、SQLite/PG 锁与事务核心及 CLI；WP3A SQLite 备份核心、WP3B1 SQLite restore drill、WP3B2 PG backup/restore 与 WP3C migration prebackup/runbook 均已完成。WP1、WP3A、WP3B1、WP3B2 与 WP3C 均未接入 `startServer`，不包含 outbox、reconcile、IAM 或 readiness。WP3B2 reviewer P0/P1 修复已完成，并通过真实 PG16 `pg_dump` → age → `pg_restore` gate；WP3C 通过真实 PG+age `verify:release` 全量通过及 `test:migration-prebackup` 独立门禁通过。WP3（备份/恢复/pre-migration/runbook）基础工作包已完成，但均为离线工具，不接入服务启动。WP3B2 的恢复 contract 必须拒绝 authenticated public/source schema，只接受显式空 `pi_restore_*` target；未配置的 libpq 默认 `public` namespace 仅作为 bootstrap target，target URL 不需要预设 `search_path`，恢复后由 catalog 唯一定位 authenticated non-public schema。

### 3. 备份策略与执行时机

备份策略确定为：

- 每日完整备份，在线执行，**不要求每日停服务**；
- 每次 migration 前必须严格停服务，并强制执行 pre-migration backup；当前没有全局写冻结，停服务是不可替代的前置条件；
- 恢复演练：**每季度 + 每次重大 migration 前**（已确认）；
- 备份先存本机绝对目录。

### 3a. RPO / RTO（已确认）

- **RPO = 24h**：每日完整在线备份为粒度；最大数据丢失窗口为上一次成功备份到故障点之间的时间。
- **RTO = 4h**：默认 restore 部分只产出 restore-time/完整性证据，不能单独验收或签署；完整 signoff 必须在获授权的隔离 target-like 环境、仅用合成且无敏感业务数据，计时 restore → `PI_MIGRATION_GATE=verify` 启动 → `/health`、`/readyz` 与合成无敏感业务检查 → 可服务，随后关闭并清理隔离服务，且全流程 `<=4h`，不得正式服务。
- 验收：RPO 由 Prometheus backup freshness 告警（外部 Alertmanager）覆盖；RTO 仅由上述完整隔离流程的阶段时间证据和 `<=4h` signoff 覆盖，默认 restore drill 实际恢复时间不构成 RTO signoff。

### 3b. 备份保留期（已确认）

- 备份保留 **30 天**。
- **自动删除尚未实现、未排期**：30 天作为运维策略记录，过期备份由运维人工判断后手动清理；自动 retention 属**未来单独工作包**（不属于 WP5B（durable idempotency 加固）也不属于 WP5C（exporter 部署契约））。

### 3c. 备份调度策略（已确认）

- 每日备份由**部署方经过审核的 helper/timer**（或等效 OS 调度器；本代码库不交付/不安装任何 helper、timer、unit 或 plist）驱动，以**固定 12h 节奏**（≤ 12h，不允许 24h 间隔示例——见 WP5C 部署契约 §7）调用**固定构建产物（绝对 root-owned 编译产物 backup CLI + 固定 node 二进制 ≥ 22.19；非 `pnpm backup`、非 `AGENT_CWD`）**——**`pnpm backup` 仅作为人工 dev 命令使用**，绝不进入任何自动化路径；**不使用服务进程内置 timer/scheduler**；自动化叙述统一为「部署方经过审核的 helper/timer（见契约）」。
- timer 配置在部署层管理并进行审核，不在本代码库中安装。

### 3d. 监控架构（已确认）

- **Prometheus metrics**：由 **WP5C 方案 B backup freshness 部署契约**定义——部署方经过审核的 helper/timer 调度固定构建产物 backup CLI；验收至少需要一次 scheduler-originated 正常 run，记录非敏感配置摘要、上次/下次 trigger、实际 start 与 `<=12h` 间隔，平台调度配置变化后重演；手动 run 不能验收调度。**per-target** node_exporter textfile 指标 `pi_agent_server_backup_last_success_timestamp_seconds` **仅在 backup CLI 已验证 published 完成后更新（失败绝不更新）**；独立监控控制面/inventory 持久产生 `pi_agent_server_backup_expected_target_info{job,cluster,instance}=1`（不是被监控 target），首次缺失由独立 inventory 存在且 `up==1`、但 freshness 缺失的 `(I and up==1) unless F` 告警，Prometheus 规则以独立持久 `pi_agent_server_backup_expected_target_info{job,cluster,instance}=1` inventory 为 expected 清单，并用完整三元组匹配 actual freshness/up/textfile；missing 使用精确规则 `(I and up==1) unless F`（`I unless A` 仅用于 Q3 漂移，不使用全局 `absent()`），另含 stale / future / exporter 规则与 Q1–Q3 唯一性验收查询（完整三元组精确 1、instance 跨 job/cluster 不重复、inventory/actual 集合相等）；契约见 [backup-freshness-exporter.md](../backup-freshness-exporter.md)，**已形成、可评审、未经过实际部署演练不验收**。
- **外部 Alertmanager**（非本代码库组件）：消费 Prometheus 指标并触发告警（RPO 24h freshness 阈值等）。

### 3e. WP5C 方案 B：backup freshness 部署契约（契约已形成、可评审、未经过实际部署演练不验收；方案 A 已放弃）

- **形态收敛**：早前「外部 OS 调度器调用单一 root-owned Node 部署助手（模板）」的可复制形态已收敛为**部署契约 + 验收清单**——本仓库**不再交付/展示可复制的 root Node helper 源码、shell 运行脚本、systemd unit 或 launchd plist**，**不声称跨 OS 原子发布实现**。契约只定义部署方必须满足的要求：**固定构建产物**（整个 `dist-backup` 运行时传递闭包及其祖先链 root-owned、非 symlink、无 group/world 写；绝对 root-owned 编译产物 backup CLI 只由确切 pinned node ≥ 22.19 执行，非 AGENT_CWD/pnpm；helper 每次运行验证 resolved binary/版本）；`age`/`age-keygen`/`pg_dump`/`pg_restore` 只用已审核绝对路径或受控 root-owned 安全 PATH，并验证 resolved binary/版本，拒绝不受控 PATH；`pnpm backup` 仅人工 dev）；**调度节奏 ≤ 12h**（默认固定 12h，不允许 24h 间隔示例，随机延迟计入预算）；**secret 不得 argv**（受限 root:root 0600 env 配置，严格单一 `KEY=VALUE` 语义，经进程环境传递，任何 argv/unit/plist/日志无 secret）；**服务 auth token 不可读取**（`PI_AUTH_PATH` 服务账号属主 0600，backup 用户不可读内容，仅持每个祖先目录精确 traverse（仅 search）ACL，Linux setfacl / macOS chmod +a 或等价机制，无 root preflight 替代）；**per-target textfile 指标仅在 backup CLI 已验证 published 完成后更新**（exit 0 + 机器可读 published output 校验通过、拒绝 dry-run；**自动化必须带 strict flag `--require-complete-session-references`**——机器契约 = 单行 `backup-json-report:` JSON（status=published/strict=true/dryRun=false/missingSessionReferences=0），strict 成功即声明引用完整，任一缺失 session reference 在发布前 fail-closed、绝不更新指标），**失败绝不更新**（指标停留在上次成功时间，含完整性失败——由 missing/stale critical 告警暴露；人工默认运行不构成 freshness）；指标值 = 调用前记录的 **conservative backup start**（wall-clock epoch）；**target root / ACL / atomicity 由部署审核**（backup root 属主 0700、父目录 root 控制、textfile 目录 root 属主 0750 node_exporter 组只读、完整祖先链 root-owned/非 symlink/无 group/world 写；原子替换由部署方在目标 OS 审核留证——仓库不宣称任何跨 OS 原子发布或 fd safety）；Prometheus 规则以独立持久 inventory `pi_agent_server_backup_expected_target_info{job,cluster,instance}=1` 为 expected 清单，按完整 `(job, cluster, instance)` 三元组匹配 actual freshness/up/textfile，含 missing（精确为 `(I and up==1) unless F`；`I unless A` 仅用于 Q3 漂移，不使用全局 `absent()`）/ stale（`time() - metric > 24h`）/ future-timestamp / exporter-down / scrape-error 规则与 Q1–Q3 验收查询（完整三元组精确 1、instance 跨 job/cluster 不重复、inventory/actual 集合相等）；Alertmanager 由外部配置。所有自动化入口统一为「部署方经过审核的 helper/timer（见契约）」，禁止直接 pnpm/CLI 自动 timer 示例。
- **明确不做的事**：无扫描（方案 A 仓库内 scanner observer 已放弃）、无 age identity（不接触私钥/identity）、无服务集成（不接入 startServer）、无仓库 timer/helper（本代码库不交付/不安装任何 helper、unit、plist 或运行脚本）、无自动 backup、无删除（30 天保留人工清理）。
- **未来方向另议**：native in-process metrics 或基于 age identity 的 freshness 方案作为单独事项另行讨论。
- **验收状态**：未验收（可评审）；未经过实际部署演练不验收；本文不记录或推导测试数量。

### 3f. Strict backup completeness 基础（✅ 已验收）

实际部署演练的执行入口为 [backup-freshness-drill-sop.md](../backup-freshness-drill-sop.md)。SOP 已形成，但本次及当前计划的实际演练按用户决定 **DEFERRED**；执行前需再次授权目标环境，且禁止正式数据/正式服务。该 SOP 不改变本 ADR 对 strict foundation、WP5C 与 WP5 验收状态的分账。

- 用户提供的修复 fixture 后完整真实 PG16+age `verify:release` 成功证据包含 strict completeness compiled/npm 门禁及真实 PostgreSQL CLI gate 通过；本文不记录测试数量。
- 验收范围仅为 backup core/CLI foundation：`--require-complete-session-references` 在 final publish/`COMPLETE` 前 fail-closed，并绑定最终快照；这不改变 WP5C 方案 B 的状态。WP5C 仍为已形成、可评审、未验收，必须实际演练 helper/timer → textfile → Prometheus → Alertmanager 后才能验收。

DB 快照与 JSONL 复制不是全局原子操作。在线复制 JSONL 后，必须复核 `size`、`mtime`、hash 及逐行 JSON；发生变化或出现半行时必须重试，无法稳定时备份失败且不得发布 `COMPLETE`。

备份正式采用 **age 公钥加密**。RPO 24h / RTO 4h 与备份保留 30 天已在 §3a/§3b 确认；具体备份根路径、age recipient、私钥托管及访问控制细节仍待后续决策与验收；本文不编造实现方式。

### 4. 部署形态与未来多实例路径

当前按单实例运行，SQLite 仅支持单实例，不实现多实例共享 SQLite。

未来如需多实例，目标路径为 **PostgreSQL + 共享/对象存储 JSONL + 分布式任务/事件协调**；该路径当前不实现。

### 5. 当前就绪状态

**WP5B 延期决策（仅记录，不实现）**：WP5B 按用户决定 **DEFERRED（暂缓）**，不算完成。当前仅有进程内 in-flight 去重与持久化终态读取；若在终态落库前崩溃，相同 `requestId` 可能再次执行；不承诺 exactly-once 或 durable at-most-once。仅在 side-effect tools 正式启用、多实例、公开服务或明确严格防重放要求时重新触发 WP5B。WP5/WP5C 仍未验收。

当前仍不可称为 production-ready。WP1、WP3A、WP3B1、WP3B2 与 WP3C 均是离线开发期工具，尚未接入正常服务启动。WP3（备份/恢复/pre-migration/runbook）基础工作包已完成：WP3A/WP3B1/WP3B2/WP3C 均已通过各自真实 gate。WP2A 受控 cutover 工具已完成并通过真实 PG16+age verify:release 门禁验收；但尚未执行真实 cutover reset、生产 backup 或恢复演练。WP2B 实际 cutover 仍未执行、未获得目标授权。上述 age、本机存储、每日在线执行及 migration 严格停服/强制 pre-migration backup 是已确认的设计决策，不代表 WP3 已接入服务启动或已生产就绪。IAM 工作包仍未开始。

## 不可变边界

- 凭证不得以明文进入备份；
- 生产回滚基于备份恢复，不采用自动 `down`；
- 已发布的 migration 不得修改，只能新增后续 migration。

## 关联文档

- [Phase 3 数据保留计划](../phase-3-data-retention-plan.md)
- [数据库设计](../database-design.md)
- [身份与访问管理规划](../identity-access-plan.md)
