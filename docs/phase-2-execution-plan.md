# Phase 2 执行计划：Schema Manifest 单一来源 + PostgreSQL 支持

> 本文是 Phase 2 的可独立阅读执行计划，固化当前已确认的方案、数据策略与验收标准。
> **当前状态（如实分账）**：Phase 2 已全部完成并通过最终发布门禁——`volta run pnpm verify:release`（typecheck + test + test:postgres + build，设置真实 PG `PI_TEST_PG_URL`）**全部通过**：全量 `pnpm test` = **54 文件 / 563 用例、无 skip**，`pnpm test:postgres` 的 **45 个 PG 门控用例真实执行且全部通过**（详见 §5E 与 §9）。
> **发布门禁**：完整发布验证以 `volta run pnpm verify:release`（typecheck + test + test:postgres + build，需设置 `PI_TEST_PG_URL`）为准，`release:rc` 发布前调用；无 `PI_TEST_PG_URL` 时 `pnpm test:postgres` 非零退出并说明原因，普通 `pnpm test` 中 PG 组按既有门控 skip——两者刻意区分（skip=复跑基线，fail=强制真实 PG 验收，绝不把未运行的 PG 用例当通过）。
> 当前代码基线为已提交的 Phase 1 Kysely/SQLite bootstrap；数据库详细规则见 [database-design.md](database-design.md)；需求基线 [../needs.md](../needs.md)；架构 [architecture.md](architecture.md)。

## 1. 目的与范围

Phase 2 的目标是在**不改变现有 HTTP 路由、Port API 与业务逻辑**的前提下，将数据库 schema 从两处手工维护（`db-schema.ts` 手写 interface + `bootstrap.ts` 手写 DDL）演进为**运行时 Schema Manifest 为唯一来源**，并自动推导 Kysely `DatabaseSchema` 类型与 SQLite / PostgreSQL 两个数据库的 bootstrap DDL。

**范围边界：**

- SQLite 空库 bootstrap 改为消费 Manifest（行为不变）。
- PostgreSQL 空库 bootstrap 从同一 Manifest 推导并创建等价 schema。
- Repository 层尽可能方言中立化，保留 `Number(numAffected)` 与 JSON text 语义。
- 不改变现有 HTTP 路由、`/health` 端点语义、Fastify/Service/Port API 签名。

## 2. Phase 2 前置项（已完成）

以下工作在 Phase 2 正式启动前已完成并提交：

| # | 工作项 | 状态 | 说明 |
|---|--------|------|------|
| 1 | 默认项目 ID 改为固定 UUID | ✅ 已完成 | `DEFAULT_PROJECT_ID = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c"`（合法 UUID），定义于 `src/application/ports/project-store-port.ts` |
| 2 | Project DTO/API 暴露 `isDefault` | ✅ 已完成 | `ProjectDto = { id, name, cwd, isDefault: boolean }`；默认项目 `isDefault: true`，其余为 `false` |
| 3 | Web 由 `isDefault` 推导默认项目 | ✅ 已完成 | Web 侧不硬编码项目 ID，通过 `isDefault` 字段推导；加载/重试与陈旧响应保护已实现 |
| 4 | RC 旧库删库重建 | ✅ 已完成 | RC 阶段不做版本化迁移，旧库直接删除重建；`bootstrap.ts` 全部 `IF NOT EXISTS` |

> ✅ 上述前置项连同工作包 A/B/C/D 已全部落地，并含最终测试审计补强（§5E）；**最终发布门禁已通过：`volta run pnpm verify:release`（真实 PG `PI_TEST_PG_URL`）全量 54 文件 / 563 用例与 45 个 PG 门控用例全部通过**（见 §5E 与 §9）。

## 3. 核心目标

1. **Schema Manifest 是唯一来源**：运行时 Schema Manifest 定义所有表、列、约束、索引；不再手工维护 `db-schema.ts` interface 与 `bootstrap.ts` DDL 的两处同步。
2. **自动推导 `DatabaseSchema`**：从 Manifest 自动推导 Kysely 泛型所需的 `DatabaseSchema` 类型，消灭手工 interface。
3. **SQLite 和 PostgreSQL bootstrap 共用**：同一 Manifest 分别生成 SQLite 方言与 PostgreSQL 方言的 DDL。
4. **PostgreSQL 空库支持**：RC 阶段仅要求空 PG 库可初始化出一致 schema，不涉及数据迁移。
5. **保持 API 不变**：Fastify/Service/Port API 签名与行为不变。

## 4. 已确认数据策略

### 4.1 ID 与 UUID

| 字段 | 逻辑类型 | SQLite 存储 | PostgreSQL 存储 | 说明 |
|------|----------|-------------|-----------------|------|
| `projects.id` | UUID | `TEXT` | `UUID` | 应用层 `randomUUID()` 生成 |
| `sessions.id` | UUID | `TEXT` | `UUID` | 应用层 `randomUUID()` 生成 |
| `sessions.project_id` | UUID | `TEXT` | `UUID` | FK → `projects.id` |
| `idempotency.session_id` | UUID | `TEXT` | `UUID` | 与 `request_id` 构成复合主键 |
| `DEFAULT_PROJECT_ID` | UUID | `TEXT` | `UUID` | 已是合法 UUID，无需转换 |

### 4.2 `request_id`

保持 `TEXT` 类型，SQLite 与 PostgreSQL 均为 `TEXT`（`VARCHAR`）。

### 4.3 时间戳

- **语义**：应用层 `Date.now()` 毫秒时间戳，非数据库自增或 `DEFAULT CURRENT_TIMESTAMP`。
- **SQLite**：`INTEGER`（毫秒）。
- **PostgreSQL**：`BIGINT`（毫秒）。
- **pg int8 读回 string 问题**（**工作包 C 已解决**）：PostgreSQL `node-postgres` 默认将 `BIGINT`（int8）读回为 `string` 以避免 JavaScript 精度丢失。工作包 C 在 **PG storage 边界**解决：`src/storage/pg-int8.ts` 的 `createPgInt8SafeTypes()` 构造 per-pool CustomTypes（只覆盖 OID 20），`parsePgInt8` 对超出 `Number.MAX_SAFE_INTEGER` 的值显式抛错（拒绝静默丢精度）；毫秒时间戳远低于安全上限，正常数据永不触发。
- **安全整数范围**：毫秒时间戳当前约 $1.7 \times 10^{12}$，`Number.MAX_SAFE_INTEGER` 约 $9 \times 10^{15}$，安全余量充足。Repository 层读回即为 number，`Number(numAffected)` 语义保留。

### 4.4 JSON 文本字段

`result`（idempotency）和 `capability_versions`（sessions）保持 JSON 文本：

- SQLite：`TEXT`。
- PostgreSQL：`TEXT`（`VARCHAR`），**不在本阶段改 JSONB**。
- 读回时 `JSON.parse()`，写入时 `JSON.stringify()`，往返语义不变。

### 4.5 无迁移承诺

- **无 SQLite → PostgreSQL 数据迁移**：Phase 2 仅要求空 PG 库可初始化。
- **无版本 migration**：RC 阶段旧库删库重建，不引入 `kysely_migration`。
- **无旧 schema 兼容**：`bootstrap.ts` 仅 `IF NOT EXISTS` 面向空库。

## 5. 工作包与提交边界

### A. 服务端 ID 保留值 / 唯一冲突的有界重试 `✅ 已完成`

> **实现说明（已完成态）**：
> - **保留值语义**：`DEFAULT_PROJECT_ID` 仅是 **projects 表的保留值**（由 `ensureDefaultProject` 独占）。采用最小语义——**sessions 不把 DEFAULT 视为保留值**，不改变 sessions 合法 ID 空间；服务端 `createId`（UUID）几乎不可能命中该值，即使命中，sessions 表也无此列约束（该值只是一条合法的项目 id）。
> - **普通项目保留值守卫**：`createProject` 若生成 `DEFAULT_PROJECT_ID`，应用层**跳过并重新生成**（有界，防假 createId 死循环），**绝不把保留 id 交给 `repository.create`**（仓库层 `create` 的 DEFAULT 守卫异常保留，作为不变量刀底）。
> - **存储无关错误**：新增 `DuplicateIdError` 与 `ProjectForeignKeyError`（`src/application/ports/store-errors.ts`，application port 层），**application 层不识别任何 SQLite 错误码（1555/2067/787）**，仅依赖这两个存储无关错误。SQLite 映射（`src/storage/sqlite-constraint-errors.ts`）：
>   - **id 冲突**：projects/sessions 的 `create` 将**冲突列恰好为单个 `<table>.id`** 的主键/唯一约束错误（errcode 1555/2067，消息如 `UNIQUE constraint failed: projects.id`）转换为 `DuplicateIdError` 并保留原始 cause；**复合唯一约束（如 `projects.owner_key, projects.id`）不得因消息包含 `<table>.id` 被误转**，非 id 列冲突（如未来新增唯一索引）同样原样抛出。
>   - **sessions 项目外键冲突**：sessions 的 `create` 将外键约束错误（errcode 787，`sessions.project_id` 对应项目在写入前被删除）转换为 `ProjectForeignKeyError` 并保留原始 cause；`SessionService.createSession` 捕获后仍按既有语义返回 `project-not-found`，不吞不重试。
>   - PG implementation（工作包 C）在 `src/storage/pg-constraint-errors.ts` 复用同一错误（23505 unique_violation → `DuplicateIdError`；23503 foreign_key_violation → `ProjectForeignKeyError`），并经工作包 D 真实 PG 集成测试验证。
> - **有界重试**：`createProject` / `createSession` 仅对 `DuplicateIdError` 用新 ID 重试，最多重试 3 次（共 4 次尝试，`MAX_ID_RETRIES`，application layer 导出）；超出上限抛明确错误（带 cause，走既有 500 路径），不静默吞掉。`createProject` 的 `createdAt` 在重试循环外冻结（与 `createSession` 一致），`now` 仅调用一次。
> - **`ensureDefaultProject` 未改动**：`INSERT OR IGNORE` 幂等保护继续生效，其显式守卫异常不作为客户端正常失败路径。DB 主键约束继续作为最终兜底。
> - 测试覆盖：会话/项目建库撞库（首次冲突重试成功、连续冲突超限失败、DEFAULT 保留值跳过重新生成、`createProject` 非 Duplicate 错误仅尝试一次、`createProject` 重试时 createdAt 仅计算一次、repository 真实撞库→`DuplicateIdError`、sessions FK 787→`ProjectForeignKeyError` 且 createSession 返回 project-not-found 不重试、单一/复合非 id 唯一索引不误转、约束消息形状单元测试）；根 `volta run pnpm test`（41 文件 / 408 用例）与 `volta run pnpm build` 通过。—— 41/408 为工作包 B 落地前的中间态计数，B 完成后的最终一致计数以其验收为准（43 文件 / 431 用例，见下）。

**目标**：对普通项目和会话的 UUID 生成引入有界重试，处理极低概率的主键冲突；`DEFAULT_PROJECT_ID` 保留 ID 不向用户暴露 500。

**工作项：**

1. 项目/会话创建时，若 `INSERT` 因主键冲突失败（`UNIQUE` / `PRIMARY KEY`），自动重试生成新 UUID 并重试插入，最多重试 N 次（已实现：3 次）。
2. 超出重试上限时返回明确错误（500 + 日志），不静默吞掉。
3. `DEFAULT_PROJECT_ID` 的 `ensureDefaultProject()` 已有 `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING` 保护；确认其不向用户暴露 500（冲突时幂等忽略即可）。
4. DB 主键约束继续作为最终兜底。

**验收：**
- 单元测试覆盖：模拟主键冲突 → 重试成功 / 超限失败；DEFAULT 保留值跳过重新生成；仓库真实撞库转存储无关错误；外键竞态语义不变（改为存储无关 `ProjectForeignKeyError`）；复合/非 id 约束不误转。—— 已通过。
- SQLite 已通过。PG 侧等价映射（23505 → `DuplicateIdError`、23503 → `ProjectForeignKeyError`）随工作包 C 落地，并经工作包 D 真实 PG 集成测试验证（应用层不识别任何 SQLite/PG 错误码，仅依赖两个存储无关错误，无需改动）。
- `volta run pnpm test`（41 文件 / 408 用例）与 `volta run pnpm build` 通过。—— 41/408 是工作包 B 落地前 A 的中间态计数；最终一致计数以 B 验收为准（`volta run pnpm test` 43 文件 / 431 用例，`volta run pnpm typecheck` 通过）。

---

### B. Schema Manifest 与类型推导 `✅ 已完成`

> **实现说明（已完成态）**：
> - **唯一手工声明**：`src/storage/schema-manifest.ts` 的 `schemaManifest = defineSchema([...])` 是 projects / sessions / idempotency 的表、列、逻辑类型（`uuid`/`text`/`integer`/`bigint`/`json`）、nullable、default（`project_id` 仍引用 `DEFAULT_PROJECT_ID` 常量）、PK、FK、索引的**唯一手工来源**。`db-schema.ts` 不再手写三张表 interface，仅 re-export 从 Manifest 推导的 `DatabaseSchema`（`src/storage/schema-types.ts`：逻辑类型 → TS 类型，uuid/text/json→`string`、integer/bigint→`number`，nullable 追加 `| null`），既有 import 名称不变、无需改名。
> - **类型约束（无 ORM/JSON Schema/codegen，不用 `any` 逃避）**：`defineSchema<const T>` 在编译期校验主键列、外键源列、索引列必须引用本表已声明列，外键目标表/列须存在、FK 源/目标列等长且非空、主键列不可 nullable（违反时调用点编译失败，错误字面量见 `__schemaIssue`）；运行期 `validateManifest` 两趟校验表/列/索引名唯一性、FK 目标先于引用表声明、FK 源/目标列非空且等长、源/目标逻辑类型一致、主键列不可 nullable、onDelete 合法、default 与逻辑类型匹配，并深冻结。`@ts-expect-error` 负向类型测试保证非法 Manifest 确实编译失败。
> - **行形态与字面量收紧**：逻辑类型运行期集合以 `LOGICAL_COLUMN_TYPE_KEYS`（`Record<LogicalColumnType, true>` 对象键）为权威，`LOGICAL_COLUMN_TYPES` 数组由键推导，union 新增而数组漏项会直接编译失败；`DefaultValueLiteral = string | number`（无 boolean 逻辑类型，boolean default 类型与运行期双重拒绝）；`kysely-session-repository.ts` 的 `SessionRow` / `kysely-project-repository.ts` 的 `ProjectRow` 不再手写，直接引用 `DatabaseSchema["sessions"]` / `DatabaseSchema["projects"]`，schema 字段无第二份声明，Repository 映射/查询不变。
> - **bootstrap 消费 Manifest**：`initializeDatabase()` 不再列出字段/索引/FK，只做逻辑类型 → SQLite 物理类型映射（uuid/text/json→`text`、integer/bigint→`integer`），用 Kysely schema builder 按 Manifest 顺序逐表建库，保留 `IF NOT EXISTS`、文件库 WAL（memory 跳过）与 `DEFAULT_PROJECT_ID`；单列主键仍为列级 `primaryKey()` 内联、复合主键仍为命名约束 `idempotency_pk`、FK 仍 `ON DELETE CASCADE`、4 个索引含 `idx_sessions_owner_updated` 的 `updated_at DESC` 语义——与当前 DDL 一致；唯一差异：单列主键列经 Manifest 校验强制 + bootstrap 显式 `notNull()`（较历史 DDL 更严格，但符合「主键值不可为 NULL」的业务语义，属修正而非回归）。Repository 未改查询语义。
> - **测试**：新增 `tests/storage/schema-manifest.test.ts`（19 用例）——真实 `DatabaseSync` 空库 PRAGMA 契约（每张表列的类型/nullable/default、单列/复合 PK 序号、FK CASCADE 含行为验证、4 索引含 DESC、WAL、无 kysely_migration、Kysely 真实查询、PK 列防御性 notNull、number/string default 的字面量渲染）+ `defineSchema` 运行期校验负向用例（含新增：PK 列不可 nullable、FK 源/目标非空且等长、源/目标逻辑类型一致、boolean default 拒绝、逻辑类型集合以 Record 键为权威）；新增 `tests/storage/schema-types.test.ts`（4 用例）——`expectTypeOf` 证明 DatabaseSchema 的 nullability/逻辑类型推导可用于真实 Kysely 查询，含 `@ts-expect-error` 负向（非法 Manifest、派生类型误用、不存在的查询列、PK nullable / FK 列数不等 / FK 空源列 / boolean default）。`tests/storage/bootstrap.test.ts` 等既有测试文件未改动。
> - **验证**：`volta run pnpm test`（43 文件 / 431 用例）、`volta run pnpm build` 与 `volta run pnpm typecheck`（`tsc --noEmit -p tsconfig.json`，含 tests 全量）全部通过。全量 typecheck 曾有两处既有测试类型问题（`tests/application/session-service.test.ts` 用具体 fake 类而非 Port 接口保留可观测属性、`tests/server/storage-close.test.ts` 的 let/null 闭包赋值导致类型收窄为 never），已一并修正；schema 类型负向测试（`@ts-expect-error`）在 typecheck 下真实生效（unused directive 直接报错），不再依赖仅有 build 的漏检。

**目标**：引入运行时 Schema Manifest 作为 schema 唯一来源，自动推导 Kysely `DatabaseSchema`；SQLite bootstrap 改为消费 Manifest。

**文件/模块职责（已按实现落地）：**

| 文件 | 职责（现状） |
|------|------|
| `src/storage/schema-manifest.ts` | Schema Manifest 唯一来源：表/列（逻辑类型、nullable、default）/PK/FK/索引声明，`defineSchema` 编译期 + 运行期双重校验 + 深冻结 |
| `src/storage/schema-types.ts` | 从 Manifest 推导 Kysely `DatabaseSchema` 类型（含编译期自检与逻辑类型→TS 类型映射） |
| `src/storage/bootstrap.ts` | 消费 Manifest + SQLite 逻辑类型映射生成 SQLite 方言 DDL 并执行（不引入 `bootstrap-sqlite.ts`，沿用原文件名） |
| `src/storage/db-schema.ts` | **派生类型兼容出口**：仅 re-export `DatabaseSchema`，不再手写/手维护 interface（保留为既有 import 不改名） |

**Manifest 应声明的信息：**

- 每张表的列名、逻辑列类型（`uuid` / `text` / `integer` / `bigint` / `json`）、是否 nullable、默认值。
- 主键（单列或复合）。
- 外键约束（源列 → 目标表.目标列，`ON DELETE` 行为）。
- 索引（列列表、排序、唯一性）。

**类型推导：**

- 从 Manifest 的逻辑列类型推导 TypeScript 类型（`uuid` → `string`，`integer` → `number`，`json` → `string | null` 等）。
- 自动产出 `DatabaseSchema` 接口，替代手工维护的 `db-schema.ts`。

**验收（全部已通过）：**
- ✅ Manifest 定义与当前既有 schema 一致（契约测试以 PRAGMA 对照；单列主键列显式 NOT NULL 为更严格的业务语义修正）。
- ✅ SQLite 空库 bootstrap 消费 Manifest 后行为不变（`CREATE TABLE IF NOT EXISTS` + 索引 + FK + WAL + 无迁移表）。
- ✅ `DatabaseSchema` 类型由 Manifest 自动推导，`db-schema.ts` 手写 interface 不再是必须维护的文件。
- ✅ schema contract tests：Manifest 定义 → SQLite bootstrap → 查询可用 → 类型安全（编译期/运行期双校验 + `@ts-expect-error` 负向）。
- ✅ 现有 SQLite 测试全部通过（`volta run pnpm test` 43 文件 / 431 用例）。
- ✅ `volta run pnpm build` 通过。
- ✅ `volta run pnpm typecheck`（`tsc --noEmit -p tsconfig.json`，含 src + tests 全量）通过，schema 类型负向测试（`@ts-expect-error`）真正被检查。

---

### C. PostgreSQL 支持 `✅ 已完成（真实 PG 集成测试已通过）`

> **状态（本工作包 C）**：**已验收、已完成**。实现完成（代码、单元测试、门控集成测试全部就绪），并经工作包 D 在真实 PG 空库（`PI_TEST_PG_URL`）上验证：`tests/postgres/postgres.integration.test.ts`（17 个用例）真实执行并全部通过，SQLite 测试全绿。未设 `PI_TEST_PG_URL` 时该组仍以 skip 呈现（打印依据，不发起连接、不报告通过）——该机制保留用于复跑（见 [postgres-podman-test.md](postgres-podman-test.md)），不代表状态回退。

**目标**：引入 PostgreSQL bootstrap，从同一 Manifest 推导 PG DDL；Repository 层方言中立化。

**已落地实现：**

1. **依赖**：新增 `pg@^8`（`node-postgres`）与 dev `@types/pg@^8`；用 Kysely `PostgresDialect` + `Pool`，**未引入 ORM/Prisma/Drizzle**。
2. **启用与 fail-fast**（兼容命名：对照进程内既有 env 落地，未编造额外 env）：`PI_STORAGE_DIALECT`（缺省或 `sqlite` → SQLite 默认，`postgres` → PG，其他取值启动抛 `未知存储方言`）+ `PI_DATABASE_URL`（`storageDialect=postgres` 时必填，缺失/空白 fail-fast）。`start.ts` 的 `resolveStorageConfig` 先于任何资源创建/网络访问解析；`StartConfig` 新增 `storageDialect?` / `databaseUrl?` 显式字段（`StorageDialect` / `ResolvedStorage` 联合类型）。仅设 `PI_DATABASE_URL` 不启用 PG（向后兼容）。
3. **PG bootstrap 消费同一 Manifest**：`src/storage/schema-builder.ts` 抽取 Manifest→Kysely schema builder 方言无关流程（建表/列/主键/外键/索引），`bootstrap.ts`（SQLite）与 `postgres-bootstrap.ts`（PG）只注入各自的逻辑类型映射（`SQLITE_LOGICAL_TYPE` / `POSTGRES_LOGICAL_TYPE`）；Manifest 仍是唯一 schema 来源，未成为第二份 DDL。PG 映射：`uuid→UUID`、`text/json→TEXT`（json **非 JSONB**）、`integer/bigint→BIGINT`；`request_id` 保持 TEXT。SQLite 保留 WAL/memory 行为。
4. **int8 安全读回**：`src/storage/pg-int8.ts` per-pool CustomTypes（OID 20）+ `parsePgInt8`（超出 `Number.MAX_SAFE_INTEGER` 显式抛错，不静默丢精度）；文档（database-design.md §9.3）说明该风险已被实现处理。
5. **Repository 方言中立**：`kysely-project-repository.ts` / `kysely-session-repository.ts` / `kysely-idempotency-repository.ts`（不再有名为 Sqlite 的 Repository），构造注入 `ConstraintErrorMapper`（`sqliteConstraintErrorMapper` / `pgConstraintErrorMapper`）；PG SQLSTATE `23505`（仅自身单列 id 主键 `<table>_pkey`）→ `DuplicateIdError`，`23503`（sessions.project_id）→ `ProjectForeignKeyError`，其余原样抛出；application 层不识别任何 PG code。查询语义与 `Number(numAffected)` 保留；start/mock/全部测试 import 同步。
6. **组合根**：`start.ts` 按方言构造 DatabaseSync+SQLite 或 Pool+PG（`createPostgresPool` + `initializePostgresDatabase`，失败路径内先 destroy 再抛原始错误）；`createIdempotentStorageCloser` 仍统一 `kysely.destroy()`——PG 侧 `PostgresDriver.destroy` 会 `pool.end()`（`tests/storage/postgres-bootstrap.test.ts` 以 fake Pool 驱动 init→query→destroy 全链验证，不依赖未验证假设）。timeout/FK/WAL 仅 SQLite；mock 保持 SQLite memory。
7. **测试**：门控 PG 集成测试 `tests/postgres/postgres.integration.test.ts`（仅 `PI_TEST_PG_URL` 存在时运行，否则整组 skip；随机 schema `pi_test_*` + `search_path` 隔离，afterAll 仅 drop 自己的随机 schema，严禁 public/用户库）覆盖 bootstrap（表/FK/index）、默认项目、CRUD、FK CASCADE、ON CONFLICT/idempotency、TTL、JSON text 往返、BIGINT number（含超范围显式失败）、PG 错误映射（真实 23505/23503）、pool close。无网络单元测试：`tests/server/start-storage-config.test.ts`（fail-fast）、`tests/storage/pg-int8.test.ts`、`tests/storage/pg-constraint-errors.test.ts`（SQLSTATE mapper）、`tests/storage/schema-builder.test.ts`（PG/SQLite 类型映射 + spy DDL builder）、`tests/storage/postgres-bootstrap.test.ts`（生命周期）。
8. **验证（本机现状）**：未设 `PI_TEST_PG_URL` 基线 `volta run pnpm test` = 49 个测试文件（48 passed、1 skipped）/ 485 个测试（468 passed、17 skipped）；设置 `PI_TEST_PG_URL`（真实 PG）后 17 个门控用例真实执行且全部通过（49 文件 / 485 用例全绿）。`volta run pnpm build` 与 `volta run pnpm typecheck` 全部通过。

**验收（工作包 C 部分，全部满足）：**
- ✅ PG bootstrap 从同一 Manifest 生成等价 schema（DDL 映射/约束/索引有单元与集成测试覆盖）。
- ✅ Pool 创建/销毁生命周期正确（fake-Pool 全链验证 destroy→pool.end）。
- ✅ SQLite 测试全部通过（Manifest 改动未破坏 SQLite；49 个测试文件（48 passed、1 skipped）/ 485 个测试（468 passed、17 skipped））。
- ✅ `volta run pnpm build` 通过。
- ✅ 真实 PG 空库集成验收（属 D）：**已通过**——`PI_TEST_PG_URL` 门控开启后 17 个门控用例真实执行、全部通过，故 C 打完成。

**依赖与配置（实际落地）：**

1. 新增 `pg`（`node-postgres`）依赖与 `@types/pg` 类型依赖。
2. 引入 `Pool` + `PostgresDialect`（Kysely 官方 PG 适配器）。
3. 显式 dialect / connection config（对照现有 config 约定落地）：`PI_STORAGE_DIALECT`（缺省 sqlite）+ `PI_DATABASE_URL`（PG 连接串），见上。

**PG bootstrap 类型映射（Manifest 逻辑类型 → PG DDL，已落地）：**

| Manifest 逻辑类型 | SQLite DDL | PostgreSQL DDL |
|-------------------|------------|----------------|
| `uuid` | `TEXT` | `UUID` |
| `text` | `TEXT` | `TEXT`（非 VARCHAR 内置别名，DDL 用 `text`） |
| `integer` | `INTEGER` | `BIGINT`（毫秒时间戳） |
| `bigint` | `INTEGER` | `BIGINT` |
| `json` | `TEXT` | `TEXT`（非 JSONB） |

**Pool 生命周期（已落地）：**

- 启动时创建 Pool（`createPostgresPool`，含 int8 安全 types），关闭时 `pool.end()`（经 `createIdempotentStorageCloser` → `kysely.destroy()` → `PostgresDriver.destroy` → `pool.end()`）。
- 与 SQLite `DatabaseSync` 的生命周期对齐（在 `start.ts` 的 composition root 中管理）。
- bootstrap 失败路径：`initializePostgresDatabase` 先 destroy（释放 Pool）再抛原始错误；cleanup 不覆盖原始错误。

**Repository 方言中立化（已落地）：**

- Kysely 方言无关 API（`.where()`/`.insert()`/`.update()`/`.deleteFrom()`）+ 注入 `ConstraintErrorMapper`。
- 保留 `Number(numAffected)` 语义（PG 的 `numAffectedRows` 为 bigint，`Number()` 转换）。
- 保留 JSON text 语义（`JSON.stringify` 写入、`JSON.parse` 读回）。
- `ON CONFLICT`：Kysely 已抽象（SQLite `doUpdateSet()` 与 PG `onConflict().doUpdateSet()` 同构，集成测试含幂等验证）。

**验收（工作包 C 部分，全部满足）：**
- ✅ PG bootstrap 从同一 Manifest 创建等价 schema（表、列、FK、索引）——DDL builder 单测 + PG 集成测试覆盖（已在真实 PG 执行并通过）。
- ✅ Pool 创建/销毁生命周期正确（fake-Pool 全链验证）。
- ✅ SQLite 测试仍然全部通过（改用中立 Repository 后 49 个测试文件（48 passed、1 skipped）/ 485 个测试（468 passed、17 skipped））。
- ✅ `volta run pnpm build` 通过。
- ✅ 真实 PG 空库执行集成测试（属 D）：**已通过**——`PI_TEST_PG_URL` 门控开启后 17 个用例全部通过。

---

### D. PostgreSQL 测试 / 交付 `✅ 已完成`

> **状态（本工作包 D）**：**已完成**。集成测试文件与门控机制随工作包 C 建成（`tests/postgres/postgres.integration.test.ts`，`PI_TEST_PG_URL` 门控）；已在真实 PG 空库上以 `PI_TEST_PG_URL` 运行验收：**17 个门控用例全部通过**，完成双库验收（SQLite 全绿 + PG 集成全绿）。

**目标**：真实空 PG 集成测试，验证双库契约一致。

**测试环境门控（已建成于 C，D 已执行）：**

- 使用 `PI_TEST_PG_URL` 环境变量门控 PG 集成测试（本工作包已用真实 PG 跑通）。
- 未设置时跳过 PG 测试（`describe.skip` 或条件注册），不影响 SQLite 测试——机制保留用于复跑。
- 本机临时 PG 测试环境搭建与复跑流程见 [postgres-podman-test.md](postgres-podman-test.md)（macOS + Podman 启动临时容器、端口转发、变量设置与清理）。

**测试隔离：**

- 每次测试用例使用独立 schema 或 `TRUNCATE` + 事务回滚，避免测试间干扰。
- 双库契约：同一测试用例分别在 SQLite 和 PG 上运行，验证行为一致。

**测试覆盖项：**

| 测试场景 | 说明 |
|----------|------|
| 启动/关闭 | PG Pool 创建 → bootstrap → 查询 → `pool.end()` 正常关闭 |
| FK cascade | 删项目 → 关联会话自动删除 |
| ON CONFLICT | `ensureDefaultProject` 幂等；`idempotency.put` 覆盖 |
| TTL 清理 | `prune(before)` 按 `created_at` 删除 |
| 时间值 | 写入 `Date.now()` 毫秒 → 读回数值一致（int8 → number 转换） |
| JSON 往返 | `result` / `capability_versions` 写入 `JSON.stringify` → 读回 `JSON.parse` 一致 |

**文档/README 更新：**

- README 增加 PG 配置说明（env、连接字符串）。
- `database-design.md` 更新 PG 相关章节（类型映射、int8 处理）。
- `phase-2-execution-plan.md` 标记各工作包完成状态。

**验收（全部已满足）：**
- ✅ 真实 PG 空库集成测试通过（`PI_TEST_PG_URL` 门控开启后 `tests/postgres/**` 17 个用例全部通过）。
- ✅ SQLite 测试全部通过（未设门控基线 49 文件 / 485 测试：468 passed + 17 skipped）。
- ✅ `volta run pnpm build` 通过。
- ✅ 文档更新（README / database-design.md / 本文档反映最终状态）。

### E. 最终测试审计补强（H2/H4/H5/H6/M1/M2）✅ 已完成（真实 PG 门控已通过 verify:release）

> **状态**：最终测试审计的高/中优先级补强已全部落地，并经 `volta run pnpm verify:release`（设置真实 PG `PI_TEST_PG_URL`）**验收通过**——全部 45 个 PG 门控用例（见下表与下方最终验收）在真实 PG 上真实执行且全部通过，全量 54 文件 / 563 用例无 skip。

| 项 | 内容 | 实现与测试位置 |
|----|------|----------------|
| H4 共用 Repository 行为契约 | 参数化 `defineRepositoryContract(makeStorage)` 共享测试集（22 用例）：CRUD、owner/project 隔离、排序 tie-break（createdAt/updatedAt desc + id desc）、默认项目守卫（ensureDefaultProject 幂等/拒绝坏 id/非空 owner、create/delete 拒默认、deleteProjectWithSessions 拒默认）、ON CONFLICT（idempotency.put 覆盖）、idempotency prune 精确 cutoff（before-1/before/before+1，只删 before-1，断言删除数）、update 不存在返回 false、相同值更新、backfill、FK CASCADE、撞主键/外键存储无关错误 | `tests/storage/repository-contract.ts`（共享集）；SQLite 注册 `tests/storage/repository-contract.sqlite.test.ts`（始终运行）；PG 注册 `tests/postgres/repository-contract.test.ts`（`PI_TEST_PG_URL` 门控，每用例 TRUNCATE + 重种默认项目） |
| H4 真实 PG mapper | 隔离 schema 内临时创建**非 id / 复合唯一约束**触发真实 23505，断言原样抛出（非 DuplicateIdError 且 code=23505/constraint 保留，非 synthetic）；用例内 finally DROP 临时索引 | `tests/postgres/repository-contract.test.ts`（门控） |
| H5 ID 重试边界 | deterministic application 测试：createId 连续命中 DEFAULT_PROJECT_ID → 有界失败且 Project repository 零调用；createSession 普通非 Duplicate 错误仅尝试一次且原样抛出；createSession 撞库重试时 now/systemPromptResolver/能力快照只计算一次；超限错误 cause 是最后一次 DuplicateIdError（会话/项目） | `tests/application/session-service.test.ts` |
| H6 TTL 调度与精确 cutoff | 仓库层（SQLite 始终运行 + 共享契约双库）：before-1/before/before+1 精确删除、返回删除数；RuntimeRegistry（fake timers + fake now + spy Idempotency repo）：构造启动 prune（cutoff=now-ttl）、周期 prune 精确 cutoff、prune 失败不 unhandled、dispose 后不再 prune；不用真实 setTimeout(10) | `tests/sqlite-idempotency-repository.test.ts`、`tests/storage/repository-contract.ts`（双库）、`tests/runtime/runtime-registry-ttl.test.ts` |
| H2 启动/失败清理 | `startServer` 真覆盖：未知 dialect / PG 缺 URL 在 ModelRuntime/Pool/DB 创建前 fail-fast；注入 seam（`StartConfig.onStorageReady`，生产不传恒无操作）+ 真实 EADDRINUSE 两种中段失败均验证「存储恰好关闭一次（kysely.destroy×1）+ 原始错误保留」；成功 startServer 后 `app.close` 触发 onClose cleanup（destroy×1） | `tests/server/start-server-lifecycle.test.ts`；seam 见 `src/server/start.ts` |
| M1 严格 schema preflight（升级） | `assertSchemaCompatible`（`src/storage/schema-compatibility.ts`，**在任何建表/建索引 DDL 之前**；SQLite 用 PRAGMA、PG 用 information_schema/pg_catalog）：库中已含任一 managed 表时要求完整 schema 与 Manifest 物理契约一致（列名/物理类型/nullable/DEFAULT/单列·复合 PK/FK 目标列 + ON DELETE/显式索引列顺序 + DESC + 非 UNIQUE），任何不一致 → fail-fast，不执行任何 ALTER/补列/建表/建索引，失败路径关闭资源；空库正常 bootstrap，完整一致库跳过 DDL。SQLite 始终验证（缺非索引列、列名齐全但类型错误、FK/索引错误、无 DDL mutation）；PG 同契约门控测试（缺列 + 列名齐全但类型/FK 错误，独立 Pool cleanup） | `src/storage/schema-compatibility.ts`（检查）、`bootstrap.ts`/`postgres-bootstrap.ts`（接入）；`tests/storage/bootstrap.test.ts`、`tests/postgres/postgres.integration.test.ts`（门控） |
| M2 资源所有权 | SQLite test helper 暴露统一 Kysely destroy close（复用生产 `createIdempotentStorageCloser`）；受影响 repository 测试按真实所有权经 close() 关闭（不再直接 `db.close()` 绕过 Kysely） | `tests/helpers/sqlite.ts`；`tests/session-repository.test.ts`、`tests/project-repository.test.ts`、`tests/sqlite-idempotency-repository.test.ts` |

**最终验收（真实 PG URL 运行的 actual reporter 输出，非编造）**：`volta run pnpm verify:release`（typecheck + test + test:postgres + build，设置 `PI_TEST_PG_URL` 真实 PG）**全部通过**——全量 `volta run pnpm test` = **54 文件 / 563 用例，无 skip，全部通过**（PG 门控在真实 URL 下真实执行，不再 skip）；`volta run pnpm test:postgres` = **45 个 PG 门控用例全部通过**（22 契约 + 2 真实 23505 + 21 集成，其中含 2 个严格 preflight 用例）。发布门禁机制保持：无 `PI_TEST_PG_URL` 时 `pnpm test:postgres` 仍按设计非零退出、普通 `pnpm test` 仍按门控 skip（复跑基线）。

## 6. 执行顺序与依赖

```text
A. ID 有界重试 ✅ 已完成（现有 SQLite 测试 + build）
B. Schema Manifest + 类型推导 + SQLite 改造 ✅ 已完成（SQLite 全部测试 + build + schema contract tests + typecheck）
C. PostgreSQL bootstrap + Repository 方言中立化 ✅ 已完成（真实 PG 集成测试由 PI_TEST_PG_URL 门控，工作包 D 已跑通）
D. PostgreSQL 集成测试 + 文档 ✅ 已完成（真实 PG 环境执行 tests/postgres/** 17 用例全绿，完成双库验收）
E. 最终测试审计补强（H2/H4/H5/H6/M1/M2） ✅ 已完成（PG 门控用例扩展至 45 个，真实 PG 复跑已由用户 `volta run pnpm verify:release` 全部通过，见 §5E）
```

**关键约束：**

- 严格按 A → B → C → D 顺序执行，每项完成后必须跑对应测试和 build。
- **PG 实现需真实 PG 验证（已满足）**：工作包 D 已用 `PI_TEST_PG_URL`（真实 PG）执行 `tests/postgres/**` 全部通过，Phase 2 据此整体完成；未设门控时该组仍为 skip，复跑流程见 [postgres-podman-test.md](postgres-podman-test.md)。
- B 与 C 之间：C 的 Repository 方言中立化依赖 B 的 Manifest 稳定；若 Manifest 在 C 阶段有调整，需回跑 B 的测试。

## 7. 非目标

以下明确不在 Phase 2 范围内：

- **不加业务表**：不新增 `messages`、`users` 等业务表，不加 JOIN / 动态查询。
- **不做正式 migration**：不引入 `kysely_migration` 或其他 migration 框架；RC 阶段旧库仍走删库重建。
- **不做备份/回滚**：Phase 2 不涉及备份策略或数据回滚机制。
- **不改变 HTTP 路由**：不新增、删除或修改现有 HTTP 路由。
- **不改 `/health`**：`/health` 端点保持当前语义，不改为 DB ping。
- **不做 JSONB**：PostgreSQL 的 JSON 字段保持 `TEXT`，不在本阶段改 JSONB。

## 8. 风险与门槛

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| **PG BIGINT parser** | `node-postgres` 默认将 `int8` 读回为 `string`，时间戳读回后类型不匹配 | 连接级或查询级 `pg.types` 配置；Repository 层显式 `Number()` 转换；确认毫秒时间戳在安全整数范围内 |
| **UUID 类型差异** | SQLite 用 `TEXT` 存 UUID，PG 用原生 `UUID` 类型；应用层读写需兼容 | Repository 层统一用 `string` 语义；PG bootstrap 用 `UUID` 类型；插入/读取由 Kysely 抽象 |
| **DDL 方言差异** | SQLite 与 PG 的 `CREATE TABLE`、`CREATE INDEX`、FK 语法有差异 | Manifest → 方言特定 DDL 生成器分离；SQLite 和 PG 各有独立 bootstrap 函数；schema contract tests 覆盖 |
| **测试环境** | 缺少真实 PG 实例无法验证 | ✅ 已解决：本机经 Podman 临时 PG + `PI_TEST_PG_URL` 门控完成真实验收（见 [postgres-podman-test.md](postgres-podman-test.md)）；CI 仍宜配置 PG service container 复跑 |
| **数据库保留承诺** | 一旦保留真实用户数据，必须停止 destructive reset，引入正式迁移 | RC 阶段明确不保留真实数据；Phase 2 完成后，若进入生产必须先建立迁移/备份策略再接受真实数据 |

## 9. 完成定义

> **现状（如实分账）**：Phase 2 已全部完成并通过最终发布门禁——工作包 A/B/C/D 与最终测试审计补强（§5E：H2/H4/H5/H6/M1/M2）均已完成，**`volta run pnpm verify:release`（设置真实 PG `PI_TEST_PG_URL`）全部通过**：全量 `pnpm test` = 54 文件 / 563 用例、无 skip，`pnpm test:postgres` 的 45 个 PG 门控用例全部通过。
> **最终验收结果（最终 reporter，真实 PG URL 运行）**：全量 `volta run pnpm test` = **54 文件 / 563 用例，无 skip，全部通过**；`volta run pnpm test:postgres` = **45 个 PG 门控用例全部通过**；`volta run pnpm verify:release`（typecheck + test + test:postgres + build）整体通过。（历史实录：早期 SQLite 基线 49 文件 / 485 用例（468 passed + 17 skipped）、历史 17 用例 PG 基线、以及最终审计补强后无 URL 的 54 文件（52 passed、2 skipped）/ 563 用例（518 passed、45 skipped）——均为各次运行的实时计数，最终以 `verify:release` 为准。）
>
> **发布门禁**：不得在 typecheck 未跑或 PG 测试被 skip 时宣称完整验收。`pnpm verify:release` = typecheck + test + test:postgres + build（真实 PG 必须运行并通过）；`release:rc` 调用它。无 `PI_TEST_PG_URL` 时 `pnpm test:postgres` 非零退出（说明原因）、普通 `pnpm test` 该组 skip；Gate runner 为跨平台 Node 脚本 `scripts/test-postgres.ts`（含 `tests/tools/test-postgres-runner.test.ts` 验证）。

Phase 2 视为完成，当且仅当以下全部条件满足——**当前已全部满足，并经 `volta run pnpm verify:release`（真实 PG `PI_TEST_PG_URL`）确认**：

1. ✅ **SQLite 空库启动**：`initializeDatabase()` 改为消费 Manifest 后，空库可正常启动并完成 bootstrap。
2. ✅ **PostgreSQL 空库启动**：PG 空库通过 Manifest 推导的 DDL 完成 bootstrap，表/列/FK/索引与 SQLite 等价（真实 PG 验证通过，含严格 schema preflight）。
3. ✅ **当前 API 一致**：所有 HTTP 路由、Port API 签名与行为不变。
4. ✅ **隔离一致**：`owner_key` 隔离、默认项目共享语义在 SQLite 与 PG 上一致。
5. ✅ **幂等一致**：`idempotency` 表的复合主键、`ON CONFLICT`、TTL 清理在双库上一致。
6. ✅ **双库测试通过**：全量 `pnpm test`（真实 PG URL）54 文件 / 563 用例无 skip 全部通过；`pnpm test:postgres` 的 45 个 PG 门控用例全部通过；用例顺序无关（每用例前 TRUNCATE + 独立 Pool 关闭用例，见 database-design.md §9.6）。
7. ✅ **构建通过**：`volta run pnpm build` 无错误（`volta run pnpm typecheck` 亦通过）。
8. ✅ **文档更新**：README、`database-design.md`、本文档反映最终状态。

## 10. 相关文档

- 数据库详细设计：[database-design.md](database-design.md)
- 架构速览：[architecture.md](architecture.md)
- 需求基线：[../needs.md](../needs.md)
- 归档交付计划：[archive/delivery-plan.md](archive/delivery-plan.md)
