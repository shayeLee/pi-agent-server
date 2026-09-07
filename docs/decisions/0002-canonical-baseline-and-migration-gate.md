# ADR 0002：Canonical baseline bootstrap 与 migration 启动门禁

- **状态**：已接受（当前适用）
- **日期**：2026-09-07
- **取代**：部分取代 [ADR 0001](0001-phase-3-data-retention-baseline.md) 的 §1 和 §5；其余历史决策仍有效。

## 背景

ADR 0001 记录了数据保留切换时的受控最终 reset，以及 `rc` 数据模式可使用
`PI_MIGRATION_GATE=off` 的例外。现行实现已经收敛到更窄的 canonical baseline 接受面；这些旧路径如果继续被引用，会把历史决策误当成当前操作指南。

## 决策

### 1. 所有数据模式使用 verify-only 启动门禁

- `PI_DATA_MODE` 仍是部署分类，不改变 migration 安全规则。
- 所有 data mode 都必须使用 `PI_MIGRATION_GATE=verify`。`off`（包括 `PI_DATA_MODE=rc`）在创建任何资源前一律拒绝。
- 服务启动只读检查 migration ledger 和 schema head；不自动 bootstrap、apply、migration、reset 或 restore。

### 2. 只接受两条离线路径

- **完全空目标**：完全空的 SQLite DB，或完全空的 non-public/non-system PostgreSQL schema，只能通过离线
  `pnpm migrate -- --bootstrap-baseline --bootstrap-confirm CONFIRMED` 建立唯一 canonical baseline。bootstrap 不采纳已有数据，也不创建 pre-backup。
- **已有 canonical baseline**：只有已经存在且恰为唯一 canonical baseline 的目标，才能执行 `--apply`；正式顺序是已验证的 pre-backup → apply → verify。
- 缺少 ledger、legacy ledger、多行或非 canonical ledger、checksum 不匹配、schema 落后或其他无法证明为上述两种状态的目标，均 fail-closed。

受控 reset、final reset、cutover、Baseline Adoption 以及任何自动或静默重建都不是受支持的 migration 路径。已有数据但不具备唯一 canonical baseline 的目标不会被自动转换；需要由运维在支持的空目标上重新建立 baseline，并单独处理原目标的数据风险。

## 影响与后果

- `rc` 不再提供 `PI_MIGRATION_GATE=off` 绕过；即使是 disposable 部署也必须先建立并验证 canonical baseline。
- 服务启动不会删除、重置或补建数据。旧库、legacy 库、非唯一 ledger 和损坏 ledger 会在资源创建前失败，避免把不明状态默认为可迁移状态。
- 新环境需要一次明确的离线 bootstrap；schema 变更需要已有 baseline、停服、加密 pre-backup、`--apply` 和 `--verify`。这增加了运维步骤，但使数据库接受面和回滚边界可审计、可重复。
- 不能把空目标 bootstrap 当成已有数据的迁移或恢复。恢复包也必须满足 canonical baseline 约束；双存储回滚继续采用备份恢复而不是自动 down。

## 当前操作文档来源

- [operations.md](../operations.md)：启动门禁、目标状态和 migration CLI 的运维入口。
- [backup-restore.md](../backup-restore.md)：完全空目标 bootstrap、已有 baseline 的 apply、pre-backup、verify 及恢复契约。
- [database-design.md](../database-design.md)：Schema Manifest、canonical baseline 和数据库层约束。
