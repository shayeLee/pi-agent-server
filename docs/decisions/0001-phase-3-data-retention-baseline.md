# ADR 0001：Phase 3 数据保留基线

- **状态**：决策已确认；WP1 离线迁移基础、WP3A SQLite 备份核心、WP3B1 SQLite restore drill、WP3B2 PG backup/restore 与 WP3C migration prebackup/runbook 均已完成并通过各自真实 gate；WP3（备份/恢复/pre-migration/runbook）基础工作包已完成；WP2A 受控 cutover 实现已完成并通过真实 PG16+age verify:release 门禁验收；WP2B 实际 cutover 仍未执行
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
- 定期进行恢复演练；
- 备份先存本机绝对目录。

DB 快照与 JSONL 复制不是全局原子操作。在线复制 JSONL 后，必须复核 `size`、`mtime`、hash 及逐行 JSON；发生变化或出现半行时必须重试，无法稳定时备份失败且不得发布 `COMPLETE`。

备份正式采用 **age 公钥加密**。RPO/RTO、备份及数据/审计保留期、具体备份根路径、age recipient、私钥托管及访问控制细节仍待后续决策与验收；本文不编造具体数值或实现方式。

### 4. 部署形态与未来多实例路径

当前按单实例运行，SQLite 仅支持单实例，不实现多实例共享 SQLite。

未来如需多实例，目标路径为 **PostgreSQL + 共享/对象存储 JSONL + 分布式任务/事件协调**；该路径当前不实现。

### 5. 当前就绪状态

当前仍不可称为 production-ready。WP1、WP3A、WP3B1、WP3B2 与 WP3C 均是离线开发期工具，尚未接入正常服务启动。WP3（备份/恢复/pre-migration/runbook）基础工作包已完成：WP3A/WP3B1/WP3B2/WP3C 均已通过各自真实 gate。WP2A 受控 cutover 工具已完成并通过真实 PG16+age verify:release 门禁验收；但尚未执行真实 cutover reset、生产 backup 或恢复演练。WP2B 实际 cutover 仍未执行、未获得目标授权。上述 age、本机存储、每日在线执行及 migration 严格停服/强制 pre-migration backup 是已确认的设计决策，不代表 WP3 已接入服务启动或已生产就绪。IAM 工作包仍未开始。

## 不可变边界

- 凭证不得以明文进入备份；
- 生产回滚基于备份恢复，不采用自动 `down`；
- 已发布的 migration 不得修改，只能新增后续 migration。

## 关联文档

- [Phase 3 数据保留计划](../phase-3-data-retention-plan.md)
- [数据库设计](../database-design.md)
- [身份与访问管理规划](../identity-access-plan.md)
