# Phase 3 数据保留计划：Phase 3.0 数据保留基础 + Phase 3.1 IAM 前置路线

> 本文是 Phase 3 的**唯一状态台账**与计划文档：工作包状态、已确认决策、已落地行为与当前代码的剩余差距集中于此，其他文档不复制状态。
> 决策细节见 [ADR 0001](decisions/0001-phase-3-data-retention-baseline.md)（只记决策）；IAM 未来公网方案见 [identity-access-plan.md](identity-access-plan.md)（不复制状态）。
> 本文**不记录测试数量、不转述历史验收证据长句**；真实 gate 验收仅在当前环境实际提供前置条件（真实 PG `PI_TEST_PG_URL`、age 二进制）并实际运行对应门禁时计为证据。
> 除标注「已确认」的条目外均为计划/待定；标注「**待实现**」的目标行为当前代码尚未实现。

## 1. 目的、范围与当前状态边界

### 1.1 目的

在**开始保留真实用户数据之前**，把「数据保留」的地基立起来，使服务从「RC 可随时删库重建」平稳过渡到「数据不可重建、必须可迁移可恢复」：正式 migration 机制与启动迁移门禁、备份/恢复/恢复演练（覆盖 JSONL 与 DB 双存储）、双存储生命周期（对账/清理/隔离）、运维门禁，并作为 IAM（Phase 3.1）落地的进入条件。

### 1.2 范围

- **Phase 3.0（数据保留基础）**：迁移引擎、（最终 reset）切换、备份恢复、JSONL/DB 生命周期、运维门禁。
- **Phase 3.1（IAM 前置路线）**：仅指 IAM 落地所需的数据与基建就绪门槛；本文**不**设计或实施任何 IAM 功能（用户/token/角色/审计表、OIDC、API Key 等全部不在本计划实施范围内）。

### 1.3 当前状态边界

- **RC 阶段**：服务级正式 migration / 备份 / 回滚**未接入服务启动**；`pnpm migrate`/backup/restore/file-ops/reconcile-jsonl 均为离线开发期工具。
- 当前开发用 SQLite 目标无旧 RC 数据，已通过离线 bootstrap-baseline（无 pre-backup）+ verify 建立唯一 canonical baseline；**破坏性 reset/cutover 从未对真实用户数据执行**。受控 cutover 工具已移除：无 ledger 或非唯一 canonical baseline 的库由 bootstrap/迁移引擎 fail-fast 拒绝，不再存在自动/受控 reset 工具。
- 不执行真实用户数据备份/恢复演练，不部署任何备份任务；启动 migration 门禁（§4）与 backup/restore 目标语义（§5、§3）已落地。
- 当前接入控制由 IP-RBAC（WP5D）承担（见 [ip-rbac-design.md](ip-rbac-design.md)），不在本计划范围；旧 `TOKENS`/`INTRANET_CIDRS`/`TRUST_PROXY` 无兼容（见 [identity-access-plan.md](identity-access-plan.md) §2）。

## 2. 已确认决策（汇总）

| # | 决策 | 已确认内容 | 决策记录 |
| --- | --- | --- | --- |
| 1 | 数据保留起点 | **RC 数据不保留**；切换时受控最终 reset 基线（DB + JSONL 全清空），不做 Baseline Adoption | ADR §1 |
| 2 | 备份方向与执行时机 | **每日完整在线备份**（不要求每日停服务）+ 每次 migration 前强制备份 + 定期恢复演练（季度 + 重大 migration 前） | ADR §3 |
| 3 | 备份存储与边界 | 本机绝对目录 + **age 公钥加密**；**不覆盖主机/磁盘同失效**（无异地/介质隔离承诺）；**age identity 由运维托管** | ADR §3e |
| 4 | 部署形态 | **每 logical DB/schema + DATA_DIR 仅一个服务实例**；多实例共享同一逻辑库/数据目录不支持；改造路径仅预留 | ADR §4 |
| 5 | Migration 引擎选型 | **自定义 Manifest-driven 引擎（候选 B）**，不选 Kysely Migrator | ADR §2 |
| 6 | RPO / RTO | **RPO 24h**（固定 ≤ 12h 备份粒度）；**RTO 目标 4h**，signoff 延期到投入使用且有代表规模 | ADR §3a |
| 7 | 删除语义 | **保留 delete outbox，但无物理删除（无 unlink）**；物理清理 executor/处置不实现 | ADR §3f |
| 8 | WP5B | 仅作为正式启用副作用工具/多实例/公网前的**条件门禁**；不阻塞 Phase 3 | ADR §5 |
| 9 | WP5C | 方案 B 部署契约已形成、可评审，实际演练 deferred、**未验收** | ADR §3d |
| 10 | 备份保留期 | **30 天**；自动删除未实现、未排期（未来单独工作包） | ADR §3b |
| 11 | Migration 前置 | 每次 migration 前**严格停服务** + 强制 pre-migration backup；无全局写冻结，停服务不可被软门禁替代 | ADR §3 |

## 3. 目标行为 vs 当前代码

| 目标（计划） | 当前代码 | 状态 |
| --- | --- | --- |
| 独立数据模式 `PI_DATA_MODE=managed`/`rc`；`PI_MIGRATION_GATE` 默认 `verify`；服务启动 verify-only，且**绝不自动迁移** | **已实现**：默认 `managed + verify`；显式 `off` 一律在资源创建前 fail-fast；所有模式均须先离线建立并 verify 唯一 canonical baseline | ✅ 已落地 |
| backup 对缺失 session 引用按 **missing-as-empty** 处理并允许发布；但 SQLite/PG 的源 DB 必须先通过唯一 canonical baseline ledger（单行 v0 / `initial-schema` / golden checksum）检查 | **已实现**：缺 ledger、旧多行或错误 checksum 的 source/snapshot ledger（含 dry-run）在 age/发布/成功报告前 fail-closed，不能推进 freshness；通过该门禁后缺失引用仍一律记入 manifest 并发布 | ✅ 已落地 |
| backup 只把实际存在的 JSONL 当作 **opaque bytes**，不校验内容合法性 | **已实现**：backup 不再逐行 JSON.parse | ✅ 已落地 |
| restore 时对无效 JSONL 按 **invalid-as-empty** 处理 | **已实现**：restore 对包级完整性通过但内容无效的 JSONL 丢弃历史、`pi_session_file` 写 `NULL`，报告 `invalidSessionHistories`；manifest missing 引用同样归一为 `NULL` | ✅ 已落地 |

## 4. Migration 引擎与启动门禁

- **引擎（已确认选型）**：自定义 Manifest-driven，以运行时 Schema Manifest 为唯一 canonical baseline 真相；ledger（`schema_migrations`）与业务表同库同事务写入；稳定 checksum；SQLite `BEGIN IMMEDIATE` / PG 显式事务内执行，失败回滚。完全空 SQLite DB 或完全空 non-public/non-system PostgreSQL schema 必须离线执行 `pnpm migrate -- --bootstrap-baseline --bootstrap-confirm CONFIRMED` 建立唯一 canonical baseline；该命令不可混用 backup/maintenance 参数且不会创建 pre-backup。已经有唯一 canonical baseline 的数据库才可执行 `--apply`，并固定经过已验证 pre-backup→apply→verify；其他状态拒绝自动采用。详见 [database-design.md](database-design.md)。
- **不可变**：唯一 canonical baseline 不得被修改；生产回滚**靠备份恢复、不自动 down**（双存储非单事务，自动 down 破坏一致性）。
- **启动门禁**：已实现 `PI_DATA_MODE`（默认 `managed`）和 verify-only 的 `PI_MIGRATION_GATE`（默认 `verify`）。显式 `off` 一律在创建资源前 fail-fast；所有模式都做只读 ledger/head 校验，且不自动迁移；readiness 呈现面由 WP5A 交付。

## 5. 备份与恢复

- **备份集** = DB 快照 + 当次实际存在的 JSONL 会话文件。源 SQLite/PG 必须有**恰为唯一 canonical baseline**的 `schema_migrations` ledger（单行 version 0 / `initial-schema` / golden checksum）才允许加密或发布；缺 ledger、旧多行或 checksum 错误在任何成功报告和 freshness 前 fail-closed，`--dry-run` 同样失败。通过该 DB 门禁后，缺失引用按已确认业务语义视为无历史，记录后仍允许发布；DB 快照与 JSONL 复制不是全局原子操作，必须稳定复制并校验包级 hash/size 后才发布。
- **实现形态**：SQLite 用 `VACUUM INTO` 一致性快照 + JSONL 点快照；PostgreSQL 用 `pg_dump` + JSONL 点快照。JSONL 在 backup 阶段只作为 opaque bytes，不做内容合法性判断；age 加密、逐项 hash/size、`COMPLETE` 最后写入。上述语义已实现，行为见 §3 和 [backup-restore.md](backup-restore.md)。
- **恢复接受面（唯一 canonical baseline）**：restore 只接受 manifest 携带**恰为唯一 canonical baseline ledger**（present + 单行 version 0 / `initial-schema` / golden checksum）的包；非唯一 canonical baseline 或无 ledger 的包在 payload 解密/staging 之前 fail-fast（**不可恢复**）。JSONL 历史只接受当前 Pi SDK v3 结构（header `version:3`），更旧版本按 invalid-as-empty 丢弃；运行时也只接受 v3，v1/v2 fail-fast 且绝不调用 SDK `migrateSessionEntries`。
- **加密与存储（已确认）**：age 公钥加密、本机绝对目录；**不覆盖主机/磁盘同失效**；**age identity 由运维托管**。具体备份根路径、recipient 值与访问控制细节仍待定（§7）。
- **恢复演练**：每季度 + 每次重大 migration 前，在隔离/临时实例执行（SQLite drill 与 PG drill 均已完成实现）。备份「有效」的唯一证明是恢复演练通过；演练同样覆盖「迁移出错后的回滚」。
- **RPO / RTO（已确认）**：RPO 24h（固定 ≤ 12h 完整在线备份粒度，由部署方经过审核的 helper/timer 驱动固定构建产物 backup CLI，仓库不安装任何 timer/unit/plist；`pnpm backup` 仅人工 dev）。RTO 目标 4h，signoff 延期到投入使用且有代表规模（ADR §3a）。
- **保留期（已确认）**：30 天；过期备份由运维人工清理，自动 retention 属未来单独工作包（不属于 WP5B 也不属于 WP5C）。
- **监控（已确认）**：备份新鲜度由 WP5C 方案 B 部署契约定义（Prometheus per-target 指标 + 独立持久 inventory + 外部 Alertmanager），契约见 [backup-freshness-exporter.md](backup-freshness-exporter.md)、实际部署演练 SOP 见 [backup-freshness-drill-sop.md](backup-freshness-drill-sop.md)；实际部署演练 deferred、**未验收**。
- **凭证不入备份**：凭证来自环境变量 / KMS / `PI_AUTH_PATH` 独立凭证文件，不落库明文，备份集天然不含明文凭证。

## 6. 工作包状态台账（唯一状态台账）

| WP | 状态 | 摘要 | 详情 |
| --- | --- | --- | --- |
| WP0 | ✅ 已冻结 | 决策冻结（本文 + ADR 0001）；零代码/零数据变更 | [ADR 0001](decisions/0001-phase-3-data-retention-baseline.md) |
| WP1 | ✅ 已完成 | 离线 Manifest-driven migration 核心（ledger/checksum/锁/事务/CLI）；未接入服务启动 | [database-design.md](database-design.md) |
| WP2 | ✅ 已移除 | 受控 cutover（WP2A）已删除：无 ledger 或非唯一 canonical baseline 的库在 verify/apply/启动时均 fail-fast；完全空目标只能离线执行 `pnpm migrate -- --bootstrap-baseline --bootstrap-confirm CONFIRMED` 建立唯一 canonical baseline。历史决定见 [decisions/0001](decisions/0001-phase-3-data-retention-baseline.md) | — |
| WP3 | ✅ 已完成 | WP3A SQLite 在线备份核心、WP3B1 SQLite restore drill、WP3B2 PG backup/restore、WP3C migration prebackup/runbook 基础均已实现并通过各自真实 gate；均离线、未接入服务启动 | [backup-restore.md](backup-restore.md) |
| WP4 | ✅ 当前范围完成 | WP4A delete outbox + 删除事务、WP4B 只读 planner、WP4C DB-only 引用分析已完成。物理删除、filesystem scanner、retry/quarantine 已从当前范围排除 | [file-operations.md](file-operations.md)、[reconcile-jsonl.md](reconcile-jsonl.md) |
| WP5 | 🟡 进行中 | WP5A readiness/metrics 已完成；WP5C 部署契约已形成但实际演练 deferred、未验收 | [operations.md](operations.md)、[backup-freshness-exporter.md](backup-freshness-exporter.md)、[backup-freshness-drill-sop.md](backup-freshness-drill-sop.md) |
| 条件门禁 | ⏸ 按触发器启动 | WP5B 尚未实现，不阻塞当前 Phase 3；仅在正式启用副作用工具、多实例或公网前成为强制门禁 | 本文 §2、[identity-access-plan.md](identity-access-plan.md) |
| Phase 3.1 / IAM | ⬜ 未来 | 当前内网方案不实施；公网启用前另行启动 | [identity-access-plan.md](identity-access-plan.md) |

依赖链（简）：

```text
WP0 → WP1 迁移引擎 → WP3A 备份核心 → WP3B1 SQLite drill → WP3B 后续恢复/门禁 → WP2 最终 reset 切换（== 数据保留起点）
  └→ WP4A outbox 基础 → WP4B 只读 planner → WP4C DB-only reconcile analyzer（均无物理执行/处置）
  └→ WP5 运维门禁（WP5A ✅；WP5B 条件门禁；WP5C 契约未验收）→ WP6 IAM 进入条件
```

- WP2 必须在 WP3 备份恢复就绪后执行；WP4B/WP4C 无执行路径（物理执行/处置留给未来受审计的 native helper，尚未启动）。
### 当前 Phase 3 完成条件

1. 落地并验收 §3 的 migration 默认值/数据模式目标；
2. 落地并验收 §3 的 missing-as-empty、backup opaque JSONL、restore invalid-as-empty 语义；
3. 完成并验收 WP5C 单实例本机备份部署演练。

WP5B、物理 JSONL 删除、filesystem scanner、异地备份、自动 retention、RTO signoff、IAM/WP6 和多实例**均不属于当前完成条件**。在前三项完成前，Phase 3 仍在进行且服务不作生产就绪声明。

## 7. 待决策项清单（TBD）

以下条目**尚未决定**，决策前不得在实现中隐含默认值：

| # | 待决策项 | 影响面 | 当前状态 |
| --- | --- | --- | --- |
| 1 | ~~migration 引擎最终选型~~ | WP0/WP1 | **已决策**：自定义 Manifest-driven；Kysely Migrator 不选（ADR §2） |
| 2 | ~~RPO / RTO 取值~~ | WP3 | **已决策**：RPO 24h；RTO 目标 4h，signoff 延期到投入使用且有代表规模（ADR §3a） |
| 3 | ~~备份保留期~~ | WP3/WP4/WP5 | **已决策**：30 天；自动删除未实现、未排期（未来单独工作包）；会话 TTL、审计保留期、quarantine 保留期仍待定（quarantine 当前不实现） |
| 4 | 备份根路径及介质访问控制 | WP3 | 本机绝对目录 + 不覆盖主机/磁盘同失效已确认；具体绝对路径与访问控制细节未定 |
| 5 | age recipient / identity 轮换策略 | WP3 | age 公钥加密与 **identity 由运维托管**已确认；具体 recipient 值、轮换与访问控制策略未定 |
| 6 | 多实例 / 共享存储启动时机 | 未来 | 每 logical DB/schema + DATA_DIR 仅一个服务实例已确认；多实例改造（PG + 共享存储）仅预留，未定启动时机 |

## 8. 相关文档

- 文档索引与单一事实来源约定：[README.md](README.md)
- 决策记录（只记决策）：[decisions/0001-phase-3-data-retention-baseline.md](decisions/0001-phase-3-data-retention-baseline.md)
- 数据库设计 / Schema Manifest：[database-design.md](database-design.md)
- 架构速览（单实例并发模型、SQLite 锁语义）：[architecture.md](architecture.md)
- 备份 / 恢复 / 演练契约：[backup-restore.md](backup-restore.md)
- 离线 migration/pre-backup 运维与 readiness 门禁：[operations.md](operations.md)
- WP2A 受控 cutover 已移除（见上表 WP2 行）；完全空目标建立 ledger 的唯一路径是离线 `pnpm migrate -- --bootstrap-baseline --bootstrap-confirm CONFIRMED`，已有唯一 canonical baseline 的数据库才使用 `--apply`。
- WP5C 方案 B 部署契约 / 实际部署演练 SOP：[backup-freshness-exporter.md](backup-freshness-exporter.md)、[backup-freshness-drill-sop.md](backup-freshness-drill-sop.md)
- WP4B 只读 planner / WP4C DB-only reconcile analyzer：[file-operations.md](file-operations.md)、[reconcile-jsonl.md](reconcile-jsonl.md)
- WP5D owner transfer：[owner-transfer.md](owner-transfer.md)
- IAM 未来公网方案：[identity-access-plan.md](identity-access-plan.md)
- 本地 PostgreSQL 测试流程：[postgres-podman-test.md](postgres-podman-test.md)
- 需求基线：[../needs.md](../needs.md)
- 对外状态与限制：[../README.md](../README.md) / [../README.zh-CN.md](../README.zh-CN.md)
