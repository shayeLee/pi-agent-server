# Phase 3 数据保留计划：Phase 3.0 数据保留基础 + Phase 3.1 IAM 前置路线

> 本文是 Phase 3 的可独立阅读**计划**文档，仅记录已确认决策、推荐方案、目标架构与工作包划分，**不是实现承诺**；除 §2 标注「已确认」的条目外，其余均为计划/推荐/待定，未拍板、未实现。
>
> **Phase 2 历史基线（当时门禁，如实分账）**：Phase 2 已全部完成并通过当时的最终发布门禁——`volta run pnpm verify:release`（typecheck + test + test:postgres + build，设置真实 PG `PI_TEST_PG_URL`）全部通过：全量 `pnpm test` = 54 文件 / 563 用例、无 skip，`pnpm test:postgres` = 45 个 PG 门控用例真实执行且全部通过（见 [database-design.md](database-design.md) §9）。
>
> **RC 现状**：当前仍是 Release Candidate 阶段——**无服务级正式 migration / 备份 / 回滚**：bootstrap 仅面向空库/当前 v1 schema（`IF NOT EXISTS` + 严格 preflight `assertSchemaCompatible`，见 database-design.md §7 与 §9.7），离线 migration 与 WP3A/WP3B backup/restore 工具不接入服务，亦无 SQLite→PG 数据迁移、无 JSONL 自动对账；RC 旧库删除重建仍是允许的心智（§2.1 切换窗口内继续有效）。
>
> **Phase 3 当前状态**：WP0 决策冻结、WP1 离线迁移基础、WP3A SQLite 在线备份核心、WP3B1 SQLite restore drill、WP3B2 PG backup/restore 与 WP3C migration prebackup/runbook 基础实现已完成；真实 PG/age 只有在当前环境提供 URL/二进制并实际运行对应 gate 时才计为验收证据，没有这些前置条件不宣称通过。WP2A 受控 cutover 实现与 reviewer 复审修复已落地，但实际 reset 从未执行。WP4A（v1 migration + `file_operations` outbox + 删除事务）已依据用户提供的真实 PG16+age `verify:release` 成功证据验收通过。**WP4B（方案 A）✅ 已验收，但范围仅限安全只读 planner（`pnpm file-ops`）**：用户提供的真实 PG16+age `verify:release` 成功证据包含 file-ops planner gate 及 compiled/npm smoke；本文不记录或推导测试数量。**WP4C（方案 A 收敛）✅ 已验收**：安全 DB-only reconcile analyzer（`pnpm reconcile-jsonl`）已实现（只读 DB 引用 + 纯字符串规范布局绑定；固定 issue codes + opaque 引用；`--apply` fail-closed；不执行任何处置；**绝不扫描文件系统、不读取 JSONL，不能探测 orphan/lost/JSONL 损坏**）。用户提供的完整真实 PG16+age `verify:release` 成功证据包含真实 PG reconcile gate 及 compiled/npm smoke，WP4C 据此验收；本文不记录或推导测试数量。物理 executor（包括 unlink）、retry/quarantine 仍未实现，执行留给未来受审计的 native helper；正式常驻 worker 仍未接入，WP5/WP6 尚未开始。正式常驻服务仍未接入这些离线工具，整体仍非生产就绪。
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
| Phase 2（Manifest 单一来源 + SQLite/PG 双库） | ✅ 已完成；真实 PG 结果仅以当前环境实际运行 `PI_TEST_PG_URL` 门控为准 |
| 正式 migration | ⚠️ WP1 离线 Manifest-driven migration CLI + WP2A 可选严格启动门禁（`migrationGate="verify"`，只读校验、不自动迁移）；默认启动行为仍为 RC bootstrap，正式 migration 尚未成为默认启动路径 |
| 备份 / 回滚 | ✅ WP3A/WP3B1/WP3B2/WP3C 离线基础实现已完成；真实 PG/age gate 需当前环境实际提供前置条件并运行，未接入服务启动 |
| JSONL/DB 数据生命周期 | ✅ WP4A（v1 migration、`file_operations` 持久 outbox、删除事务）已验收；✅ WP4B（方案 A）安全只读 planner 已验收（`pnpm file-ops`：只读统计、`--apply` fail-closed）；✅ WP4C（方案 A 收敛）DB-only reconcile analyzer 已验收（`pnpm reconcile-jsonl`：只读 DB 引用 + 纯字符串规范布局绑定，固定 issue codes + opaque 引用，`--apply` fail-closed，不执行任何处置、绝不扫描文件系统，不能探测 orphan/lost/JSONL 损坏）；物理 executor（包括 unlink）、retry/quarantine 未实现，正式 worker/调度仍不存在 |
| SQLite→PG 数据迁移 | ❌ 无（PG 仅要求空库可 bootstrap） |
| Phase 3（WP0） | ✅ 已完成/已冻结（仅决策文档，零实现） |
| Phase 3 WP1 | ✅ 离线迁移核心已完成；真实 PG 验收需当前环境实际提供 URL 并运行门禁（未接入服务启动） |
| Phase 3 WP3A | ✅ SQLite 在线备份核心与显式 CLI 已完成；真实 age/PG release gate 需当前环境实际运行（不接入服务启动） |
| Phase 3（WP2 及以后） | 🟡 进行中（WP3 基础工作包已完成；WP2A 受控 cutover 实现与干净 SQLite 基线初始化已完成；当前目标无旧 RC 数据，破坏性 WP2B reset 不适用；WP4A、WP4B 方案 A 只读 planner 与 WP4C 方案 A 收敛 DB-only reconcile analyzer 均已验收，WP5/WP6 尚未开始，正式常驻服务未启用） |

### 1.4 明确不实施的内容（WP2B 及 WP3C 之外的后续工作包）

> **WP2A 状态修正（本次更新）**：原 §1.4 写明「不实现 WP2 reset」；该限制随用户对 WP2A 的明确授权解除：**WP2A 已交付受控 cutover 实现**（离线 CLI、严格授权链、pre-reset 加密备份、受控 reset、migration 建基线、严格 verify、脱敏报告、可选严格启动门禁、runbook、真实 age/PG 演练门禁），全部破坏性演练仅在临时目录与随机 `pi_cutover_*` schema 内进行。**对真实用户 SQLite/PG/JSONL 的破坏性 cutover 从未执行**；当前正式 SQLite 目标没有旧 RC 数据，已通过干净基线初始化替代该动作，因此不需要其目标授权。若未来其他目标存在待丢弃 RC 数据，实际 cutover 仍属禁止项，除非获得用户/运维对该目标的明确授权。reviewer 复审修复已落地并通过真实 PG16+age verify:release 门禁验收。

WP1、WP3A/WP3B1/WP3B2/WP3C 与 WP2A 的 cutover CLI 均为**离线开发期工具**，不自动接入 `startServer`（启动门禁为显式 opt-in，默认 off），不启动服务、不安装 scheduler/timer。已完成工作包的后续限制如下：

- 不执行真实用户数据 cutover/reset：实际切换需要用户/运维后续对目标的明确授权（[cutover-runbook.md](cutover-runbook.md)）；
- 不实现 WP4B 执行器/retry/quarantine、WP4C 自动处置/IAM/readiness；WP4A 已验收的 outbox 基础不包含这些后续能力；WP4C 仅交付安全 DB-only reconcile 分析（见 §5.8）；
- 不执行真实用户数据备份或恢复演练、不部署任何备份任务；
- 不实现 JSONL/DB 自动对账后的处置、自动清理 worker；WP4A 的持久 outbox、删除事务 enqueue 与 claim 预留已验收；**WP4B 仅交付安全只读 planner，物理执行器/retry/quarantine 未实施（见 §5.7）**；**WP4C 仅交付安全 DB-only reconcile analyzer（见 §5.8），不生成操作、不写入 outbox、不扫描文件系统**，对账后的自动处置与真实 filesystem reconcile 留给后续工作包/native helper；
- 不新增用户/token/角色/审计等 IAM 表，不实施 IAM 功能（只定义进入条件）；
- README 的“尚非生产就绪”边界保持不变：可说明 WP3（备份/恢复/pre-migration/runbook）基础工作包已完成且 WP2A 受控 cutover 工具已实现（真实 age/PG 演练门禁通过），当前 SQLite 目标的破坏性 cutover 不适用、正式启动迁移门禁默认关闭，不能宣称生产 backup/rollback 已完成或 Phase 3 整体已生产就绪（见 §10）。

## 2. 已确认决策表

用户已确认以下决策，作为本计划的前提：

| # | 决策 | 已确认内容 |
| --- | --- | --- |
| 1 | 数据保留起点 | **当前 RC 数据不保留；切换时执行一次最终 reset 基线（DB + JSONL 全清空），不做 Baseline Adoption** |
| 2 | 备份方向与执行时机 | **每日完整备份 + 每次 migration 前强制备份 + 定期恢复演练；每日备份在线执行，不要求每日停服务** |
| 3 | 部署形态 | **当前按单实例运行；设计必须预留未来多实例改造路径** |
| 4 | 阶段属性 | WP0 为计划/决策冻结；WP1、WP3A 与 WP3B1 仅实施离线工具，不接入服务启动；WP2、WP3B 后续及以后仍按计划执行（见 §1.4） |
| 5 | Migration 引擎选型 | **采用自定义 Manifest-driven migration 引擎（候选 B），不采用 Kysely Migrator（候选 A）**——详见 §3 |
| 6 | 备份加密与初始存储 | **正式采用 age 公钥加密；备份先存本机绝对目录**；具体备份根路径、age recipient 与私钥托管仍待定 |
| 7 | Migration 前置门禁 | **每次 migration 前必须严格停服务，并强制执行 pre-migration backup**；当前没有全局写冻结，不能以写冻结替代停服 |

### 2.1 决策 1：当前数据 reset 的含义与切换窗口

- **reset 的含义**：一次性清空 DB（删库重建或清空全部 managed 表）**并**清空 JSONL 会话目录（含 `agentDir` 下 Pi 会话文件），随后从空库经迁移引擎重新建立基线。由于 RC 数据无保留义务，本次清空**不迁移旧数据、不把既有 RC 文件标记为有效会话**——即明确**不做 Baseline Adoption**（不采纳既有 RC 库/文件为基线，避免脏数据迁移成本与双存储一致性风险）。
- **切换窗口**：从「当前（Phase 2 完成）」到「WP2 最终 reset 切换完成」之间的时间区间。
  - **窗口内**：RC 数据随时可丢弃，旧库删除重建仍是允许的（database-design.md §7 的 RC 心智继续有效）；任何破坏性 reset 不违反任何数据承诺。
  - **切换动作（WP2）**：若目标存在旧 RC 数据，执行最后一次 reset（DB + JSONL 全清空）→ 空库经迁移引擎建立基线 → 立即做**基线备份**；若目标为空，则以同一迁移与备份流程直接建立干净基线。当前正式 SQLite 目标属于后者，已完成空库 pre-migration 加密备份、v1 migration apply 与 strict verify，未发生破坏性 reset。开始保留真实用户数据后，冻结 destructive reset，schema 演进只走 migration，业务删除只走生命周期策略，意外丢失/损坏只靠备份恢复。
- **前置保障**：切换必须在 WP1（迁移引擎）与 WP3（备份恢复）就绪之后执行——「开始保留数据」必须先有兜底（见 §8.2 依赖链）。

### 2.2 决策 2：备份策略

- **已确认方向**：每日完整备份；每日备份在线执行，**不要求每日停服务**；每次 migration 前强制备份；定期恢复演练。「每日完整备份」即当前承诺粒度（增量/差异备份留给未来，不承诺）。
- **migration 前置**：每次 migration 前必须先严格停服务，再执行强制 pre-migration backup；当前没有全局写冻结，因此停服务不可由写冻结标记或其他软门禁替代。只有备份完成并通过完整性复核后才允许继续 migration。
- **已确认加密与初始存储**：正式采用 age 公钥加密，备份先存本机绝对目录；具体备份根路径、age recipient、私钥托管以及访问控制细节仍待决策（见 §9）。
- 对齐 needs.md §6.4：JSONL 不可重建，须与 DB 业务元数据（owner 映射、凭证元数据、Job 状态）同等或更高优先级对待；备份须受访问控制，并定期恢复演练校验。最终是否独立挂载/介质隔离仍需结合备份根路径决策，当前不预设已完成介质分离。

### 2.3 决策 3：单实例 / 多实例约束

- **当前**：按单实例运行。SQLite（`DatabaseSync` + WAL 单写者 + `busy_timeout`）+ 进程内单线程事件循环 → 进程内天然串行；**SQLite 形态仅支持单实例**，多实例共享同一 SQLite 文件会导致竞态/损坏（架构现状见 [architecture.md](architecture.md) 一.4）。
- **设计预留**（当前不实现）：存储访问已通过 Port/Repository 抽象、Repository 已方言中立（SQLite/PG 共用，见 database-design.md §9.5）；迁移锁按可替换实现设计（单实例进程内实现，PG advisory lock 为多实例形态，见 §4.3）；备份恢复以「介质/实例无关」为原则（恢复目标可以是新实例）。多实例改造路径见 §7。

### 2.4 决策 4：本阶段仅计划

WP0 只产出决策冻结 ADR 与本文档状态同步；WP1 离线核心、WP3A 备份核心、WP3B1 SQLite restore drill、WP3B2 PG backup/restore 与 WP3C migration prebackup/runbook 已完成并通过各自验收；WP3B2 的真实 PG16 `pg_dump` → age → `pg_restore` gate 已通过，WP3C 通过真实 PG+age `verify:release` 全量通过及 `test:migration-prebackup` 独立门禁通过；WP3 基础工作包已完成；工具均不自动接入服务启动（WP2A 起含显式 opt-in 的只读启动门禁，默认 off）；WP2A cutover 实现已完成并通过真实 age/PG 演练门禁，但**实际 reset 从未执行**。

## 3. Migration 引擎选型决策记录（已确认）

> 本节是**决策记录（ADR）**：列出候选、确认依据与适用情形。**决策已确认：采用自定义 Manifest-driven migration 引擎（候选 B），不采用 Kysely Migrator（候选 A）**——选型已拍板；WP1 离线核心已完成并通过真实 PG 验收，未接入服务启动。

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
- 若后续自定义引擎被判定过度工程（成本/复杂度不可控），Kysely Migrator 是明确备选（fallback），届时在后续决策记录中说明。

### 3.4 状态

- **已确认：选型 B（自定义 Manifest-driven migration 引擎）**。引擎选型已拍板，不再属于待决策项；WP0 中该条目已关闭。WP1 离线核心已完成并通过真实 PG 验收（见 §8.1）。

## 4. 目标架构：迁移与版本管理

> 本节描述 WP1 已完成的离线核心边界：引擎形态为 §3 已确认的自定义 Manifest-driven 引擎；正常服务启动接入、备份联动等仍属后续工作包。

### 4.1 version ledger

- 新增 ledger 表（如 `schema_migrations`）：`version`（整数、唯一升序）、`name`、`checksum`、`applied_at`；与业务表同库，写入与迁移 DDL 在同一事务内完成。
- 迁移清单（migration manifest）为有序数组：每项 = `{ version, name, migrations（SQLite / PG 各自 DDL 或同一脚本双方言执行）, checksum }`；head version = 清单内最大版本。清单本身纳入审计与不可变约束（§4.7）。

### 4.2 checksum

- 每个已发布 migration 必须有稳定校验和（内容即代码）；启动时对 ledger 中已应用版本逐条校验，任一不符 → fail-fast（防篡改、防本地修改后伪装成已发布）。
- WP1 已补齐稳定 canonical serialization；checksum 覆盖版本/name、Manifest、双方言物理类型映射、DDL/operation format 及显式数据变换 descriptor；SQLite/PG 共用同一 checksum，已应用 migration checksum 改变即 fail-fast。

### 4.3 migration lock

- 单实例：进程内互斥 + SQLite 写锁语义（WAL 单写者 + busy timeout），保证同一时刻只有一个迁移执行者。
- 预留多实例：锁抽象按可替换实现设计，PG 形态 = advisory lock（`pg_advisory_lock`）或 ledger 行锁（见 §7）。

### 4.4 版本快照 / manifest head 校验

- 离线 CLI 时序（当前不接入服务启动）：读 ledger 当前版本 vs manifest head：
  - **空库**（无 ledger 且无业务表）→ 依序应用全部迁移（等效于建立最新基线）；
  - **版本 < head** → 依序应用未应用迁移（升级）；
  - **版本 > head** → fail-fast，禁止在「未来版本」库上运行当前代码（禁止降级）；
  - **版本 = head 但 checksum 不符** → fail-fast。
- **既有 RC 未迁移库**（无 ledger 但有业务表）：无论物理契约是否一致，均明确拒绝自动 baseline adoption，返回「需要受控 reset/adopt」；不写/改 DDL、不删除数据。当前 D1 仍要求由后续切换流程显式处理。

### 4.5 SQLite / PG 事务

- WP1 迁移在事务内执行：SQLite 使用显式 raw connection `BEGIN IMMEDIATE`，PG 使用 advisory lock 所在的显式 transaction；失败回滚并使 ledger 保持一致，不做部分迁移。

### 4.6 启动时迁移门禁（后续 WP5，不在 WP1）

- 目标行为：迁移与校验发生在服务监听之前，失败 → **拒绝启动**（fail-fast），绝不静默降级、跳过迁移继续服务；WP1 不实现此接入。
- 已确认的 migration 前置顺序：严格停服务 → 强制 pre-migration backup → 备份完整性复核通过 → 执行 migration；当前没有全局写冻结，停服务是强制要求。WP1 不实现启动门禁或备份联动；备份前置与正常服务启动接入留给 WP3/WP5。
- WP1 离线 CLI 已输出版本/checksum；源码开发使用 `pnpm migrate`，发布构建同时产出 `dist-migrate/scripts/migrate.js` 与 `pi-agent-server-migrate`，迁移审计日志与服务启动门禁留给后续 WP5。

### 4.7 migration 不可变

- 已发布（已应用或已合并到基线）的 migration **不得修改**；任何 schema 变更只能新增后续版本。配合 §4.2 checksum 强制，防止「改了历史再伪装升级」。

### 4.8 生产回滚：靠备份恢复，不靠自动 down

- 引擎**不提供自动 down / 自动回滚**：DB 与 JSONL 是双存储、非单事务（database-design.md §2），DB 事务回滚无法联合还原 JSONL，自动 down 会破坏数据一致性承诺。
- 回滚流程 = 停服 → 从最近完整备份恢复（DB 快照 + JSONL 对齐，见 §6）→ 启动门禁重新校验（ledger 与 manifest 版本重对齐）→ 验证 → 恢复服务。
- 恢复演练（WP3）必须覆盖「迁移出错后的回滚」，保证该流程可用。

## 5. JSONL / DB 双存储数据生命周期（WP4A、WP4B 方案 A 只读 planner 与 WP4C 方案 A 收敛 DB-only reconcile analyzer 均已验收）

> WP4A（v1 migration + `file_operations` outbox + 删除事务）已依据用户提供的真实 PG16+age `verify:release` 成功证据验收通过：删除事务内 enqueue，DELETE 请求只清理 runtime、绝不 unlink；相对路径白名单、状态机、脱敏 error 与 SQLite/PG 原子 claim 预留均已实现。**WP4B 物理执行器/retry/quarantine 未实施**：当前仅安全只读 planner（只读统计 pending/processing-expired/failed 及安全 error/state counts；SQLite 缺失库零创建、PG 连接只读；`--apply` 立即 fail-closed），用户提供的真实 PG16+age `verify:release` 成功证据包含 file-ops planner gate 及 compiled/npm smoke；本文不记录或推导测试数量。**WP4C 方案 A 收敛已验收，仅交付安全 DB-only reconcile analyzer**：不生成操作、不写入 outbox、不执行任何处置、绝不扫描文件系统（不能探测 orphan/lost/JSONL 损坏）；创建侧回写中断与文件最终清理由后续工作包/native helper 处理。用户提供的完整真实 PG16+age `verify:release` 成功证据包含真实 PG reconcile gate 及 compiled/npm smoke；本文不记录或推导测试数量。

### 5.1 一致性模型与 outbox

- 双存储非单事务；跨存储操作（建会话 + 建 JSONL + 回写路径、删会话 + 删文件）需要**崩溃后可补偿**的持久化记录。
- **WP4A 交付**：持久化 outbox（状态记录 + operation key 幂等），服务重启或后续 worker 可据此补偿；当前只提供原子 claim 预留，不启动 worker、不执行文件副作用。删除业务行与 enqueue 在同一 DB 事务内完成，避免删除后丢任务。

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
- 处置均需审计且保留期与审计策略对齐（§9 待决策项 3）。

### 5.5 quarantine

- 异常 / 不可判定文件入隔离区（隔离目录或隔离状态），人工复核；quarantine 内容**同样受备份与访问控制约束**，不因隔离而免于备份。

### 5.6 WP4A 边界

- 已实现：v1 Manifest/migration、SQLite/PG 同构 `file_operations`、相对 JSONL 白名单、状态转移与 lease claim、错误脱敏、删除同事务 enqueue、操作幂等。
- 未实现：claim 后的文件执行器/retry/quarantine（WP4B，方案 A 未实施）、启动/定时 reconcile、真实 filesystem reconcile 与 orphan/lost-file 处置及审计保留策略（WP4C 自动处置未实施；DB-only reconcile analyzer 已验收，见 §5.8）。

### 5.7 WP4B 实施状态（方案 A：安全只读 planner，✅ 已验收）

- **已实现（planner 基础）**：`src/file-operations/planner.ts` 只读统计——唯一数据来源 `store.list()`（WP4A 契约），对 pending、lease 已过期的 processing（崩溃残留）、available_at 已到的 failed 分别计数，并按状态与脱敏 error code（`isRedactedFileOperationError`）计数；不 claim/lease/complete/fail、不扫描文件系统、不生成操作。
- **CLI 与只读保证**：`pnpm file-ops` / bin `pi-agent-server-file-ops`；仅支持默认/`--dry-run`；SQLite 以 `readOnly` 打开（缺失 DB 绝不创建 DB/WAL/SHM，已有库字节指纹不变）；PG 需显式 `PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL` 且连接强制 `default_transaction_read_only=on`；`--apply` 立即 fail-closed（退出码 2），无任何确认词可绕过；报告/错误脱敏（只含 counts/error codes，无相对/绝对路径）。
- **未实施（方案 A 移除）**：物理执行器（claim → unlink/quarantine → complete/fail）、指数退避/at-limit、quarantine 布局及其 backup/restore 集成（`quarantineRoot`、`quarantineFiles` 等）——相关代码与测试已整体移除，backup/restore 回到 WP4A 契约；仓库中不存在任何路径式 physical executor 或可被内部调用的副作用 API。
- **执行路径说明**：执行需受审计的外部运维工具或未来 native helper（单独、尚未启动的事项）；WP4A 的 outbox schema/repository/lease 契约保持不变，是未来执行器的基础。
- **门禁与验收**：`pnpm test:file-ops-pg`（真实 PG planner 强制门禁，缺 URL fail-closed）与 `pnpm build:file-ops`（compiled/npm bin smoke）已接入 `verify:release`；用户提供的真实 PG16+age `verify:release` 成功证据包含该 planner gate 及 compiled/npm smoke，因此 WP4B 方案 A 的安全只读 planner 已验收。本文不记录或推导测试数量。详见 [file-operations.md](file-operations.md)。

### 5.8 WP4C 实施状态（方案 A 收敛：DB-only reconcile analyzer，✅ 已验收）

- **已实现（只读 DB reference 分析）**：`src/file-operations/reconcile.ts` 核心 + `src/application/ports/reconcile-reference-port.ts` 受控只读引用接口 + `src/storage/kysely-reconcile-reference-repository.ts`（纯 SELECT，仅 session id/project id/pi_session_file 三字段，绝不读取 title/system_prompt/cwd 等内容字段）；**绝不扫描文件系统、不读取任何 JSONL**：`DATA_DIR` 仅按纯字符串契约（显式、绝对、非 root、无 traversal；不要求存在、不做 realpath）绑定规范布局——default project → `DATA_DIR/sessions/<sessionId>/<file>`，other project → `DATA_DIR/projects/<projectId>/sessions/<sessionId>/<file>`；null 引用 = normal unmaterialized（计数非 issue）；非 null 只做纯字符串/lexical 验证（拒绝 traversal/空/错误 root/id mismatch/非法 file name），并检测同一 canonical reference 的重复引用；固定 issue codes：`invalid_reference` / `duplicate_reference`；报告只含 counts + 固定 code + opaque sha256 引用 + 固定 `filesystemNotScanned:true` / `cannotDetect`（orphan/lost/json validity 不可判定）字段，绝不含路径/URL/DATA_DIR/session id/prompt 内容；`executable:false`，不生成操作、不建议 outbox 写入。
- **CLI 与只读保证**：`pnpm reconcile-jsonl` / bin `pi-agent-server-reconcile-jsonl`；仅支持默认/`--dry-run`；`DATA_DIR` 纯字符串契约（显式绝对非 root，不要求存在、不扫描）；CLI 主入口识别零 fs（纯 path/fileURL 判断），SQLite 只读打开是唯一必要文件系统访问（缺失 DB 绝不创建 DB/WAL/SHM，已有库字节指纹不变）；PG 需显式 `PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL`，连接串严格校验（协议/host/database 显式、禁止 fragment），`options` 只允许 `search_path`（严格解析，其余一律拒绝），并合并 `default_transaction_read_only=on` 与有界 lock/timeout；迁移 head 仅只读 verify；`--apply` 立即 fail-closed（退出码 2），无任何确认词可绕过；错误统一脱敏。
- **不触碰文件系统**：无递归遍历、无 lstat/open/readFile、无 JSONL parse；因此**不能探测 orphan/lost/JSONL 损坏**（报告固定字段明确声明），真实 filesystem reconcile 留给未来受审计的 native helper。
- **未实施（方案 A 边界）**：启动/定时 reconcile、真实 filesystem reconcile（探测 orphan/lost/JSONL 损坏）、orphan 删除 / lost 恢复 / quarantine 等任何物理处置、向 `file_operations` outbox enqueue、v2 migration；仓库中不存在任何路径式 physical executor、文件扫描器或可被内部调用的副作用 API。
- **执行路径说明**：处置需受审计的外部运维工具或未来 native helper（单独、尚未启动的事项）；WP4A 的 outbox schema/repository/lease 契约保持不变。
- **门禁与验收（✅ 已验收）**：`pnpm test:reconcile-jsonl-pg`（真实 PG reconcile 强制门禁，缺 URL fail-closed）与 `pnpm build:reconcile-jsonl`（compiled/npm bin smoke）已接入 `verify`/`verify:release`；用户提供的完整真实 PG16+age `verify:release` 成功证据包含真实 PG reconcile gate 及 compiled/npm smoke，WP4C 已据此验收。本文不记录或推导测试数量。详见 [reconcile-jsonl.md](reconcile-jsonl.md)。

## 6. 备份与恢复

### 6.1 备份内容与一致性

- 备份集 = **DB 快照 + JSONL 会话目录**（双存储必须一起备份：任一侧缺失都会导致会话不完整；JSONL 不可重建，DB 业务元数据不可重建）。
- 每日备份在线执行，不要求每日停服务；当前没有全局写冻结。DB 快照与 JSONL 复制之间**不是全局原子操作**，因此不宣称二者天然对应同一瞬间的全局一致点，备份集必须通过逐项完整性复核后才能发布。
- 初始存储已确认先落本机绝对目录；具体备份根路径、是否独立挂载/介质隔离及访问控制仍待定（见 §9）。

### 6.2 SQLite：VACUUM INTO + JSONL

- 用 `VACUUM INTO` 生成**一致性快照文件**（避免直接拷贝文件在 WAL 下的不一致）；JSONL 目录做点快照（归档/同步到备份介质）。
- 日常形态：每日完整备份（§2.2 已确认方向；增量/差异留给未来，不承诺）。

### 6.3 PostgreSQL：pg_dump + JSONL

- WP3B2 的离线 PostgreSQL backup core 实现已完成并通过真实 PG16 release gate：仅接受显式 `PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL`，通过安全 libpq 环境与临时 0600 `PGPASSFILE` 调用 `pg_dump`，生产 adapter 将 stdout 直接接入私有 dump 文件，并始终传入显式 `--schema=<effective schema>`；zero-byte dump 在 age 前 fail，URL、用户名、密码不进入子进程 argv、日志或 manifest。public source schema 被拒绝。
- 包沿用 age 加密、稳定 JSONL/models 白名单、逐项 hash/size、`COMPLETE` 最后写入与原子 publish；manifest 保存 `PostgreSQL` 方言、database/schema 脱敏 identity、`pg_dump` 版本和 ledger summary。PG restore 只接受显式绝对 target root、显式临时 target PG URL 与 canonical safety contract：target DB 必须是 `pi_restore_*` 且为空，authenticated source schema 与显式 authenticated target schema 不得是 public，也不得命中 source identity；未配置的 libpq 默认 `public` namespace 只作为创建 non-public source schema 的 bootstrap target；不再接受可绕过检查的 nonblank safety token，不自动创建或删除数据库。target URL 无需预设 `search_path`；restore 后从 catalog 唯一定位 manifest authenticated non-public source schema，显式复核 schema/ledger/FK，并只报告安全 schema 摘要。
- `pg_dump`（事务一致性）+ JSONL 目录快照；文件级 `pg_basebackup` 为更高成本备选，不承诺。与 §6.2 相同：DB 快照与 JSONL 复制不构成全局原子快照。真实 PG16 `pg_dump` → age → `pg_restore` gate 已通过；确认匹配 PG16 客户端后，`volta run pnpm verify:release` 成功返回 shell，真实 `test:pg-backup` 先于截图尾部的 `build`/`build:migrate`/`build:backup` 完成。

### 6.3.1 JSONL 在线复制后的强制复核

- 每个复制后的 JSONL 文件都必须复核 `size`、`mtime`、hash 以及逐行 JSON 解析；副本应与复制时稳定的源文件元数据/hash 对齐，末行半行视为无效。
- 若源文件在复制期间发生变化、源/副本的 `size`/`mtime`/hash 不稳定或出现半行，必须重试复制并重新完成全部复核。
- 重试后仍无法获得稳定副本时，备份必须失败，且不得发布 `COMPLETE` 标记。

### 6.4 恢复演练

- **WP3B1 SQLite drill 已完成并通过 release gate 验收**：显式输入 backup package、临时 target root 与一次性 age identity；在 target root 外私有 staging 解密，校验 COMPLETE、加密 manifest、payload hash/size/白名单、migration verify、外键、JSON/JSONL 与 Pi `SessionManager` 结构，再将 `pi_session_file` 安全映射到唯一恢复目录；不启动服务、不发模型请求、不读取生产源文件，CLI 只输出机器可读 counts/version 报告。
- 定期（频率待定，建议每季度 + 每次重大 migration 前）在隔离/临时实例执行：加载备份 → 启动门禁（preflight + ledger 校验）→ 抽查会话数据完整性 → 产出演练报告。WP3B2 的 PG 演练使用运维/测试 fixture 预先创建和最终销毁临时 database/schema；core 只在空 target DB 上执行 `pg_restore`，不默默创建、drop 真实数据库。migration prebackup、生产回滚门禁仍留给后续工作包。
- 备份「有效」的唯一证明是恢复演练通过；演练同样覆盖 §4.8 的迁移出错回滚。

### 6.5 RPO / RTO（待定）

- 每日完整备份对应的最大数据丢失窗口是 RPO 上限的参考，但**具体取值未定**（§9 待决策项 2），本计划不编造数字；RTO 目标值及其验收口径同样待定，不能以当前演练时长代替目标承诺。

### 6.6 加密 / 密钥托管 / 权限

- **已确认**：备份正式采用 age 公钥加密。
- **仍待定**：age recipient、私钥托管（包括是否接入 KMS）及具体访问控制策略（§9）。在这些事项确定前，不声称密钥托管或访问隔离已经实现。

### 6.7 凭证不进入备份

- 凭证（模型/钉钉/Git 等 API key、OAuth token）不落库明文，来自环境变量 / KMS / `PI_AUTH_PATH` 独立凭证文件（needs.md §7），故备份集**天然不含明文凭证**；备份介质访问权限按 secrets 权限基线控制，并在恢复演练中校验「恢复后的环境不含旧凭证」。

### 6.8 WP3A 验收状态（已完成）

- `src/backup/backup-core.ts` 与 `scripts/backup.ts` 已完成显式 SQLite 备份核心与 CLI：白名单、稳定读取、只读/WAL、staging/publish、真实 age 加密及发布包门禁均已验收。真实 age 流程在临时目录生成一次性 identity、提取 recipient，完成加密→解密→hash/内容校验；任一 binary 缺失时安全非零失败，不读取用户密钥配置。
- WP3A 已通过真实 `verify:release` PG release gate（PG 门控 3 文件 / 59 用例）；验收证据还包括 build、compiled migration CLI、compiled backup CLI，以及 installed npm backup bin smoke。CLI 要求绝对 `AGENT_CWD`、`--backup-root`、age recipient 文件；支持 `create` 与 `--dry-run`。失败不会发布 `COMPLETE`，也不接入服务启动或内置 timer。
- 当前策略对缺失但位于白名单根内的 `pi_session_file` 做加密 manifest 状态记录；白名单根外引用直接失败。PostgreSQL backup 由 WP3B2 提供实现且 reviewer P0/P1 修复已完成，真实 PG16 `pg_dump` → age → `pg_restore` gate 已通过；retention、migration-prebackup/runbook 与外部 scheduler 接入留给后续工作包；外部 scheduler 只能在运维层显式调用 CLI。

### 6.9 WP3B1 验收状态（已完成，release gate 验收通过）

- `src/backup/restore-core.ts` 与 `scripts/restore.ts` 仅支持 SQLite：要求绝对输入包、目标根和显式 age identity；拒绝 PG、路径重叠、symlink/traversal、缺 COMPLETE、manifest/payload/ciphertext 完整性错误，并保证失败不发布部分恢复目录。
- 此前 WP3B1 `verify:release` 验收截图显示：root test 64 files passed；630 passed / 2 skipped；真实 age encryption/decryption/hash 通过；restore-core 16 passed；compiled 与 npm-installed backup/restore E2E 及 safe-failure smoke 通过；命令成功返回 shell。此前真实 PG migration gate 也已通过。WP3B2 新增的真实 PG backup describe 在普通 root test 中按 binary/URL 条件 skip，由独立 `test:pg-backup` 强制 gate 负责。
- root test 的条件 skip 不等于发布门禁遗漏：PG migration、PG backup、真实 age 与 restore 均有独立的强制 gate；相关 gate 未执行时 release gate 非零失败。WP3B1 仍仅是离线 SQLite restore drill，不实现 scheduler、retention、migration prebackup、reset、outbox/IAM；报告不包含 cwd、凭证、URL 或完整源路径。

### 6.10 WP3B2 验收状态（已完成，真实 PG16 release gate 验收通过）

- `src/backup/postgres-backup-core.ts` 与 `src/backup/postgres-restore-core.ts` 已有实现，reviewer P0/P1 修复已完成：复用 age 包、稳定 JSONL/models 白名单、external-reference/path 安全和原子 publish；fake-process/受控 executable 测试覆盖 stdout 实际写入、zero-byte fail、argv 不含 URL/password、显式 schema、PGPASSFILE 0600/cleanup、binary/version/失败无 COMPLETE、manifest/hash、public/source target 拒绝、空临时 target、catalog schema 唯一定位、schema/ledger/FK 校验与 DB→JSONL remap。
- CLI 仍保持 SQLite 行为，并新增 PG backup path 与 `--target-pg-url` restore path；日常 `build:backup` 不依赖 PG 系统工具。PG restore 要求 canonical safety contract：显式空 `pi_restore_*` target、拒绝 authenticated public/source schema（未配置的默认 `public` namespace 仅作 bootstrap target），且不接受 nonblank safety token 绕过检查。`pnpm test:pg-backup` 已在匹配 PG16 客户端与真实 PG 上通过：使用随机专用 source/target database，fixture/运维负责创建和销毁；真实 `pg_dump` → age → `pg_restore` → ledger/JSONL 恢复 gate 通过。
- 真实验收证据：确认匹配 PG16 客户端后，`volta run pnpm verify:release` 成功结束并返回 shell；因命令以 `&&` 串行，真实 `test:pg-backup` 先于截图尾部的 `build`/`build:migrate`/`build:backup` 完成，可作为 PG dump → age → restore 真实 gate 通过的证据。本次未执行生产用户 DB 操作。

## 7. 单实例到多实例路径（当前不实现）

- **当前约束**：SQLite 形态仅支持单实例（WAL 单写者 + busy timeout，多实例共享同一 SQLite 文件会竞态/损坏，见 architecture.md 一.4）；单实例下 JSONL 在本地盘、SSE 事件在进程内总线，均为单进程假设。
- **多实例所需（未来）**：
  - 共享 DB：PostgreSQL（替换 SQLite；Repository 已方言中立，见 database-design.md §9.5）；
  - 会话历史：JSONL 从本地盘迁移到共享 / 对象存储（含版本管理）；
  - migration lock：PG advisory lock / ledger 行锁（§4.3 预留接口）；
  - 会话任务 / 事件协调：会话级租约/心跳、Worker Job 队列消费协调（needs.md §4.1 的 Worker 租约/心跳已规划）、SSE 跨实例路由或会话亲和性。
- **当前不实现**：多实例只在明确需求出现后启动（列入 §9 待决策项 6），且必须先完成 WP1/WP3（迁移 + 备份）；设计预留点已列于 §2.3。

## 8. 工作包、依赖、验收与回滚点

### 8.1 工作包列表

| WP | 状态 | 名称 | 内容 | 依赖 | 验收 | 回滚点 |
| --- | --- | --- | --- | --- | --- | --- |
| WP0 | ✅ 已完成/已冻结 | 决策冻结 | 冻结数据保留起点与切换窗口；migration 引擎最终选型（§3，已确认：Manifest-driven）；备份策略方向；明确 RPO/RTO、保留期、备份根路径、age recipient 与私钥托管等后续待定项 | 无（纯文档） | 已完成：决策记录于 [ADR 0001](decisions/0001-phase-3-data-retention-baseline.md)，并同步本文档状态；零代码/零数据变更 | 纯决策，无回滚需求 |
| WP1 | ✅ 已完成，真实 PG 验收通过 | 迁移引擎基础（离线） | 不可变 v0 descriptor/DDL snapshot、schema_migrations ledger、稳定 checksum、SQLite `BEGIN IMMEDIATE` 原子 DDL、PG advisory lock + transaction、schema compatibility 校验、离线 CLI；不接入 `startServer`，不做备份联动 | WP0 | `volta run pnpm verify:release`（真实 `PI_TEST_PG_URL`，含 migration-engine PG 门控）全部通过；WP1 仍为离线工具，不接入 `startServer`；本文不列不可靠的最终总计数 | 未切换时撤回代码即可；已切换后靠备份恢复 |
| WP2 | ✅ 当前 SQLite 目标的干净基线已建立（WP2A 实现与 reviewer 复审修复已完成并通过真实 PG16+age verify:release 门禁验收；无旧 RC 数据，破坏性 reset 不适用） | 最终 reset 切换 | WP2A（已实现）：受控 cutover 离线 CLI（`pnpm cutover` / bin `pi-agent-server-cutover`，确认链 `--reset-rc-data` + `--confirm-reset DELETE_RC_DATA` + `--maintenance-window CONFIRMED`，dry-run 零写入）；pre-reset 加密备份（kind=pre-reset，legacy 库无 ledger 也可备份并在 manifest/报告如实标注）；受控 reset（SQLite：DB/WAL/SHM + sessions//projects/ 根，保留 models.json、永不触凭证；PG：仅 allowlisted `pi_cutover_*` schema DROP/CREATE + 最小授权，绝不 DROP DATABASE/public）；Manifest-driven migration apply + 严格 verify head + 脱敏 machine report；可选严格启动门禁（`migrationGate="verify"`/`PI_MIGRATION_GATE`，空/legacy/落后库 fail-fast，默认 off 不改变 RC 行为）；runbook（[cutover-runbook.md](cutover-runbook.md)）；门禁 `test:cutover`/`test:cutover-pg`/`build:cutover` 接入 `verify:release`。**当前 SQLite 目标：没有旧 RC 数据，已通过空库 pre-migration 加密备份、migration apply 与 strict verify 建立干净基线；未执行破坏性 reset。若未来存在待丢弃 RC 数据的其他目标，仍须经用户明确授权执行受控 cutover。正式服务启用、数据保留承诺与切换记录仍待 WP5 运维就绪后另行确认。** | WP1 + WP3B 就绪（WP2B 另需用户授权） | WP2A：真实 age SQLite 全链路演练门禁、真实 PG 随机 schema 演练门禁、compiled/npm bin E2E 与 safe-failure smoke 全部通过并接入 `verify:release`；实际 cutover 后：空库基线可启动、全量测试通过、基线备份存在（未发生） | WP2B 切换前可随时重来（RC 心智）；切换后只可恢复备份，不可回滚 |
| WP3A | ✅ 已完成，真实 age 与真实 PG release gate 验收通过（SQLite） | 备份核心 | SQLite `VACUUM INTO` + 白名单 JSONL/config 收集；逐文件 size/mtime/hash/逐行 JSON 复核与有限重试；age 每 payload/manifest 加密；staging、`COMPLETE` 最后写入、同 FS 原子发布；显式 CLI 与 dry-run；不接入服务/timer | WP1 + WP0 | 真实 age 加密/解密/hash/内容校验、真实 `verify:release` PG gate（PG 门控 3 文件 / 59 用例）、build、compiled migration CLI、compiled backup CLI、installed npm backup bin smoke 均通过；失败不发布 `COMPLETE` | 撤回离线工具代码即可；未触碰服务/数据 |
| WP3B | ✅ 已完成，真实 PG16 dump/restore release gate 验收通过 | 恢复与运维门禁 | WP3B1 SQLite restore drill；WP3B2 PG backup/restore、恢复流程与演练、完整性复核；不接入服务启动 | WP1 + WP3A + WP0 | WP3B1 与 WP3B2 已通过各自 release gate | 演练在隔离环境执行，生产无风险 |
| WP3C | ✅ 已完成，真实 PG+age `verify:release` 全通过及 `test:migration-prebackup` 门禁通过 | migration 前强制加密备份 + 离线 runbook | `--apply` 强制绝对 backup root、age recipient 与维护窗口确认；`pre-migration` backup → COMPLETE/manifest/age 输出复核 → migration → verify/head check；SQLite/PG 共用 backup core；不接入服务、scheduler、retention、outbox 或 IAM | WP1 + WP3A + WP3B | 真实 PG+age `verify:release` 全量通过；`test:migration-prebackup` 真实 PG 门禁通过；失败不迁移、不自动 down/restore | 备份失败不发布成功；migration 失败保留备份，人工按 runbook 决定恢复 |
| WP4A | ✅ 已验收 | v1 file_operations outbox 基础 | v1 Manifest migration；SQLite/PG 同构表；relative 白名单 path；pending/processing/completed/failed 状态机与脱敏 error；session/project 删除同事务 enqueue；operation key 幂等；双库 repository + 原子 claim 预留；DELETE 只 enqueue、不 unlink | WP1 | 已依据用户提供的真实 PG16+age `verify:release` 成功证据验收；本文不列测试数量 | 执行器/retry/quarantine/reconcile 留后续；outbox 无 FK 级联丢失 |
| WP4B | ✅ 已验收（方案 A：仅安全只读 planner） | JSONL 生命周期 planner（物理 executor，包括 unlink、retry/quarantine 未实施） | 只读统计 pending/processing-expired/failed 及安全 error/state counts；SQLite 缺库零创建、PG 只读；`--apply` fail-closed | WP4A | 用户提供的真实 PG16+age `verify:release` 成功证据包含 file-ops planner gate 及 compiled/npm smoke；本文不记录或推导测试数量 | 无执行路径：物理执行需未来受审计的 native helper |
| WP4C | ✅ 已验收（方案 A 收敛：DB-only reconcile analyzer） | JSONL/DB 只读 DB reference 分析（真实 filesystem reconcile、启动/定时 reconcile 与自动处置未实施） | 只读 DB 引用（session id/project id/pi_session_file）+ 纯字符串规范布局绑定（绝不扫描文件系统、不读取 JSONL；null = normal unmaterialized）；固定 issue codes（invalid_reference/duplicate_reference）+ opaque 引用；`--apply` fail-closed；零删除/移动/quarantine/DB 写入/outbox enqueue/v2 migration | WP4A、WP4B | 用户提供的完整真实 PG16+age `verify:release` 成功证据包含真实 PG reconcile 门禁及 compiled/npm smoke，WP4C 已验收；本文不记录或推导测试数量 | 无执行路径：不能探测 orphan/lost/JSONL 损坏，处置需未来受审计的 native helper；不可重建文件不自动删除 |
| WP5 | ⬜ 未开始 | 运维门禁 | 启动迁移门禁 fail-fast；备份缺失/过期告警（对齐 needs.md §6.6 分级阈值）；审计保留衔接；恢复演练节奏化 | WP1、WP3B | 故障注入测试（坏库/滞后库/缺备份 → 拒绝启动或告警）；门禁与告警清单落文档 | 门禁规则配置化，可降级为告警（需决策） |
| WP6 | ⬜ 未开始 | IAM 进入条件 | 确认 IAM（identity-access-plan.md 工作包 0–5）数据落地门槛 = WP1–5 全部通过；在此之前 IAM 仅做设计（schema decision、待决策项），不落地真实表/迁移 | WP1–5 全部通过 | WP1–5 各自验收全绿；触发 IAM 启动评审并记录决策 | IAM 未开始，无回滚 |

### 8.2 依赖链

```text
WP0 决策冻结
 └─→ WP1 迁移引擎 ──→ WP3A 备份核心 ──→ WP3B1 SQLite drill ──→ WP3B 后续恢复/门禁 ──→ WP2 最终 reset 切换（== 数据保留起点）
     └─→ WP4A outbox 基础 ──→ WP4B 安全只读 planner（✅ 已验收；物理 executor，包括 unlink、retry/quarantine 未实施；执行留给未来受审计的 native helper）──→ WP4C DB-only reconcile analyzer（✅ 已验收；不扫描文件系统、不能探测 orphan/lost/JSONL 损坏，自动处置未实施）──┐
     └─→ WP5 运维门禁 ───────────────────────────────────────────────────────────┴─→ WP6 IAM 进入条件（仅当 WP1–5 全部通过）
```

- **关键门槛**：只有 WP1–5 全部通过，才能进入 WP6（IAM 数据落地）——WP3 基础工作包（WP3A/WP3B1/WP3B2/WP3C）已完成各自真实 gate；WP4A 已验收，**WP4B 方案 A 的安全只读 planner 已验收（物理 executor，包括 unlink、retry/quarantine 未实施）**，WP4C 方案 A 收敛 DB-only reconcile analyzer ✅ 已验收（绝不扫描文件系统，不能探测 orphan/lost/JSONL 损坏，自动处置未实施），WP5/WP6 尚未开始。WP2A 工具已实现并通过真实 PG16+age `verify:release` 门禁；当前 SQLite 目标已完成干净基线初始化，破坏性 WP2B reset 不适用。
- WP3 基础工作包已完成不将 WP2、WP4–WP5 或其他后续工作包视为已完成；后续依赖关系仍按原计划保留，WP2 必须在 WP3 备份恢复完成后执行。

### 8.3 回滚点原则

- **切换前**：任何工作包缺陷可「撤代码 + 重来」（RC 数据无保留义务，仍有 reset 兜底）；
- **切换后**：唯一回滚手段是备份恢复（§4.8 / §6.4），每个 WP 交付即打一份基线备份；
- **IAM 之前**：WP6 只是门槛确认，不引入新的回滚面。

## 9. 待决策项清单（TBD）

以下条目**尚未决定**，决策前不得在实现中隐含默认值：

| # | 待决策项 | 影响面 | 当前状态 |
| --- | --- | --- | --- |
| 1 | ~~migration 引擎最终选型~~ | ~~WP0/WP1~~ | **已决策（§3）：采用自定义 Manifest-driven 引擎；Kysely Migrator 不选** |
| 2 | RPO / RTO 取值 | WP3 | 未定（每日在线全量备份为方向，具体数值与验收口径未定） |
| 3 | 备份及数据/审计保留期 | WP3/WP4/WP5 | 未定（包括备份保留、会话 TTL 归档/删除参数、审计保留期、quarantine 保留期） |
| 4 | 备份根路径及介质访问控制 | WP3 | 本机绝对目录已确认，具体绝对路径、是否独立挂载/介质隔离及访问控制未定 |
| 5 | age recipient / 私钥托管 | WP3 | age 公钥加密已确认；recipient、私钥托管（包括是否接入 KMS）未定 |
| 6 | 多实例 / 共享存储：何时启动、PG + 对象存储形态、会话亲和策略 | 未来（§7） | 未定（当前不实现） |
| 7 | 静态 token 退场：迁移窗口、强制切换 deadline | IAM WP1（见 identity-access-plan.md §8 待决策项 7） | 未定 |

决策流程：每项决策须在对应工作包落地前书面记录（更新本文档与相关设计文档），并附验收口径（对齐 identity-access-plan.md §8 的约定）。

## 10. 相关文档

- 数据库设计与 Schema Manifest 约束：[database-design.md](database-design.md)
- IAM 规划（本计划 Phase 3.1 的承接方）：[identity-access-plan.md](identity-access-plan.md)
- 本地 PostgreSQL 测试流程：[postgres-podman-test.md](postgres-podman-test.md)
- 架构速览（单实例并发模型、SQLite 锁语义、目录/端口边界）：[architecture.md](architecture.md)
- WP4B 离线 planner 设计与运维：[file-operations.md](file-operations.md)
- WP4C 离线 DB-only reconcile analyzer 设计与运维：[reconcile-jsonl.md](reconcile-jsonl.md)
- 平台需求基线（交付计划、备份/保留/审计要求、存储分卷与容量治理）：[../needs.md](../needs.md)
- 对外状态与限制：[../README.md](../README.md) / [../README.zh-CN.md](../README.zh-CN.md)（Security & Limitations：迁移核心当前仅为 WP1 离线开发工具，尚未接入服务；README 的正式能力限制保持准确，不修改）