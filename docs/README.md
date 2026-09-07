# 文档索引（docs）

> 本目录是 pi-agent-server 的内部设计、决策与操作文档索引。除明确标注外均为中文文档。

## 文档使用约定

- **决策记录**：架构与运行决策按 [ADR 维护约定](decisions/README.md) 维护；ADR 保留历史脉络，取代关系以新 ADR 明确记录。
- **当前操作**：migration、启动门禁、备份与恢复分别以 [operations.md](operations.md) 和 [backup-restore.md](backup-restore.md) 为准；备份新鲜度以对应契约与演练 SOP 为准。
- **IAM 规划**：[identity-access-plan.md](identity-access-plan.md) 只记录未来公网方案与路线图；当前接入控制见 [ip-rbac-design.md](ip-rbac-design.md)。
- **对外入口**：仓库根 [README.md](../README.md) / [README.zh-CN.md](../README.zh-CN.md)（对外状态与限制，双语同步）；需求基线 [needs.md](../needs.md)。

## 文档列表

### 架构与存储

- [architecture.md](architecture.md) —— 架构与核心数据流（单实例并发模型、SQLite 锁语义、目录/端口边界）。
- [agent-session-decoupling-plan.md](agent-session-decoupling-plan.md) —— RC 阶段 Agent Session 创建/存储解耦实施计划（Pi 仍为唯一实现；多 Agent 能力差异后置）。
- [database-design.md](database-design.md) —— 数据库设计、Schema Manifest 单一来源、双库方言与迁移约束（canonical baseline；不支持受控 cutover）。
- [pi-sdk-api.md](pi-sdk-api.md) —— Pi SDK 使用索引（HTTP 接口形态以 `src/server/app.ts` 为准）。
- [postgres-podman-test.md](postgres-podman-test.md) —— 本地 PostgreSQL（Podman）测试流程。

### 决策、数据保留、备份与运维

- [decisions/README.md](decisions/README.md) —— ADR 编号、状态和取代约定。
- [decisions/0001-phase-3-data-retention-baseline.md](decisions/0001-phase-3-data-retention-baseline.md) —— ADR 0001：Phase 3 数据保留基线（历史决策，部分被 ADR 0002 取代）。
- [decisions/0002-canonical-baseline-and-migration-gate.md](decisions/0002-canonical-baseline-and-migration-gate.md) —— ADR 0002：canonical baseline bootstrap 与 migration 启动门禁（当前决策）。
- [backup-restore.md](backup-restore.md) —— SQLite/PostgreSQL 备份、恢复与 migration 操作契约（RPO/RTO/保留期/密钥与存储边界/drill）。
- [operations.md](operations.md) —— 首次数据库初始化、离线运维、启动门禁与 Podman 正式部署计划。
- [backup-freshness-exporter.md](backup-freshness-exporter.md) —— 单实例本机备份新鲜度部署契约（Prometheus 指标 + inventory + Alertmanager）。
- [backup-freshness-drill-sop.md](backup-freshness-drill-sop.md) —— 备份新鲜度演练 SOP（一键演习 runner + 安全边界 + 故障矩阵）。

### 数据生命周期与归属

- [file-operations.md](file-operations.md) —— 安全只读 planner（`file_operations` outbox 生命周期）。
- [reconcile-jsonl.md](reconcile-jsonl.md) —— DB-only reconcile analyzer。
- [owner-transfer.md](owner-transfer.md) —— 离线 DB 层 IP→IP owner transfer。

### 接入控制与 IAM

- [ip-rbac-design.md](ip-rbac-design.md) —— 当前 IP access policy（网络准入 + 路由 role 授权；`PI_ALLOWED_CLIENT_CIDRS` + 策略文件）。
- [identity-access-plan.md](identity-access-plan.md) —— IAM 未来公网方案（OIDC/Access Token/API Key/RBAC/审计路线图）。

### 能力

- [capabilities/knowledge-qa.md](capabilities/knowledge-qa.md) —— 未来知识库问答能力需求，尚未实现。
