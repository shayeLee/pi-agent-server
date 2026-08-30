# 数据库设计（RC / SQLite）

> RC 阶段 SQLite 详细设计，单一事实来源的表/字段/约束/索引/查询与幂等规则。本文可独立阅读，但源码为准：`src/storage/db-schema.ts` / `src/storage/bootstrap.ts` / `src/storage/sqlite-*-repository.ts` / `src/runtime/runtime-registry.ts` / `src/application/ports/*-store-port.ts`。

## 1. 范围与源码依据

- **当前形态**：RC（Release Candidate）阶段的 SQLite schema，以 Kysely 0.29.5 + `node:sqlite` 薄适配器 + `SqliteDialect` 承载。
- **源码依据**：
  - 类型化 schema：`src/storage/db-schema.ts`（`ProjectsTable` / `SessionsTable` / `IdempotencyTable` / `DatabaseSchema`）；
  - 建库 DDL：`src/storage/bootstrap.ts` 的 `initializeDatabase()`（`Kysely.schema.createTable(...).ifNotExists()` / `createIndex(...).ifNotExists()`）；
  - 行映射与查询：`src/storage/sqlite-project-repository.ts` / `sqlite-session-repository.ts` / `sqlite-idempotency-repository.ts` 的 `toRecord()` 与 Port 实现；
  - 幂等 TTL：`src/runtime/runtime-registry.ts` 的 `DEFAULT_IDEMPOTENCY_TTL_MS` 与定期 `prune()`。
- **运行期选项**：`src/server/start.ts` 创建 `DatabaseSync` 时启用 `timeout: 5000` 与 `enableForeignKeyConstraints: true`；文件库（非 `:memory:`）执行 `PRAGMA journal_mode=WAL`。

### 当前实现与目标演进

- **当前为两处人工定义（RC 过渡态）**：schema 目前由 `src/storage/db-schema.ts`（Kysely 查询类型：`ProjectsTable` / `SessionsTable` / `IdempotencyTable` / `DatabaseSchema`）与 `src/storage/bootstrap.ts`（DDL：`addColumn` / `defaultTo` / `primaryKey` 等）两处人工维护；每次字段或约束变更都需同步修改这两处及 Repository、测试。本文其余内容（§3 表结构、§4 约束索引等）描述的是**当前**这两份代码的实际定义，并非来自单一来源。
- **已确认的演进方向（PostgreSQL 之前）**：已确认在引入 PostgreSQL 之前实施 Schema Manifest 单一来源——运行时 Schema Manifest 成为唯一 schema 来源，从 manifest 自动推导 Kysely `DatabaseSchema` 与 SQLite/PG 两个数据库的 bootstrap，不再手维护 `db-schema.ts` 与两份字段定义。
- **当前尚未实现**：上述 Manifest 单一来源与自动推导**尚未实现**，属于已确认的演进方向但尚未落地；本文当前章节描述的就是实现前的过渡态。

## 2. 总体设计

- **数据库只存索引与配置**：`projects` / `sessions` 存项目与会话的索引、归属、时间戳与会话级配置；`idempotency` 存幂等终态。不存完整消息正文、工具调用历史或对话内容。
- **完整对话历史在 JSONL**：`sessions.pi_session_file` 指向 Pi SDK 管理的 JSONL 会话文件（`SessionManager.create/open` 产生），重启后据此恢复对话。SQLite（元数据）与 JSONL（完整历史）是两个独立存储系统，无法合并为单个原子事务；写入顺序与残余边界见下方 `### JSONL 与 SQLite 的跨存储边界`。
- **命名映射**：数据库列为 `snake_case`（`owner_key` / `created_at` / `pi_session_file` 等），领域记录为 `camelCase`（`ownerKey` / `createdAt` / `piSessionFile`），由各 Repository 的 `toRecord(row)` 显式映射，`db-schema.ts` 本身不做转换。
- **应用 ID 与时间**：所有 `id` 由应用层生成（`randomUUID` 等），`created_at` / `updated_at` 为应用写入的毫秒时间戳（`Date.now()`），非数据库自增或 `DEFAULT CURRENT_TIMESTAMP`。

### JSONL 与 SQLite 的跨存储边界

- **两个存储系统，非单事务**：`projects` / `sessions` 等元数据存 SQLite；完整对话历史存 Pi SDK 管理的 JSONL。二者分属不同存储，无法参与同一个原子事务，跨存储的「要么全成、要么全无」无法由数据库本身保证。
- **创建顺序（降低 DB 指向不存在文件的风险）**：
  1. 先创建 SQLite 会话记录，`pi_session_file = null`（见 `session-service.ts` 的 `createSession`，`piSessionFile: null`）；
  2. 首次发消息时由 Pi 经 `SessionManager.create`（或 `open` 既有文件）创建/打开 JSONL 文件（`server/start.ts` 据 `record.piSessionFile` 决定 create/open）；
  3. JSONL 创建成功后，把 `session.sessionFile` 回写 SQLite（`sessions.update(id, { piSessionFile })`）。


  这一顺序保证：只有文件已存在，DB 才会记录其路径，因此降低了「DB 指向不存在文件」的概率。
- **残余边界（无自动对账）**：若 JSONL 文件创建成功、但 SQLite 回写 `pi_session_file` 之前进程中断，会留下一个物理 JSONL 文件，而 DB 中该会话的 `pi_session_file` 仍为 `null`。当前 RC 没有后台扫描/对账任务去补回该路径；该文件不会出现在会话列表（SQLite 无可见记录），需人工排查或后续补偿处理。
- **删除顺序（文件删除失败可能留物理残留）**：
  1. 先逻辑删除 SQLite 会话元数据（`sessions.delete`，会话对外不可见）；
  2. 再清理 runtime（`registry.delete`）；
  3. 最后删除 JSONL 物理文件（`removeSessionFile`）。


  若第 3 步文件删除失败（权限/磁盘等），会留下不再被 DB 引用的物理残留；当前可人工/后续补偿处理，没有持久化的清理队列或定时任务。
- **`ensureDefaultProject` 与 `backfillSystemPrompt` 均非 JSONL/SQLite 对账**：
  - `ensureDefaultProject` 仅用于确保 SQLite 默认项目记录存在（`INSERT OR IGNORE`，`id=DEFAULT_PROJECT_ID`（`6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c`）、空 owner），服务于外键不变量，与 JSONL 无关；
  - `backfillSystemPrompt` 仅补写 SQLite `sessions` 中 `system_prompt` 为 `null` 的字段，与 JSONL 无关。


  二者都不能弥合上述跨存储边界。
- **当前不提供**：没有自动对账/恢复（reconcile）任务、没有 outbox/写前日志、没有持久化清理队列，也不对任何跨存储操作提供强一致（strong consistency）保证。

## 3. 表结构

> 下表与 `src/storage/db-schema.ts` 的接口字段及 `src/storage/bootstrap.ts` 的 `addColumn` / `defaultTo` / `primaryKey` / `addPrimaryKeyConstraint` 定义完全一致。`text` / `integer` 为 SQLite 亲和类型在 Kysely 中的声明。

### 3.1 projects（项目索引）

| 列名 | 类型 | 可空 | 主键/默认值 | 语义 |
| --- | --- | --- | --- | --- |
| `id` | `text` | NOT NULL | PK（`col.primaryKey()`） | 项目 ID，固定保留值 `DEFAULT_PROJECT_ID`（=`6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c`）为共享默认项目 |
| `name` | `text` | NOT NULL | — | 项目展示名（默认项目为 `默认项目`） |
| `cwd` | `text` | NOT NULL | — | Agent 工作目录绝对路径；默认项目取服务端 `cwd`，额外项目由创建者指定 |
| `owner_key` | `text` | NOT NULL | — | 归属标识 `identityKey(UserIdentity)`；默认项目为 `''`（空串，见 §5） |
| `created_at` | `integer` | NOT NULL | — | 创建时间，毫秒时间戳 |

- **源码**：`ProjectsTable` 5 列；`bootstrap.ts` 按此顺序 `addColumn`，全部 `notNull()`，`id` 为 `primaryKey()`。
- **Repository 映射**：`sqlite-project-repository.ts` 的 `toRecord` 映射 `owner_key`→`ownerKey`、`created_at`→`createdAt`；`create()` 禁止写入 `id=DEFAULT_PROJECT_ID`，`ensureDefaultProject()` 独占该 ID。

### 3.2 sessions（会话索引）

| 列名 | 类型 | 可空 | 主键/默认值 | 语义 |
| --- | --- | --- | --- | --- |
| `id` | `text` | NOT NULL | PK | 会话 ID（应用生成 UUID） |
| `owner_key` | `text` | NOT NULL | — | 归属 `identityKey`，用于按用户隔离（`listByOwner` / `listByProject` 均带此条件） |
| `project_id` | `text` | NOT NULL | 默认 `DEFAULT_PROJECT_ID`（`defaultTo(DEFAULT_PROJECT_ID)`，即 `6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c`） | 所属项目，FK 指向 `projects.id`，未显式指定时归默认项目 |
| `title` | `text` | NOT NULL | — | 会话标题 |
| `created_at` | `integer` | NOT NULL | — | 创建时间，毫秒时间戳 |
| `updated_at` | `integer` | NOT NULL | — | 更新时间，毫秒时间戳（列表排序键） |
| `pi_session_file` | `text` | NULL | — | Pi JSONL 文件绝对路径；首次发消息前为 `null`，首次 `prompt` 后懒创建并回写 |
| `model_provider` | `text` | NULL | — | 会话级模型 provider（`null` 表示沿用服务端默认） |
| `model_id` | `text` | NULL | — | 会话级模型 id（同上） |
| `thinking_level` | `text` | NULL | — | 思考级别（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，`null` 为默认） |
| `system_prompt` | `text` | NULL | — | 创建时冻结的系统提示词；历史会话 `backfillSystemPrompt()` 补齐一次 |
| `capability_versions` | `text` | NULL | — | 创建时冻结的能力版本快照（JSON：`id→version`，`null` 为无能力） |

- **源码**：`SessionsTable` 12 列；`bootstrap.ts` 中 `id` 为 `primaryKey()`，`project_id` 带 `defaultTo(DEFAULT_PROJECT_ID)`（引用 `src/application/ports/project-store-port.ts` 的同一常量，不硬编码字符串），其余 6 个扩展列（`pi_session_file` 等）无 `notNull()` 即为可空。
- **Repository 映射**：`sqlite-session-repository.ts` 的 `toRecord` 逐列映射为 `SessionRecord`（`ownerKey` / `projectId` / `piSessionFile` 等）；`update()` 仅写入 `patch` 中显式非 `null` 的字段。

### 3.3 idempotency（请求幂等终态）

| 列名 | 类型 | 可空 | 主键/默认值 | 语义 |
| --- | --- | --- | --- | --- |
| `session_id` | `text` | NOT NULL | 复合 PK 之一（`idempotency_pk`） | 会话维度，与 `request_id` 共同定位一条幂等记录 |
| `request_id` | `text` | NOT NULL | 复合 PK 之一 | 客户端生成的请求 ID（`POST /v1/sessions/:id/messages` 必须携带 `requestId`） |
| `result` | `text` | NOT NULL | — | 完成结果的 JSON 序列化（`JSON.stringify(result)`），`{ status: "completed" | "error" | "aborted" }` 等终态 |
| `created_at` | `integer` | NOT NULL | — | 写入时间，毫秒时间戳，用于 TTL 清理排序 |

- **源码**：`IdempotencyTable` 4 列；`bootstrap.ts` 以 `addPrimaryKeyConstraint("idempotency_pk", ["session_id", "request_id"])` 建立复合主键。
- **Repository**：`sqlite-idempotency-repository.ts` 的 `get()` 解析 `result` JSON，`put()` 以 `onConflict(columns(["session_id","request_id"])).doUpdateSet({ result, created_at })` 覆盖，`prune(before)` 按 `created_at < before` 删除。

## 4. 约束、外键、索引

### 4.1 projects

- **主键**：`projects.id` PRIMARY KEY。
- **索引**：`idx_projects_owner` ON `projects(owner_key)`（`createIndex(...).on("projects").column("owner_key")`），用于 `listByOwner(ownerKey)`。
- **无外键**：作为 `sessions.project_id` 的被引用端。

### 4.2 sessions

- **主键**：`sessions.id` PRIMARY KEY。
- **外键**：`CONSTRAINT sessions_project_id_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE`。
  - 创建顺序要求 `projects` 先于 `sessions`；
  - `ON DELETE CASCADE` 为数据库层兜底：即使应用层 `deleteProjectWithSessions()` 遗漏，删项目也不会留下孤儿会话；
  - 应用层删除项目走 `SqliteProjectRepository.deleteProjectWithSessions()` 的 `transaction()`（先删 `sessions` 再删 `projects`），与 FK 双重保障。
- **索引**：
  - `idx_sessions_owner_updated` ON `sessions(owner_key, updated_at DESC)` —— 服务于 `listByOwner(ownerKey) ORDER BY updated_at DESC, id DESC`（`updated_at` 倒序为查询主排序键）；
  - `idx_sessions_owner_project` ON `sessions(owner_key, project_id)` —— 服务于 `listByProject(ownerKey, projectId) ORDER BY updated_at DESC, id DESC`（按项目过滤）。
  - `sqlite-session-repository.ts` 与 `sqlite-project-repository.ts` 的 `listByOwner` / `listByProject` 均显式 `orderBy("updated_at","desc").orderBy("id","desc")`（`id` 倒序为并列时的确定性次级排序）。

### 4.3 idempotency

- **主键**：复合主键 `PRIMARY KEY (session_id, request_id)`（约束名 `idempotency_pk`），保证同一会话内 `requestId` 唯一（不同会话的同 `requestId` 互不影响）。
- **索引**：`idx_idempotency_created_at` ON `idempotency(created_at)` —— 服务于 TTL 清理 `DELETE FROM idempotency WHERE created_at < :before`（`SqliteIdempotencyRepository.prune` 与 `RuntimeRegistry` 定期清理共用）。
- **无外键**：`session_id` 不建 FK，避免会话删除后仍需保留幂等记录至 TTL。

## 5. 共享默认项目与会话隔离

- **默认项目**：`projects` 中固定一行 `id=DEFAULT_PROJECT_ID`（`6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c`）、`owner_key=''`（空串）、`name='默认项目'`、`cwd=<服务端 cwd>`、`created_at=0`。由 `src/server/start.ts` 在 `initializeDatabase()` 之后经 `SqliteProjectRepository.ensureDefaultProject()` 以 `INSERT ... ON CONFLICT(id) DO NOTHING` 幂等写入。
  - 不变量：`ensureDefaultProject` 校验 `id` 必须为 `DEFAULT_PROJECT_ID` 且 `ownerKey` 必须为 `''`，既有行若 `owner_key != ''` 则抛错；`create()` 与 `delete()` 均拒绝 `id=DEFAULT_PROJECT_ID`，防止把私有项目写成共享或误删默认项目。
  - 含义：`owner_key=''` 表示**所有用户共享可见**，不归属任何单一用户。
- 会话永远按 `owner_key` 隔离，且 `ProjectDto.isDefault` 由服务端下发：默认项目在 `GET /v1/projects` 中标记 `isDefault: true`，Web 侧据此推导默认项目 id，不硬编码任何项目 id。
- **会话永远按 `owner_key` 隔离**：`sessions` 的 `listByOwner` / `listByProject` 均以 `WHERE owner_key = :ownerKey` 为前置条件；即使 `project_id=DEFAULT_PROJECT_ID`，也只返回当前用户的会话。项目共享不等于会话共享。
- **参数化 SQL 示例**（`listByProject` 实际执行形态）：
  ```sql
  SELECT * FROM sessions
  WHERE owner_key = :ownerKey
    AND project_id = '6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c'
  ORDER BY updated_at DESC, id DESC;
  ```
  对应 `SessionStorePort.listByProject(ownerKey, DEFAULT_PROJECT_ID)`（`sqlite-session-repository.ts` 的 Kysely 实现为 `.where("owner_key","=",ownerKey).where("project_id","=",projectId).orderBy("updated_at","desc").orderBy("id","desc")`）。
- **访问矩阵**：
  | 场景 | `projects` 可见性 | `sessions` 可见性 |
  | --- | --- | --- |
  | 默认项目 `DEFAULT_PROJECT_ID` | 所有用户可见（`owner_key=''`） | 仅自己的会话（`owner_key = :ownerKey AND project_id=DEFAULT_PROJECT_ID`） |
  | 额外项目 | 仅创建者可见（`WHERE owner_key = :ownerKey`） | 仅创建者可见（同上双重隔离） |

## 6. 请求幂等与 TTL

- **要解决的问题**：`POST /v1/sessions/:id/messages` 的网络重试、客户端双击、超时重发可能导致同一意图被执行多次。服务端按客户端生成的 `requestId` 去重，重复提交返回同一结果，不重复触发模型调用。
- **`requestId` 行为**：键为 `(session_id, request_id)`（`idempotency` 复合主键）；同一会话内同 `requestId` 的第二次提交命中去重，不同会话的同 `requestId` 互不干扰。
- **三态**（`src/core/idempotency.ts` 的 `IdempotencyStore` 与 `src/runtime/session-runtime.ts` 的 `submitMessage` / `doSubmit`）：
  - `new`：首次提交，放行执行；
  - `processing`：同一 `requestId` 正在执行中（内存 `processing` 集合 + `inFlightSubmits` 去重），返回 `queued`/`run` 的“已接受”语义，不重复排队或执行；
  - `done`：已完成，返回 `result` 中保存的终态（`{ status: "completed" | "error" | "aborted" }`），不重复执行。内存 `done` 快路径，`miss` 时查 `IdempotencyStorePort.get()`（SQLite）回填。
- **`result` 字段**：仅保存**完成后的终态结果**，由 `SessionRuntime.settle()` 在 `completed`/`error`/`aborted` 时 `idempotency.complete(key, result)` 并异步 `idempotencyRepo.put(sessionId, requestId, result)` 落库；尚未产生副作用的拒绝/冲突路径（`rejected`/`conflict`/排队取消）走 `idempotency.fail(key)` 释放重试资格，不落库。
- **TTL（Time To Live，存活时间）**：幂等记录非永久，过期后同 `requestId` 不再保证去重。
  - 默认值：`24h`（`24 * 60 * 60 * 1000 ms`），定义于 `src/runtime/runtime-registry.ts` 的 `DEFAULT_IDEMPOTENCY_TTL_MS`，经 `RuntimeRegistryOptions.idempotencyTtlMs` 可覆盖；
  - 清理时机：启动时立即 `prune(now - ttl)` 一次 + 每 `expireIntervalMs`（默认 30s）定期扫描 `concurrency.expireQueued(now)` 与 `runtime.pruneIdempotency(before)` 及 `idempotencyRepo.prune(before)`；墓碑 `deleted` 另有 `TOMBSTONE_TTL_MS = 24h` 清理；
  - 语义：`prune(before)` 删除 `created_at < before` 的记录，过期后重发同 `requestId` 将被视为 `new` 重新执行。
- **正名**：本机制是“**请求幂等**”（同一 `requestId` 的重复提交去重），**不是**“消息去重”或“永久防重”。不要误称为消息去重、内容去重或永久防重。

## 7. 设计原则和非目标

### 原则

- **多用户/多项目**：所有查询以 `owner_key`（`identityKey(UserIdentity)`）隔离；额外项目按 `owner_key` 私有，默认项目按 `owner_key=''` 共享；会话隔离与项目可见性正交（见 §5）。
- **外键完整性**：`sessions.project_id → projects.id ON DELETE CASCADE`，建库启用 `enableForeignKeyConstraints: true`，应用层 `transaction()` 与数据库 FK 双重保证无孤儿会话。
- **查询索引**：所有列表查询均有覆盖索引（`idx_projects_owner` / `idx_sessions_owner_updated` / `idx_sessions_owner_project` / `idx_idempotency_created_at`），排序键与索引列一致。
- **应用 ID/毫秒时间戳**：`id` 由应用生成，`created_at`/`updated_at` 为 `Date.now()` 毫秒值，便于跨 SQLite/PostgreSQL 保持语义一致（PostgreSQL 阶段共用 `db-schema.ts`）。

### 非目标（当前不做）

- **不建 `users` / `messages` 表**：用户身份由 `UserIdentity` 派生的 `owner_key` 字符串承载，无需用户表；完整消息正文在 `pi_session_file` 指向的 JSONL 中，不在数据库中镜像 `messages` 表（避免双写一致性与大文本存储问题）。
- **不做版本化迁移**：RC 阶段无 `kysely_migration` 机制，`bootstrap.ts` 仅 `IF NOT EXISTS` 面向空库/当前 schema；旧库直接删除重建。
- **不做 SQLite→PostgreSQL 数据迁移**：Phase 2 仅要求空 PG 库可初始化出一致 schema。

### 未来扩展

- 扩展前必须先产出：实体/字段/关系、查询清单（JOIN / filter / sort / page / aggregation）、索引/权限、Port/Repository 草案；
- 实现顺序：`db-schema.ts` → `bootstrap.ts`（SQLite/PG 各自方言）→ `Repository`/`Port` → `Service` → `API` → `Test`；
- 一旦开始保留真实用户数据，立即**停止 destructive reset**，并建立正式迁移、备份、回滚与数据迁移策略（冻结删库重建，引入备份、回滚与数据迁移）。

## 8. 相关文档

- 核心数据流、端口契约与解耦边界：[architecture.md](architecture.md)
- 需求基线（会话/项目/幂等/并发/工具与权限）：[../needs.md](../needs.md)
