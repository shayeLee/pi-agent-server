# Phase 3 数据保留计划：Phase 3.0 数据保留基础 + Phase 3.1 IAM 前置路线

> 本文是 Phase 3 的可独立阅读**计划**文档，仅记录已确认决策、推荐方案、目标架构与工作包划分，**不是实现承诺**；除 §2 标注「已确认」的条目外，其余均为计划/推荐/待定，未拍板、未实现。
>
> **当前基线（如实分账）**：Phase 2 已全部完成并通过最终发布门禁——`volta run pnpm verify:release`（typecheck + test + test:postgres + build，设置真实 PG `PI_TEST_PG_URL`）全部通过：全量 `pnpm test` = 54 文件 / 563 用例、无 skip，`pnpm test:postgres` = 45 个 PG 门控用例真实执行且全部通过（见 [database-design.md](database-design.md) §9）。
>
> **RC 现状**：当前仍是 Release Candidate 阶段——**无正式 migration / 备份 / 回滚**：bootstrap 仅面向空库/当前 schema（`IF NOT EXISTS` + 严格 preflight `assertSchemaCompatible`，见 database-design.md §7 与 §9.7），无版本化迁移、无备份恢复、无 SQLite→PG 数据迁移、无 JSONL 自动对账；RC 旧库删除重建仍是允许的心智（§2.1 切换窗口内继续有效）。
>
> **Phase 3 未开始**：本文档全部内容均为计划阶段产物，当前只写计划、不实施（§1.4）。
>
> 关联文档：[数据库设计](database-design.md)、[IAM 规划](identity-access-plan.md)、[PG 测试流程](postgres-podman-test.md)、[架构](architecture.md)、[需求基线](../needs.md)。

## 1. 目的、范围与不实施内容

### 1.1 目的

在**开始保留真实用户数据之前**，把「数据保留」的地基立起来，使服务从「RC 可随时删库重建」平稳过渡到「数据不可重建、必须可迁移可恢复」：

- 建立正式 migration 机制（替代 RC 的删库重建）与启动迁移门禁；
- 建立备份 / 恢复 / 恢复演练机制，覆盖 JSONL 与 DB 双存储；
- 规划 JSONL/DB 双存储的数据生命周期（对账、清理、隔离）；
- 作为 IAM（Phase 3.1）落地的**进入条件**：明确 IAM 表真正上线前必须完成的基建（对应 identity-access-plan.md 工作包 0 的 migration / backup / rollback 前置）。

### 1.2 范围

- **Phase 3.0（数据保留基础）**：迁移引擎、（最终 reset）切换、备份恢复、JSONL/DB 生命周期、运维门禁。
- **Phase 3.1（IAM 前置路线）**：仅指 IAM 落地所需的数据与基建就绪门槛（identity-access-plan.md 工作包 0 的「数据策略决策 + 正式 migration / 备份 / 回滚」）。本文**不**设计或实施任何 IAM 功能（用户/token/角色/审计表、OIDC、API Key 等全部不在本计划实施范围内）。
- 与既有文档的关系：本文承接已完成的 Phase 2 存储基础，是 IAM 规划的进入条件；能力级交付不在此范围。

### 1.3 当前状态基线

| 维度 | 状态 |
| --- | --- |
| Phase 2（Manifest 单一来源 + SQLite/PG 双库） | ✅ 已完成，`verify:release`（真实 PG）全量 54 文件 / 563 用例 + 45 个 PG 门控用例全部通过 |
| 正式 migration | ❌ 无（RC 无 `kysely_migration` 或任何版本化迁移机制，旧库删库重建） |
| 备份 / 回滚 | ❌ 无（无备份任务、无恢复流程、无回滚机制） |
| JSONL/DB 数据生命周期 | ❌ 无自动对账（仅有固定的写入顺序与残余边界，见 database-design.md §2；无 outbox / reconcile / quarantine） |
| SQLite→PG 数据迁移 | ❌ 无（PG 仅要求空库可 bootstrap） |
| Phase 3 | ⬜ 未开始（本文档为计划产物，零实现） |

### 1.4 明确不实施的内容（本计划阶段）

本计划阶段**不做任何代码、数据或文档状态变更**，包括但不限于：

- 不实现任何迁移引擎，不改 `src/storage/*`（`schema-manifest.ts` / `schema-types.ts` / `bootstrap.ts` / `postgres-bootstrap.ts` / `schema-builder.ts` / `schema-compatibility.ts` 及 Repository）和任何生产代码/测试；
- 不编写备份脚本、不执行备份或恢复演练、不部署任何备份任务；
- 不实现 JSONL/DB 对账、outbox、逻辑删除队列、quarantine 等任何生命周期代码；
- 不新增用户/token/角色/审计等 IAM 表，不实施 IAM 功能（只定义进入条件）；
- 不执行任何 destructive reset（含不做真实库的删库重建）；本阶段仅允许在文档中定义切换窗口与切换动作；
- **不修改 README**：当前实现未落地，README 的「无正式 migration / backup / rollback」现状描述仍然准确（见 §10）。

## 2. 已确认决策表

用户已确认以下决策，作为本计划的前提：

| # | 决策 | 已确认内容 |
| --- | --- | --- |
| 1 | 数据保留起点 | **当前 RC 数据不保留；切换时执行一次最终 reset 基线（DB + JSONL 全清空），不做 Baseline Adoption** |
| 2 | 备份方向 | **每日完整备份 + 每次 migration 前强制备份 + 定期恢复演练** |
| 3 | 部署形态 | **当前按单实例运行；设计必须预留未来多实例改造路径** |
| 4 | 阶段属性 | **当前只要计划，不实施**（见 §1.4） |
| 5 | Migration 引擎选型 | **采用自定义 Manifest-driven migration 引擎（候选 B），不采用 Kysely Migrator（候选 A）**——详见 §3 |

### 2.1 决策 1：当前数据 reset 的含义与切换窗口

- **reset 的含义**：一次性清空 DB（删库重建或清空全部 managed 表）**并**清空 JSONL 会话目录（含 `agentDir` 下 Pi 会话文件），随后从空库经迁移引擎重新建立基线。由于 RC 数据无保留义务，本次清空**不迁移旧数据、不把既有 RC 文件标记为有效会话**——即明确**不做 Baseline Adoption**（不采纳既有 RC 库/文件为基线，避免脏数据迁移成本与双存储一致性风险）。
- **切换窗口**：从「当前（Phase 2 完成）」到「WP2 最终 reset 切换完成」之间的时间区间。
  - **窗口内**：RC 数据随时可丢弃，旧库删除重建仍是允许的（database-design.md §7 的 RC 心智继续有效）；任何破坏性 reset 不违反任何数据承诺。
  - **切换动作（WP2）**：执行最后一次 reset（DB + JSONL 全清空）→ 空库经迁移引擎建立基线 → 立即做**基线备份** → 此后**进入数据保留承诺**：冻结 destructive reset，schema 演进只走 migration，业务删除只走生命周期策略，意外丢失/损坏只靠备份恢复。
- **前置保障**：切换必须在 WP1（迁移引擎）与 WP3（备份恢复）就绪之后执行——「开始保留数据」必须先有兜底（见 §8.2 依赖链）。

### 2.2 决策 2：备份策略

- **已确认方向**：每日完整备份；每次 migration 前强制备份；定期恢复演练。「每日完整备份」即当前承诺粒度（增量/差异备份留给未来，不承诺）。
- **未确认（待决策，见 §9）**：RPO/RTO 取值、加密/KMS 选型、备份介质、强制备份的形态（自动触发 vs 运维 checklist）等细节。
- 对齐 needs.md §6.4：JSONL 不可重建，须与 DB 业务元数据（owner 映射、凭证元数据、Job 状态）同等或更高优先级对待；备份介质与生产磁盘分离；备份须加密、受访问控制，并定期恢复演练校验。

### 2.3 决策 3：单实例 / 多实例约束

- **当前**：按单实例运行。SQLite（`DatabaseSync` + WAL 单写者 + `busy_timeout`）+ 进程内单线程事件循环 → 进程内天然串行；**SQLite 形态仅支持单实例**，多实例共享同一 SQLite 文件会导致竞态/损坏（架构现状见 [architecture.md](architecture.md) 一.4）。
- **设计预留**（当前不实现）：存储访问已通过 Port/Repository 抽象、Repository 已方言中立（SQLite/PG 共用，见 database-design.md §9.5）；迁移锁按可替换实现设计（单实例进程内实现，PG advisory lock 为多实例形态，见 §4.3）；备份恢复以「介质/实例无关」为原则（恢复目标可以是新实例）。多实例改造路径见 §7。

### 2.4 决策 4：本阶段仅计划

本计划只产出文档（本文件 + 三处同步链接），不产生任何实现、数据变更或破坏性操作。

## 3. Migration 引擎选型决策记录（已确认）

> 本节是**决策记录（ADR）**：列出候选、确认依据与适用情形。**决策已确认：采用自定义 Manifest-driven migration 引擎（候选 B），不采用 Kysely Migrator（候选 A）**——选型已拍板，不再处于推荐/待确认状态；但引擎本身尚未实现（见 §1.4 与 §8.1 WP1）。

### 3.1 候选

| 候选 | 方案 | 关键特征 |
| --- | --- | --- |
| A | Kysely Migrator | Kysely 自带迁移能力（`Migrator` + `MigrationProvider`），维护迁移表记录已应用版本，支持 up/down，跨 SQLite/PG/MySQL 方言；schema 历史完全由迁移脚本文件驱动 |
| B | 自定义 Manifest-driven migration 引擎 | 以既有运行时 Schema Manifest（`src/storage/schema-manifest.ts`）为中心，按「版本链 + manifest head」管理迁移；每个版本携带双方言迁移脚本 + checksum；与启动门禁 / 严格 preflight 深度集成 |

### 3.2 选择 B（自定义 Manifest-driven）的三个理由

1. **Manifest 单一来源**：项目已把 schema 唯一手工来源收敛到 `schemaManifest`（编译期 + 运行期双校验、`DatabaseSchema` 自动推导、bootstrap 只做方言映射，见 database-design.md §1/§2）。Kysely Migrator 的迁移 DDL 手写于迁移文件中，会在 Manifest 之外引入**第二份 schema 事实**，重启漂移风险与双维护成本；自定义引擎以 Manifest 为 head 真相，迁移只表达「版本间增量」，并在启动时以 Manifest 校验库状态（版本链 + 物理契约）。
2. **SQLite 事务/锁与方言限制**：SQLite 的 DDL 能力有限（`ALTER TABLE` 受限、事务性 DDL 有坑）、同一时刻只有一个写者（WAL + busy timeout），迁移必须在启动门禁中持锁、按序、在受控事务内执行并处理失败态。Kysely Migrator 偏向常规事务数据库的约定式流程，对 SQLite 的 DDL 限制、锁语义和本项目「启动即迁移、失败即拒绝启动」的门禁没有内置支持，仍需自研封装——选 B 直接把控制权放在需要的位置。
3. **现有 schema compatibility 复用**：Phase 2 已建成 `assertSchemaCompatible` 严格 preflight（SQLite PRAGMA / PG information_schema，在任何 DDL 之前执行，双库契约测试，即 M1，见 database-design.md §7/§9.7）。自定义引擎可直接复用该契约做启动时 preflight + 版本头校验（空库 bootstrap / 完整一致跳过 / 不一致 fail-fast），并处理「既有 RC 未迁移库」的基线判定；Kysely Migrator 无此集成点，兼容判断需另起炉灶。

### 3.3 Kysely Migrator 的适用情形

- 从零开始、以迁移脚本为 schema 唯一历史、无 Manifest 中心的项目；
- 需要框架提供的 up/down 现成能力、团队偏好约定式现成组件；
- schema 演进以「脚本文件」而非「运行时声明」为真相，且不需要与既有严格 preflight / 双库契约深度集成；
- 若后续自定义引擎被判定过度工程（成本/复杂度不可控），Kysely Migrator 是明确备选（fallback），届时在 WP0 决策记录中说明。

### 3.4 状态

- **已确认：选型 B（自定义 Manifest-driven migration 引擎）**。引擎选型已拍板，不再属于待决策项；WP0 中该条目已关闭。引擎实现仍待 WP1 落地（见 §8.1）。

## 4. 目标架构：迁移与版本管理

> 本节描述 WP1 的目标设计（均为计划，未实现）：引擎形态为 §3 已确认的自定义 Manifest-driven 引擎。

### 4.1 version ledger

- 新增 ledger 表（如 `schema_migrations`）：`version`（整数、唯一升序）、`name`、`checksum`、`applied_at`；与业务表同库，写入与迁移 DDL 在同一事务内完成。
- 迁移清单（migration manifest）为有序数组：每项 = `{ version, name, migrations（SQLite / PG 各自 DDL 或同一脚本双方言执行）, checksum }`；head version = 清单内最大版本。清单本身纳入审计与不可变约束（§4.7）。

### 4.2 checksum

- 每个已发布 migration 必须有稳定校验和（内容即代码）；启动时对 ledger 中已应用版本逐条校验，任一不符 → fail-fast（防篡改、防本地修改后伪装成已发布）。
- checksum 计算对象与「分方言校验 or 统一校验」的细节在 WP1 设计时确定；本篇只定方向：已应用 migration 的校验与篡改检测必须存在。

### 4.3 migration lock

- 单实例：进程内互斥 + SQLite 写锁语义（WAL 单写者 + busy timeout），保证同一时刻只有一个迁移执行者。
- 预留多实例：锁抽象按可替换实现设计，PG 形态 = advisory lock（`pg_advisory_lock`）或 ledger 行锁（见 §7）。

### 4.4 版本快照 / manifest head 校验

- 启动时序（在任何业务可用之前）：读 ledger 当前版本 vs manifest head：
  - **空库**（无 ledger 且无业务表）→ 依序应用全部迁移（等效于建立最新基线）；
  - **版本 < head** → 依序应用未应用迁移（升级）；
  - **版本 > head** → fail-fast，禁止在「未来版本」库上运行当前代码（禁止降级）；
  - **版本 = head 但 checksum 不符** → fail-fast。
- **既有 RC 未迁移库**（无 ledger 但有业务表）：先跑 `assertSchemaCompatible` preflight——物理契约一致 → 打基线版本（写入 ledger，数据保留）；不一致 → fail-fast，不自动改库（与既有 M1 语义一致，见 database-design.md §7/§9.7）。

### 4.5 SQLite / PG 事务

- 迁移在事务内执行（SQLite 注意 DDL 事务性与 `PRAGMA` 语义，PG 用显式事务）；失败回滚并使 ledger 保持一致；迁移失败即启动失败（§4.6），不做部分迁移。

### 4.6 启动时迁移门禁

- 迁移与校验发生在服务监听之前，失败 → **拒绝启动**（fail-fast），绝不静默降级、跳过迁移继续服务。
- 与备份门禁联动：检测到有待应用迁移时，按 §2.2「每次 migration 前强制备份」要求确保最近备份存在（自动触发备份或要求运维确认，形态在 WP0/WP3 确定）。
- 迁移过程写审计日志（版本、checksum、耗时、结果）。

### 4.7 migration 不可变

- 已发布（已应用或已合并到基线）的 migration **不得修改**；任何 schema 变更只能新增后续版本。配合 §4.2 checksum 强制，防止「改了历史再伪装升级」。

### 4.8 生产回滚：靠备份恢复，不靠自动 down

- 引擎**不提供自动 down / 自动回滚**：DB 与 JSONL 是双存储、非单事务（database-design.md §2），DB 事务回滚无法联合还原 JSONL，自动 down 会破坏数据一致性承诺。
- 回滚流程 = 停服 → 从最近完整备份恢复（DB 快照 + JSONL 对齐，见 §6）→ 启动门禁重新校验（ledger 与 manifest 版本重对齐）→ 验证 → 恢复服务。
- 恢复演练（WP3）必须覆盖「迁移出错后的回滚」，保证该流程可用。

## 5. JSONL / DB 双存储数据生命周期（计划，未实现）

> 现状：写入顺序已固定（先建 DB 记录 → 创建 JSONL → 回写路径；删除先逻辑删 → 清 runtime → 删物理文件），但**无自动对账**：删除文件失败会留物理残留、回写中断留残余边界（database-design.md §2）。以下为本计划的目标机制，**全部未实现**。

### 5.1 一致性模型与 outbox

- 双存储非单事务；跨存储操作（建会话 + 建 JSONL + 回写路径、删会话 + 删文件）需要**崩溃后可补偿**的持久化记录。
- 目标：持久化 outbox（写前/写后状态记录 + 状态标记），服务重启或定时补偿任务据此补齐/修复残留操作，避免重复执行副作用（对齐 needs.md §4.1「启动时对账修复孤儿 JSONL 与无 owner 会话…跨存储非原子写入用状态标记避免重复任务」）。

### 5.2 逻辑删除与持久化待删队列

- 删除仍先逻辑删（DB 对外不可见）→ 异步物理清理 JSONL；清理动作进持久化队列（幂等 + 重试，对齐现有 `requestId` 幂等与墓碑 TTL 的经验），失败入 quarantine（§5.5）而非静默丢弃。

### 5.3 reconcile（启动 / 定时对账）

- 启动与定期对账以下类别：
  - **orphan JSONL**：文件存在、DB 无引用（含回写中断残留 `pi_session_file = null` 但物理文件已存在的场景）；
  - **lost-file**：DB 有 `pi_session_file` 但文件缺失（历史不可恢复）；
  - 无 owner / 悬空引用等其他异常。
- 处置原则：可安全修复的自动修复；不可判定或涉及不可重建内容的入 quarantine（§5.5），**禁止自动删除**。

### 5.4 orphan / lost-file 处置

- orphan：先隔离评估（可能曾是崩溃前的有效会话），确认后按保留策略处理；
- lost-file：不可重建——记录审计 + DB 索引标记缺失状态，不静默删除索引；
- 处置均需审计且保留期与审计策略对齐（§9 待决策项 4）。

### 5.5 quarantine

- 异常 / 不可判定文件入隔离区（隔离目录或隔离状态），人工复核；quarantine 内容**同样受备份与访问控制约束**，不因隔离而免于备份。

### 5.6 明确

- 本节全部为目标设计，当前**均未实现**；实现归属 WP4；在 WP4 落地前，现有残余边界（database-design.md §2）仍是人工/降级处理状态。

## 6. 备份与恢复

### 6.1 备份内容与一致性

- 备份集 = **DB 快照 + JSONL 会话目录**（双存储必须一起备份：任一侧缺失都会导致会话不完整；JSONL 不可重建，DB 业务元数据不可重建）。
- 双存储非原子，备份需要「对齐点」设计（先 DB 快照再 JSONL 快照，或接受小窗口由 reconcile 兜底）——WP3 设计要点。
- 介质与生产磁盘分离（needs.md §6.4/§6.6）；至少三项卷隔离（日志 / JSONL / DB）前提下备份落独立介质。

### 6.2 SQLite：VACUUM INTO + JSONL

- 用 `VACUUM INTO` 生成**一致性快照文件**（避免直接拷贝文件在 WAL 下的不一致）；JSONL 目录做点快照（归档/同步到备份介质）。
- 日常形态：每日完整备份（§2.2 已确认方向；增量/差异留给未来，不承诺）。

### 6.3 PostgreSQL：pg_dump + JSONL

- `pg_dump`（事务一致性）+ JSONL 目录快照；文件级 `pg_basebackup` 为更高成本备选，不承诺。
- 与 §6.2 相同的对齐点设计。

### 6.4 恢复演练

- 定期（频率待定，建议每季度 + 每次重大 migration 前）在隔离/临时实例执行：加载备份 → 启动门禁（preflight + ledger 校验）→ 抽查会话数据完整性 → 产出演练报告。
- 备份「有效」的唯一证明是恢复演练通过；演练同样覆盖 §4.8 的迁移出错回滚。

### 6.5 RPO / RTO（待定）

- 每日完整备份对应的最大数据丢失窗口是 RPO 上限的参考，但**具体取值未定**（§9 待决策项 2），本计划不编造数字；RTO 由演练实测的恢复时长决定。

### 6.6 加密 / KMS / 权限（待定）

- 方向：备份必须加密（at-rest）、受访问控制、与生产密钥分离管理；选型（KMS、介质策略）待决策（§9 待决策项 3）。

### 6.7 凭证不进入备份

- 凭证（模型/钉钉/Git 等 API key、OAuth token）不落库明文，来自环境变量 / KMS / `PI_AUTH_PATH` 独立凭证文件（needs.md §7），故备份集**天然不含明文凭证**；备份介质访问权限按 secrets 权限基线控制，并在恢复演练中校验「恢复后的环境不含旧凭证」。

## 7. 单实例到多实例路径（当前不实现）

- **当前约束**：SQLite 形态仅支持单实例（WAL 单写者 + busy timeout，多实例共享同一 SQLite 文件会竞态/损坏，见 architecture.md 一.4）；单实例下 JSONL 在本地盘、SSE 事件在进程内总线，均为单进程假设。
- **多实例所需（未来）**：
  - 共享 DB：PostgreSQL（替换 SQLite；Repository 已方言中立，见 database-design.md §9.5）；
  - 会话历史：JSONL 从本地盘迁移到共享 / 对象存储（含版本管理）；
  - migration lock：PG advisory lock / ledger 行锁（§4.3 预留接口）；
  - 会话任务 / 事件协调：会话级租约/心跳、Worker Job 队列消费协调（needs.md §4.1 的 Worker 租约/心跳已规划）、SSE 跨实例路由或会话亲和性。
- **当前不实现**：多实例只在明确需求出现后启动（列入 §9 待决策项 5），且必须先完成 WP1/WP3（迁移 + 备份）；设计预留点已列于 §2.3。

## 8. 工作包、依赖、验收与回滚点

### 8.1 工作包列表

| WP | 名称 | 内容 | 依赖 | 验收 | 回滚点 |
| --- | --- | --- | --- | --- | --- |
| WP0 | 决策冻结 | 冻结数据保留起点与切换窗口；migration 引擎最终选型（§3，已确认：Manifest-driven）；备份参数（频率/保留/介质）；RPO/RTO 初值；加密/KMS 选型；数据删除与审计保留期；静态 token 退场节奏 | 无（纯文档） | 各项决策书面确认并更新本文档与 IAM 待决策项；零代码/零数据变更 | 纯决策，无回滚需求 |
| WP1 | 迁移引擎 | §4 目标架构：ledger / checksum / lock / manifest head 校验 / 双库事务 / 启动门禁 / immutable 约束；与 `assertSchemaCompatible` 集成；迁移前强制备份联动 | WP0 | 单测 + 集成：空库迁移、滞后库升级、超前库 fail-fast、checksum 篡改 fail-fast、事务回滚、双库契约、既有 RC 未迁移库基线判定；`pnpm verify` 全绿 | 未切换时撤回代码即可；已切换后靠备份恢复 |
| WP2 | 最终 reset 切换 | 最后一次 reset（DB + JSONL 全清空）流程/脚本/checklist；空库迁移建基线 + 立即基线备份；此后冻结 destructive reset；切换记录写入决策文档 | WP1 + WP3 就绪 | 切换后空库基线可启动、全量测试通过、基线备份存在；切换后无任何 destructive reset 路径 | 切换前可随时重来（RC 心智）；切换后只可恢复备份，不可回滚 |
| WP3 | 备份恢复 | §6：SQLite VACUUM INTO + JSONL、PG pg_dump + JSONL、迁移前强制备份、恢复流程与演练、备份完整性校验、凭证不进入备份 | WP0（可与 WP1 部分并行） | 至少一次成功恢复演练（含迁移出错回滚）；备份文件校验通过；强制备份在迁移门禁生效 | 演练在隔离环境执行，生产无风险 |
| WP4 | JSONL 生命周期 | §5：outbox、逻辑删除/待删队列、reconcile、orphan/lost-file 处置、quarantine | WP1 | 崩溃补偿测试（中断回写 → 重启对账修复）；删除幂等；异常文件入 quarantine 而非自动删除；审计记录齐全 | 对账/清理逻辑可开关；异常文件不进自动删除 |
| WP5 | 运维门禁 | 启动迁移门禁 fail-fast；备份缺失/过期告警（对齐 needs.md §6.6 分级阈值）；审计保留衔接；恢复演练节奏化 | WP1、WP3 | 故障注入测试（坏库/滞后库/缺备份 → 拒绝启动或告警）；门禁与告警清单落文档 | 门禁规则配置化，可降级为告警（需决策） |
| WP6 | IAM 进入条件 | 确认 IAM（identity-access-plan.md 工作包 0–5）数据落地门槛 = WP1–5 全部通过；在此之前 IAM 仅做设计（schema decision、待决策项），不落地真实表/迁移 | WP1–5 全部通过 | WP1–5 各自验收全绿；触发 IAM 启动评审并记录决策 | IAM 未开始，无回滚 |

### 8.2 依赖链

```text
WP0 决策冻结
 └─→ WP1 迁移引擎 ──→ WP3 备份恢复 ──→ WP2 最终 reset 切换（== 数据保留起点）
     └─→ WP4 JSONL 生命周期 ─┐
     └─→ WP5 运维门禁 ───────┴─→ WP6 IAM 进入条件（仅当 WP1–5 全部通过）
```

- **关键门槛**：只有 WP1–5 全部通过，才能进入 WP6（IAM 数据落地）——对应 identity-access-plan.md 工作包 0 的「数据策略决策 + 正式 migration / 备份 / 回滚」前置。
- WP4/WP5 依赖 WP1，可与 WP3 交错；**WP2 必须在 WP1 + WP3 就绪后执行**（原因见 §2.1：开始保留数据必须先有迁移与备份兜底）。

### 8.3 回滚点原则

- **切换前**：任何工作包缺陷可「撤代码 + 重来」（RC 数据无保留义务，仍有 reset 兜底）；
- **切换后**：唯一回滚手段是备份恢复（§4.8 / §6.4），每个 WP 交付即打一份基线备份；
- **IAM 之前**：WP6 只是门槛确认，不引入新的回滚面。

## 9. 待决策项清单（TBD）

以下条目**尚未决定**，决策前不得在实现中隐含默认值：

| # | 待决策项 | 影响面 | 当前状态 |
| --- | --- | --- | --- |
| 1 | ~~migration 引擎最终选型~~ | ~~WP0/WP1~~ | **已决策（§3）：采用自定义 Manifest-driven 引擎；Kysely Migrator 不选** |
| 2 | RPO / RTO 取值 | WP3 | 未定（每日全量备份为方向，数值未定） |
| 3 | 加密 / KMS / 备份介质访问控制选型 | WP3 | 方向已确认（必须加密、凭证不进入备份），具体选型未定 |
| 4 | 数据删除与审计保留：会话 TTL 归档/删除参数（needs.md §6.4 的 N/M 天数）、审计保留期、quarantine 保留期 | WP4/WP5 | 未定 |
| 5 | 多实例 / 共享存储：何时启动、PG + 对象存储形态、会话亲和策略 | 未来（§7） | 未定（当前不实现） |
| 6 | 静态 token 退场：迁移窗口、强制切换 deadline | IAM WP1（见 identity-access-plan.md §8 待决策项 7） | 未定 |

决策流程：每项决策须在对应工作包落地前书面记录（更新本文档与相关设计文档），并附验收口径（对齐 identity-access-plan.md §8 的约定）。

## 10. 相关文档

- 数据库设计与 Schema Manifest 约束：[database-design.md](database-design.md)
- IAM 规划（本计划 Phase 3.1 的承接方）：[identity-access-plan.md](identity-access-plan.md)
- 本地 PostgreSQL 测试流程：[postgres-podman-test.md](postgres-podman-test.md)
- 架构速览（单实例并发模型、SQLite 锁语义、目录/端口边界）：[architecture.md](architecture.md)
- 平台需求基线（交付计划、备份/保留/审计要求、存储分卷与容量治理）：[../needs.md](../needs.md)
- 对外状态与限制：[../README.md](../README.md) / [../README.zh-CN.md](../README.zh-CN.md)（Security & Limitations：本计划落地实现前，「无正式 migration / backup / rollback」描述保持准确，不修改）