# Phase 2 执行计划：Schema Manifest 单一来源 + PostgreSQL 支持

> 本文是 Phase 2 的可独立阅读执行计划，固化当前已确认的方案、数据策略与验收标准。
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

> ⚠️ 注意：上述仅是 Phase 2 的前置项，**不意味着 Phase 2 整体已完成**。Phase 2 的核心工作（Schema Manifest、PostgreSQL 支持）尚未实施。

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
- **pg int8 读回 string 问题**：PostgreSQL `node-postgres` 默认将 `BIGINT`（int8）读回为 `string` 以避免 JavaScript 精度丢失。必须在连接或查询层面处理此问题，确保读回后转为 `number`（确认值在 `Number.MAX_SAFE_INTEGER` 安全范围内——毫秒时间戳在可预见的未来不会超出）。
- **安全整数范围**：毫秒时间戳当前约 $1.7 \times 10^{12}$，`Number.MAX_SAFE_INTEGER` 约 $9 \times 10^{15}$，安全余量充足。但 Repository 层应显式 `Number(value)` 转换并保持防御性。

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

### A. 服务端 ID 保留值 / 唯一冲突的有界重试

**目标**：对普通项目和会话的 UUID 生成引入有界重试，处理极低概率的主键冲突；`DEFAULT_PROJECT_ID` 保留 ID 不向用户暴露 500。

**工作项：**

1. 项目/会话创建时，若 `INSERT` 因主键冲突失败（`UNIQUE` / `PRIMARY KEY`），自动重试生成新 UUID 并重试插入，最多重试 N 次（建议 3 次）。
2. 超出重试上限时返回明确错误（500 + 日志），不静默吞掉。
3. `DEFAULT_PROJECT_ID` 的 `ensureDefaultProject()` 已有 `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING` 保护；确认其不向用户暴露 500（冲突时幂等忽略即可）。
4. DB 主键约束继续作为最终兜底。

**验收：**
- 单元测试覆盖：模拟主键冲突 → 重试成功 / 超限失败。
- SQLite + PG（mock 或真实）均通过。
- `npm run build` 通过。

---

### B. Schema Manifest 与类型推导

**目标**：引入运行时 Schema Manifest 作为 schema 唯一来源，自动推导 Kysely `DatabaseSchema`；SQLite bootstrap 改为消费 Manifest。

**建议的文件/模块职责：**

| 文件 | 职责 |
|------|------|
| `src/storage/schema-manifest.ts` | Schema Manifest 定义：声明每张表的列（逻辑列类型、nullable、default、PK、FK、index） |
| `src/storage/schema-types.ts` | 从 Manifest 推导 Kysely `DatabaseSchema` 类型（TypeScript 类型层面） |
| `src/storage/bootstrap-sqlite.ts`（或改造 `bootstrap.ts`） | 从 Manifest 生成 SQLite 方言 DDL 并执行 |
| `src/storage/db-schema.ts` | **过渡态**：当前手写 interface；Manifest 推导完成后不再手维护，最终可删除或仅保留为回退参考 |

**Manifest 应声明的信息：**

- 每张表的列名、逻辑列类型（`uuid` / `text` / `integer` / `bigint` / `json`）、是否 nullable、默认值。
- 主键（单列或复合）。
- 外键约束（源列 → 目标表.目标列，`ON DELETE` 行为）。
- 索引（列列表、排序、唯一性）。

**类型推导：**

- 从 Manifest 的逻辑列类型推导 TypeScript 类型（`uuid` → `string`，`integer` → `number`，`json` → `string | null` 等）。
- 自动产出 `DatabaseSchema` 接口，替代手工维护的 `db-schema.ts`。

**验收：**
- Manifest 定义与当前 `db-schema.ts` + `bootstrap.ts` 的实际 schema 完全一致。
- SQLite 空库 bootstrap 改为消费 Manifest 后，行为不变（`CREATE TABLE IF NOT EXISTS` + 索引 + FK）。
- `DatabaseSchema` 类型由 Manifest 自动推导，`db-schema.ts` 手写 interface 不再是必须维护的文件。
- schema contract tests：Manifest 定义 → SQLite bootstrap → 查询可用 → 类型安全。
- 现有 SQLite 测试全部通过。
- `npm run build` 通过。

---

### C. PostgreSQL 支持

**目标**：引入 PostgreSQL bootstrap，从同一 Manifest 推导 PG DDL；Repository 层方言中立化。

**依赖与配置：**

1. 新增 `pg`（`node-postgres`）依赖。
2. 引入 `Pool` + `PostgresDialect`（Kysely 官方 PG 适配器）。
3. 显式 provider / connection config：阅读现有 config（`src/server/start.ts`、环境变量惯例）后，采用兼容命名方案。**不要在文档编造已实现的 env**——实际实现时根据现有 config 模式确定 PG 连接参数（如 `PI_PG_URL` 或分拆的 host/port/user/password/database）。

**PG bootstrap 类型映射（Manifest 逻辑类型 → PG DDL）：**

| Manifest 逻辑类型 | SQLite DDL | PostgreSQL DDL |
|-------------------|------------|----------------|
| `uuid` | `TEXT` | `UUID` |
| `text` | `TEXT` | `TEXT`（`VARCHAR`） |
| `integer` | `INTEGER` | `BIGINT`（毫秒时间戳） |
| `json` | `TEXT` | `TEXT`（非 JSONB） |

**Pool 生命周期：**

- 启动时创建 Pool，关闭时 `pool.end()`。
- 与 SQLite `DatabaseSync` 的生命周期对齐（在 `start.ts` 的 composition root 中管理）。

**Repository 方言中立化：**

- 尽可能使用 Kysely 的方言无关 API（`.where()`、`.insert()`、`.update()`、`.deleteFrom()`）。
- 保留 `Number(numAffected)` 语义（PG 返回 `bigint`，需 `Number()` 转换）。
- 保留 JSON text 语义（`JSON.stringify` 写入、`JSON.parse` 读回）。
- `ON CONFLICT` 语法差异：SQLite 用 `doUpdateSet()`，PG 用 `onConflict().doUpdateSet()`（Kysely 已抽象，确认兼容）。

**验收：**
- PG bootstrap 从同一 Manifest 创建等价 schema（表、列、FK、索引）。
- Pool 创建/销毁生命周期正确。
- SQLite 测试仍然全部通过（Manifest 改动未破坏 SQLite）。
- `npm run build` 通过。

---

### D. PostgreSQL 测试 / 交付

**目标**：真实空 PG 集成测试，验证双库契约一致。

**测试环境门控：**

- 建议使用 `PI_TEST_PG_URL` 环境变量门控 PG 集成测试。
- 未设置时跳过 PG 测试（`describe.skip` 或条件注册），不影响 SQLite 测试。
- **未提供 PG 环境不能宣称 Phase 2 完成。**

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

**验收：**
- 真实 PG 空库集成测试通过。
- SQLite 测试全部通过。
- `npm run build` 通过。
- 文档更新。

## 6. 执行顺序与依赖

```text
A. ID 有界重试
  ↓ 完成后跑：现有 SQLite 测试 + build
B. Schema Manifest + 类型推导 + SQLite 改造
  ↓ 完成后跑：SQLite 全部测试 + build + schema contract tests
C. PostgreSQL bootstrap + Repository 方言中立化
  ↓ 完成后跑：SQLite 全部测试 + build（PG 实现需真实 PG 验证）
D. PostgreSQL 集成测试 + 文档
  ↓ 完成后跑：SQLite 测试 + PG 测试 + build
```

**关键约束：**

- 严格按 A → B → C → D 顺序执行，每项完成后必须跑对应测试和 build。
- **PG 实现需真实 PG 验证**：未提供 PG 环境（`PI_TEST_PG_URL`），不能宣称 Phase 2 完成。
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
| **测试环境** | 缺少真实 PG 实例无法验证 | `PI_TEST_PG_URL` 门控；CI 配置 PG service container；本地开发可用 Docker PG |
| **数据库保留承诺** | 一旦保留真实用户数据，必须停止 destructive reset，引入正式迁移 | RC 阶段明确不保留真实数据；Phase 2 完成后，若进入生产必须先建立迁移/备份策略再接受真实数据 |

## 9. 完成定义

Phase 2 视为完成，当且仅当以下全部条件满足：

1. **SQLite 空库启动**：`initializeDatabase()` 改为消费 Manifest 后，空库可正常启动并完成 bootstrap。
2. **PostgreSQL 空库启动**：PG 空库通过 Manifest 推导的 DDL 完成 bootstrap，表/列/FK/索引与 SQLite 等价。
3. **当前 API 一致**：所有 HTTP 路由、Port API 签名与行为不变。
4. **隔离一致**：`owner_key` 隔离、默认项目共享语义在 SQLite 与 PG 上一致。
5. **幂等一致**：`idempotency` 表的复合主键、`ON CONFLICT`、TTL 清理在双库上一致。
6. **双库测试通过**：SQLite 测试全部通过；PG 集成测试在 `PI_TEST_PG_URL` 可用时通过。
7. **构建通过**：`npm run build` 无错误。
8. **文档更新**：README、`database-design.md`、本文档反映最终状态。

## 10. 相关文档

- 数据库详细设计：[database-design.md](database-design.md)
- 架构速览：[architecture.md](architecture.md)
- 需求基线：[../needs.md](../needs.md)
- 归档交付计划：[archive/delivery-plan.md](archive/delivery-plan.md)
