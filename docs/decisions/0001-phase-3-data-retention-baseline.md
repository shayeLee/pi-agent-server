# ADR 0001：Phase 3 数据保留基线

- **状态**：决策已确认（已冻结）。本文只记录决策，**不复制状态**；工作包状态与「待实现」缺口见 [Phase 3 数据保留计划](../phase-3-data-retention-plan.md)。
- **日期**：2026-09-04；最新修订：2026-09-06

## 决策

### 1. 数据保留起点与最终 reset

当前 RC 数据不保留。未来切换到数据保留承诺时，采用一次受控的最终 reset：同时清空 DB 与 JSONL，经 migration 引擎从空库建立基线；**不做 Baseline Adoption**（不采纳既有 RC 库/文件为基线）。

最终 reset 只能在以下条件同时满足后，由明确的操作人员显式触发：

- migration 引擎已经实现并通过验收；
- 备份、恢复流程与恢复演练已经就绪并通过验收。

禁止自动或静默删除 DB、JSONL 或其中的数据；migration/cutover 工具仅在显式隔离的离线目标上运行，不接入正常服务启动。

### 2. Migration 引擎选型

采用 **Manifest-driven migration 引擎**（候选 B），不采用 Kysely Migrator。理由：

1. **Manifest 是唯一来源**：以现有运行时 Schema Manifest 作为 schema head 的唯一事实来源，避免迁移脚本引入第二份 schema 真相；
2. **适配 SQLite 事务与锁**：可按项目需要控制 SQLite 的事务、单写者锁与启动门禁语义；
3. **复用 schema compatibility**：直接复用现有 `assertSchemaCompatible` 及 SQLite/PG 契约校验。

引擎不提供自动 down/自动回滚；生产回滚靠备份恢复（见决策 7）。

### 3. 备份策略与执行时机

- 每日完整备份，在线执行，**不要求每日停服务**；
- 每次 migration 前必须**严格停服务**并强制执行 pre-migration backup；当前没有全局写冻结，停服务不可被软门禁替代；
- 定期恢复演练：**每季度 + 每次重大 migration 前**；
- 备份集 = DB 快照 + 当次实际存在的 JSONL 会话文件；缺失引用按决策 7 的业务语义视为无历史。DB 快照与 JSONL 复制不是全局原子操作，必须稳定复制并校验包级 hash/size 后才能发布。

### 3a. RPO / RTO

- **RPO = 24h**：固定 ≤ 12h 完整在线备份为粒度；最大数据丢失窗口为上一次成功备份到故障点之间。
- **RTO = 4h（目标）**：默认 restore drill 只产出恢复时间/完整性证据，**不构成 signoff**；完整 4h signoff 延期到服务**投入使用且有代表性数据规模**后，在隔离 target-like 环境、仅用合成且无敏感业务数据执行（restore → 启动 migration gate → 探针/合成检查 → 可服务，全程 ≤ 4h）并签署。

### 3b. 备份保留期

- 备份保留 **30 天**。
- 自动删除**未实现、未排期**：30 天作为运维策略记录，过期备份由运维人工判断后手动清理；自动 retention 属未来单独工作包。

### 3c. 备份调度策略

- 每日备份由**部署方经过审核的 helper/timer**（或等效 OS 调度器）以固定 ≤ 12h 节奏调用**固定构建产物** backup CLI；本代码库不交付/不安装任何 helper、timer、unit 或 plist，不使用服务进程内置 timer/scheduler；`pnpm backup` 仅作人工 dev 命令。
- timer 配置在部署层管理并审核。

### 3d. 监控架构（WP5C 方案 B）

- 备份新鲜度由 **WP5C 方案 B backup freshness 部署契约** 定义（部署方经过审核的 helper/timer + per-target node_exporter textfile 指标，仅在 backup CLI 已验证 published 完成后更新、失败绝不更新；独立持久 inventory + Prometheus missing/stale/future/exporter 规则 + 外部 Alertmanager）。契约细节见 [backup-freshness-exporter.md](../backup-freshness-exporter.md)。
- 是否完成部署演练及当前阻塞项不属于 ADR；统一见 [Phase 3 状态台账](../phase-3-data-retention-plan.md)。

### 3e. 备份存储、加密与密钥托管

- 正式采用 **age 公钥加密**；备份先存**本机绝对目录**。
- **本机备份不覆盖「主机/磁盘同失效」**：本地单副本不提供异地/介质隔离承诺，这是已接受的边界；独立挂载/异地不在当前范围。
- **age identity（私钥）由运维托管**：identity 的生成、保管、轮换与访问控制由运维负责，不在仓库内实现；具体 age recipient 值与轮换策略仍待定。

### 3f. 删除语义：保留 delete outbox，无物理删除

- 保留 `file_operations` **delete outbox**（删除事务内 enqueue、幂等、lease 预留），**但无物理删除（无 unlink）**。
- 物理清理 executor / retry / quarantine / filesystem reconcile 及其任何处置**不实现**；DELETE 只做逻辑删除并落 outbox 记录，绝不触碰文件系统。

### 4. 部署形态与多实例约束

- **每 logical DB/schema + DATA_DIR 仅一个服务实例**；多实例共享同一逻辑库/同一数据目录**不支持**（SQLite 单写者 + WAL，共享文件会竞态/损坏）。
- 未来多实例路径（PostgreSQL + 共享/对象存储 JSONL + 分布式协调）仅预留、**当前不实现**；存储访问已按方言中立抽象、迁移锁按可替换实现设计。

### 5. WP5B：条件性部署门禁

WP5B（durable request-idempotency / shutdown-persistence 加固）按用户决定 **DEFERRED（暂缓）**，尚未实现或验收；它**仅作为**正式启用副作用工具（`bash`/`edit`/`write`）、部署多个服务实例或公网部署**之前**必须完成并验收的条件门禁，**不属于**当前 Phase 3 完成条件，也不阻塞 Phase 3 推进。当前代码不因 `TOOLS` 配置而 runtime fail-fast。

### 6. 启动 migration gate 目标

- `PI_MIGRATION_GATE` 保持 `off`/`verify` 两种语义，目标默认改为 `verify`。
- 增加独立的 `managed`/`rc` 数据模式（配置名在实现时冻结，目标默认 `managed`）：`managed` 必须搭配 `verify`，`rc` 才允许显式 `off`。
- 所有模式均**绝不自动迁移或 reset**；schema 变更只能由离线 migration CLI 在维护窗口执行。
- 当前实现差距只记录于 [Phase 3 状态台账](../phase-3-data-retention-plan.md)。

### 7. backup/restore 会话历史语义

- backup 对缺失 session 引用按 **missing-as-empty** 处理并允许发布，在加密 manifest 与机器报告中记录数量；恢复时对应 `pi_session_file` 归一为 `NULL`。
- backup 将实际存在的 JSONL 作为 opaque bytes 稳定复制，只校验包级 hash/size 与密文完整性，不判断 JSONL 内容是否合法。
- restore 在解密和包级完整性验证通过后检查 JSONL；内容无效时按 **invalid-as-empty** 处理并报告数量。age 解密、manifest、ciphertext 或 hash 错误仍必须让整个恢复失败，不能降级为空历史。
- 当前实现差距只记录于 [Phase 3 状态台账](../phase-3-data-retention-plan.md)。

### 8. 生产回滚与不可变约束

- 生产回滚**基于备份恢复，不采用自动 down**：DB 与 JSONL 是双存储、非单事务，自动 down 会破坏一致性；回滚 = 停服 → 从最近完整备份恢复 → 启动门禁重新校验 → 验证 → 恢复服务。
- 已发布的 migration **不得修改**，schema 变更只能新增后续版本；配合稳定 checksum 强制防篡改。

## 不可变边界

- 凭证不得以明文进入备份；
- 生产回滚基于备份恢复，不采用自动 `down`；
- 已发布的 migration 不得修改，只能新增后续 migration。

## 关联文档

- [Phase 3 数据保留计划](../phase-3-data-retention-plan.md)（**状态台账**：工作包状态与待实现缺口）
- [数据库设计](../database-design.md)
- [备份与恢复契约](../backup-restore.md)
- [WP5C 方案 B 部署契约](../backup-freshness-exporter.md) / [实际部署演练 SOP](../backup-freshness-drill-sop.md)
- [身份与访问管理规划（未来公网方案）](../identity-access-plan.md)
