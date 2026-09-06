# 文档索引（docs）

> 本目录是 pi-agent-server 的内部设计/计划文档索引，并约定「单一事实来源」原则。除明确标注外均为中文文档。

## 单一事实来源约定

- **状态台账**：Phase 3 / 数据保留 / 运维就绪的唯一状态台账是 [phase-3-data-retention-plan.md](phase-3-data-retention-plan.md)。任何 WP 状态、验收与「待实现」缺口以它为准，其他文档不复制状态。
- **决策记录**：[decisions/0001-phase-3-data-retention-baseline.md](decisions/0001-phase-3-data-retention-baseline.md)（ADR 0001）只记录已确认决策，不复制状态。
- **IAM 规划**：[identity-access-plan.md](identity-access-plan.md) 只记录未来公网方案与路线图；当前接入控制（IP-RBAC，WP5D）见 [ip-rbac-design.md](ip-rbac-design.md)；旧 `TOKENS`/`INTRANET_CIDRS`/`TRUST_PROXY` 无兼容、无迁移。
- **对外入口**：仓库根 [README.md](../README.md) / [README.zh-CN.md](../README.zh-CN.md)（对外状态与限制，双语同步）；需求基线 [needs.md](../needs.md)。

## 文档列表

### 架构与存储

- [architecture.md](architecture.md) —— 架构与核心数据流（单实例并发模型、SQLite 锁语义、目录/端口边界）。
- [database-design.md](database-design.md) —— 数据库设计、Schema Manifest 单一来源、双库方言与迁移约束（new-baseline 单基线；受控 cutover 已移除）。
- [pi-sdk-api.md](pi-sdk-api.md) —— Pi SDK 使用索引（HTTP 接口形态以 `src/server/app.ts` 为准）。
- [postgres-podman-test.md](postgres-podman-test.md) —— 本地 PostgreSQL（Podman）测试流程。

### Phase 3：数据保留与运维

- [phase-3-data-retention-plan.md](phase-3-data-retention-plan.md) —— **唯一状态台账**：工作包状态、已确认决策、目标 vs 当前代码（待实现）。
- [decisions/0001-phase-3-data-retention-baseline.md](decisions/0001-phase-3-data-retention-baseline.md) —— ADR 0001：数据保留决策记录（只记决策）。
- [backup-restore.md](backup-restore.md) —— SQLite/PostgreSQL 备份、恢复与演练契约（RPO/RTO/保留期/drill）。
- [operations.md](operations.md) —— 离线 migration/pre-backup 运维流程与门禁（WP5A readiness/metrics）。
- [backup-freshness-exporter.md](backup-freshness-exporter.md) —— 单实例本机备份新鲜度部署契约（Prometheus 指标 + inventory + Alertmanager）。
- [backup-freshness-drill-sop.md](backup-freshness-drill-sop.md) —— 备份新鲜度演练 SOP（一键演习 runner + 安全边界 + 故障矩阵）。

### 数据生命周期与归属

- [file-operations.md](file-operations.md) —— WP4B 安全只读 planner（`file_operations` outbox 生命周期）。
- [reconcile-jsonl.md](reconcile-jsonl.md) —— WP4C DB-only reconcile analyzer。
- [owner-transfer.md](owner-transfer.md) —— WP5D-4 离线 DB 层 IP→IP owner transfer。

### 接入控制与 IAM

- [ip-rbac-design.md](ip-rbac-design.md) —— 当前 IP access policy（WP5D-1/2/3 网络准入 + 路由 role 授权；`PI_ALLOWED_CLIENT_CIDRS` + 策略文件）。
- [identity-access-plan.md](identity-access-plan.md) —— IAM 未来公网方案（OIDC/Access Token/API Key/RBAC/审计路线图）。

### 能力

- [capabilities/knowledge-qa.md](capabilities/knowledge-qa.md) —— 未来知识库问答能力需求，尚未实现。
