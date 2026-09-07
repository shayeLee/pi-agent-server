# Architecture Decision Records（ADR）

本目录保存需要长期追踪的架构与运行决策。ADR 记录为什么这样决定，以及后续决策如何改变它；当前操作步骤以对应的专题文档为准。

## 维护约定

- 文件名使用递增四位编号和简短主题：`NNNN-short-title.md`。新 ADR 使用下一个连续编号，任何情况下都不复用旧编号。
- 每份 ADR 开头标明状态和日期。`已接受`表示当前适用；`已取代`或`部分取代`必须链接取代它的后续 ADR。
- 已接受 ADR 是历史记录，不静默改写原决策。发现错误或需要改变现行规则时，新建 ADR，并在新旧 ADR 中互相链接；仅可修正排版等不改变语义的问题。
- 取代关系必须明确写出范围（整份 ADR 或具体章节）以及影响/后果。ADR 不承担临时状态汇总；操作命令和安全步骤放在 [operations.md](../operations.md)、[backup-restore.md](../backup-restore.md) 等权威专题文档。

## ADR 索引

| 编号 | 状态 | 主题 |
| --- | --- | --- |
| [0001](0001-phase-3-data-retention-baseline.md) | 已接受；部分被 0002 取代 | Phase 3 数据保留基线（历史决策） |
| [0002](0002-canonical-baseline-and-migration-gate.md) | 已接受；当前适用 | Canonical baseline bootstrap 与 migration 启动门禁 |
