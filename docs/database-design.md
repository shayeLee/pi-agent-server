# 数据库设计（RC / SQLite + PostgreSQL）

> RC 阶段 SQLite/PostgreSQL 双方言设计，单一事实来源的表/字段/约束/索引/查询、幂等与 file-operation outbox 规则。本文可独立阅读，但源码为准：schema 定义与建库 DDL 的**唯一来源**是 `src/storage/schema-manifest.ts`（当前为唯一 canonical baseline，运行时 Manifest 含编译期/运行期校验），`DatabaseSchema` 类型由其推导（`src/storage/schema-types.ts`，`db-schema.ts` 仅为兼容 re-export）；查询与存储规则见 `src/storage/kysely-*-repository.ts` / `src/runtime/runtime-registry.ts` / `src/application/ports/*-store-port.ts`。
>
> **当前状态**：RC 阶段 SQLite + PostgreSQL 双方言，schema Manifest 为唯一来源。WP4A 的 `file_operations` 持久
> outbox 保留（删除事务只 enqueue，绝不物理删除文件）；WP4B 提供安全只读 planner（物理 executor 包括 unlink、
> retry/quarantine 未实现）；WP4C 提供 DB-only reconcile analyzer（只读 DB 引用分析，绝不扫描文件系统、不读取
> JSONL）。这些能力仍是离线开发期工具，不启动正式服务，整体尚非生产就绪。

## 1. 范围与源码依据

- **当前形态**：RC（Release Candidate）阶段的 SQLite schema，以 Kysely 0.29.5 + `node:sqlite` 薄适配器 + `SqliteDialect` 承载。
- **源码依据**：
  - **Schema 唯一来源（已落地，唯一 canonical baseline）**：`src/storage/schema-manifest.ts` 的 `schemaManifest`（`defineSchema` 返回值）声明全部表/列/逻辑类型/nullable/default/PK/FK/索引，经编译期字面量校验（PK/FK/索引列必须引用已声明列，FK 目标表/列须存在）+ 运行期结构校验（唯一性/声明顺序/枚举值）后深冻结；
  - 类型推导：`src/storage/schema-types.ts` 从 manifest 推导 `DatabaseSchema`（逻辑列类型 → TS 类型：uuid/text/json→`string`、integer/bigint→`number`，nullable 追加 `| null`）；`src/storage/db-schema.ts` 只做 `DatabaseSchema` 的兼容 re-export（不再手写表 interface）；
  - 建库 DDL：`src/storage/bootstrap.ts` 的 `initializeDatabase()` 消费 Manifest，仅做逻辑类型→SQLite 物理类型映射并用 `Kysely.schema.createTable(...)` / `createIndex(...)` 幂等建表/索引/外键（全部 `IF NOT EXISTS`）；
  - 行映射与查询：`src/storage/kysely-project-repository.ts` / `kysely-session-repository.ts` / `kysely-idempotency-repository.ts` / `kysely-file-operation-repository.ts` 的 `toRecord()` 与 Port 实现；
  - 幂等 TTL：`src/runtime/runtime-registry.ts` 的 `DEFAULT_IDEMPOTENCY_TTL_MS` 与定期 `prune()`。
- **运行期选项**：`src/server/start.ts` 创建 `DatabaseSync` 时启用 `timeout: 5000` 与 `enableForeignKeyConstraints: true`；文件库（非 `:memory:`）执行 `PRAGMA journal_mode=WAL`。

### Schema Manifest 单一来源（已落地，工作包 B/WP4A）

- **运行时 Schema Manifest 是唯一手工声明**：`src/storage/schema-manifest.ts` 的 `schemaManifest`（唯一 canonical baseline）同时是字段/约束/索引的唯一来源与 `DatabaseSchema` 推导（`schema-types.ts`）的依据；不再有第二份手工字段定义。
- **`db-schema.ts` 仅为派生类型出口**：`DatabaseSchema` 由 Manifest 自动推导（逻辑列类型 → TS 类型，nullable 追加 `| null`），`db-schema.ts` 只 re-export，**不再手维护**，也没有各业务表或 `FileOperationsTable` 手工 interface；各 Repository 的行类型直接引用 `DatabaseSchema`，无第二份手工字段声明。
- **bootstrap 只做方言映射**：`initializeDatabase()` 不再列出字段/索引/FK，而是消费 Manifest + SQLite 逻辑类型映射（`uuid/text/json → TEXT`、`integer/bigint → INTEGER`）逐表幂等建库；DDL 与当前已知 schema 一致（单列 PK 仍为列级内联，复合 PK 仍为命名约束 `idempotency_pk`，FK 仍 ON DELETE CASCADE，完整基线的 6 个业务索引）。唯一差异：主键列由 bootstrap 显式 `notNull()`（Manifest 校验也强制 PK 列不可 nullable）——较历史 DDL 更严格，但符合「主键值不可为 NULL」的业务语义。
- **校验双保险**：编译期在调用点拒绝非法 Manifest（`__schemaIssue` 字面量报错；含主键列不可 nullable、FK 源/目标列等长且非空；`@ts-expect-error` 负向用例见 `tests/storage/schema-types.test.ts`）；运行期 `defineSchema` 再做唯一性/顺序/枚举、主键列不可 nullable、FK 源/目标非空且等长、源/目标逻辑类型一致等校验并深冻结。本文其余内容（§3 表结构、§4 约束索引等）描述的就是该 Manifest 的实际定义（无手工副本）。
- **PostgreSQL 方言**：PG bootstrap（`src/storage/postgres-bootstrap.ts`）从同一 Manifest 推导——逻辑类型映射为 uuid→`UUID`、text/json→`TEXT`、integer/bigint→`BIGINT`（json 保持 TEXT 非 JSONB），DDL 流程与 SQLite 共用 `src/storage/schema-builder.ts`；Repository 已方言中立化（`src/storage/kysely-*-repository.ts`，SQLite/PG 共用，约束错误 mapper 注入）；PG 需显式 `PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL`（见 §9）。真实 PG 集成测试由 `PI_TEST_PG_URL` 门控（见 §9.6）。仍受 RC 限制（见 §7 非目标）。

## 2. 总体设计

- **数据库只存索引、配置与文件副作用队列**：`projects` / `sessions` 存项目与会话的索引、归属、时间戳与会话级配置；`idempotency` 存幂等终态；`file_operations` 存会话清理 outbox。不存完整消息正文、工具调用历史或对话内容。
- **完整对话历史由 Agent 存储实现管理**：当前 `conversation_ref` 由 Pi JSONL storage 解释，指向 Pi SDK 管理的 JSONL 会话文件（`SessionManager.create/open` 产生）；重启后据此恢复。数据库元数据与会话历史是两个独立存储系统，无法合并为单个原子事务；写入顺序与残余边界见下方 `### 会话引用与数据库的跨存储边界`。
- **命名映射**：数据库列为 `snake_case`（`owner_key` / `created_at` / `conversation_ref` 等），领域记录为 `camelCase`（`ownerKey` / `createdAt` / `conversationRef`），由各 Repository 的 `toRecord(row)` 显式映射，`db-schema.ts` 仅 re-export 派生类型、不做转换。
- **应用 ID 与时间**：所有 `id` 由应用层生成（`randomUUID` 等），`created_at` / `updated_at` 为应用写入的毫秒时间戳（`Date.now()`），非数据库自增或 `DEFAULT CURRENT_TIMESTAMP`。
- **单实例假设**：一个逻辑 SQLite 库 / PG schema 及其关联的 DATA_DIR（JSONL 会话目录）同时只支持一个 pi-agent-server 实例使用——多实例共享同一 DB/schema+DATA_DIR 不受支持（SQLite WAL 单写者 + busy timeout 仅兑底，PG 亦无多实例写协调）。离线 CLI（file-ops / reconcile-jsonl / owner-transfer）在服务停止时以只读或受控方式访问同一库。

### 会话引用与数据库的跨存储边界

- **两个存储系统，非单事务**：`projects` / `sessions` 等元数据存 SQLite；完整对话历史存 Pi SDK 管理的 JSONL。二者分属不同存储，无法参与同一个原子事务，跨存储的「要么全成、要么全无」无法由数据库本身保证。
- **创建顺序（持久路径 barrier）**：
  1. 先创建 SQLite/PostgreSQL 会话记录，`conversation_ref = null`（见 `session-service.ts` 的 `createSession`）；
  2. 首次发消息时由会话创建服务调用当前 Agent factory 准备会话引用；对 Pi 实现，`SessionManager.create` 先计算目标 JSONL 文件名；
  3. 会话创建服务先以 factory 提供的唯一稳定实际引用计算 tombstone operationKey（经 `ConversationStorage.planCleanup`），并在 `conversation_ref` 为 NULL 且 `file_operations` 不存在该 operationKey 时原子写入 `conversation_ref` reservation，只有 reservation 成功后才创建 Agent Session/写 JSONL；打开成功后仅对同一引用做 CAS 确认。删除事务读取该引用并由对应 storage 生成清理 outbox。

  **tombstone 语义**：删除会话（或一次失败创建）会在同一事务把删除操作以 `delete-artifact:<agentKind>:<conversationFormat>:<path-digest>` 写入 `file_operations`，该键不随 sessionId 变化。再次为同一 artifact 路径做 reservation 时，只要 `file_operations` 存在该 operationKey——无论 `pending` / `processing` / `completed` / `failed` 任一状态——`reserveConversation` 一律返回 false，即 tombstone 永久禁止复用已删除的 artifact（SQLite 与 PostgreSQL 同一单条条件更新语义一致）。

  这不是跨存储原子事务，但它把会话引用变成持久删除事实；恢复/删除路径均不调用 `unlink`。
- **残余边界（WP4B 物理 executor 未实施，仅安全只读 planner；WP4C 为 DB-only reconcile analyzer）**：进程可能在路径预留后、文件创建前退出，留下一个数据库指向尚未存在文件的预留；后续删除会安全入队，未来执行器（受审计外部运维工具或 native helper）可将不存在文件按幂等成功处理；当前无执行器，outbox 只读可见。进程在文件创建后崩溃不会留下无 owner 的未记录路径；WP4C analyzer 仅做只读 DB reference 分析（null = normal unmaterialized；non-null 词法校验 invalid_reference/duplicate_reference + opaque 引用，零处置、不扫描文件系统、不能探测 orphan/lost/JSONL 损坏），自动 worker/quarantine 入队仍未实现。
- **删除顺序（WP4A）**：
  1. 在一个数据库事务内读取会话文件引用、向 `file_operations` 写入 `pending` 删除操作并删除 `sessions`/`projects` 行；
  2. 事务提交后只清理进程内 runtime；
  3. **DELETE 请求绝不 unlink**，物理文件由未来 worker 在原子 claim 后执行。

  outbox 的相对路径在入队时限制为 DATA_DIR 下两种 JSONL 白名单布局；路径校验失败会回滚同一事务，业务行不丢失。删除项目显式删除 sessions，且 `file_operations` 不设级联 FK，因此待处理 outbox 不会被父行删除级联掉。
- **`ensureDefaultProject` 与 `backfillSystemPrompt` 均非会话历史对账**：
  - `ensureDefaultProject` 仅用于确保 SQLite 默认项目记录存在（`INSERT OR IGNORE`，`id=DEFAULT_PROJECT_ID`（`6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c`）、空 owner），服务于外键不变量，与 JSONL 无关；
  - `backfillSystemPrompt` 仅补写数据库 `sessions` 中 `system_prompt` 为 `null` 的字段，是防御性补齐，与会话历史无关。


  二者都不能弥合上述跨存储边界。
- **WP4A 当前边界**：已提供持久 `file_operations` outbox、相对白名单 path、lease-token fencing、SQLite `BEGIN IMMEDIATE` / PG 父项目 `FOR UPDATE` 删除锁、lazy JSONL 持久路径 barrier，以及 SQLite/PG 原子 claim 预留；删除事务只 enqueue，不执行 unlink。**WP4B 仅安全只读 planner；物理 executor（包括 unlink）、retry/quarantine 未实施**，执行留给未来受审计的 native helper；**WP4C 为 DB-only reconcile analyzer**（只读 DB 引用 + 纯字符串规范布局绑定，固定 issue codes + opaque 引用，零处置、绝不扫描文件系统，不能探测 orphan/lost/JSONL 损坏），不对 DB 与 JSONL 提供跨存储强一致或自动修复。

## 3. 表结构

> 下表与 `src/storage/schema-manifest.ts` 的 `schemaManifest` 列声明（逻辑类型 + nullable + default）及 `bootstrap.ts` 的 SQLite 物理类型映射（`uuid/text/json → TEXT`、`integer/bigint → INTEGER`）完全一致。`DatabaseSchema` 由同一 Manifest 推导。

### 3.1 projects（项目索引）

| 列名 | 类型 | 可空 | 主键/默认值 | 语义 |
| --- | --- | --- | --- | --- |
| `id` | `text` | NOT NULL | PK（`col.primaryKey()`） | 项目 ID，固定保留值 `DEFAULT_PROJECT_ID`（=`6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c`）为共享默认项目 |
| `name` | `text` | NOT NULL | — | 项目展示名（默认项目为 `默认项目`） |
| `cwd` | `text` | NOT NULL | — | Agent 工作目录绝对路径；默认项目取服务端 `cwd`，额外项目由创建者指定 |
| `owner_key` | `text` | NOT NULL | — | 归属标识 `identityKey(UserIdentity)`；默认项目为 `''`（空串，见 §5） |
| `created_at` | `integer` | NOT NULL | — | 创建时间，毫秒时间戳 |

- **源码**：`projects` 表 5 列由 Manifest 声明；`bootstrap.ts` 按 Manifest 顺序建列，非 nullable 列全部 `notNull()`，`id` 为单列主键（列级 `primaryKey()` 内联）。
- **Repository 映射**：`kysely-project-repository.ts` 的 `toRecord` 映射 `owner_key`→`ownerKey`、`created_at`→`createdAt`；`create()` 禁止写入 `id=DEFAULT_PROJECT_ID`，`ensureDefaultProject()` 独占该 ID。

### 3.2 sessions（会话索引）

| 列名 | 类型 | 可空 | 主键/默认值 | 语义 |
| --- | --- | --- | --- | --- |
| `id` | `text` | NOT NULL | PK | 会话 ID（应用生成 UUID） |
| `owner_key` | `text` | NOT NULL | — | 归属 `identityKey`，用于按用户隔离（`listByOwner` / `listByProject` 均带此条件） |
| `project_id` | `text` | NOT NULL | 默认 `DEFAULT_PROJECT_ID`（`defaultTo(DEFAULT_PROJECT_ID)`，即 `6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c`） | 所属项目，FK 指向 `projects.id`，未显式指定时归默认项目 |
| `title` | `text` | NOT NULL | — | 会话标题 |
| `created_at` | `integer` | NOT NULL | — | 创建时间，毫秒时间戳 |
| `updated_at` | `integer` | NOT NULL | — | 更新时间，毫秒时间戳（列表排序键） |
| `agent_kind` | `text` | NOT NULL | 默认 `pi` | Agent 类型；当前仅注册 Pi |
| `conversation_format` | `text` | NOT NULL | 默认 `pi-jsonl-v3` | 会话引用格式；由对应 Agent storage 解释 |
| `conversation_ref` | `text` | NULL | 唯一索引列 | 不透明会话引用；首次 runtime 创建前为 `null`，当前 Pi 实现为 JSONL 绝对路径。非空引用被 `idx_sessions_conversation` 唯一约束独占（禁止共享） |
| `model_provider` | `text` | NULL | — | 会话级模型 provider（`null` 表示沿用服务端默认） |
| `model_id` | `text` | NULL | — | 会话级模型 id（同上） |
| `thinking_level` | `text` | NULL | — | 思考级别（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，`null` 为默认） |
| `system_prompt` | `text` | NULL | — | 创建时冻结的系统提示词；历史会话 `backfillSystemPrompt()` 补齐一次 |
| `capability_versions` | `text` | NULL | — | 创建时冻结的能力版本快照（JSON：`id→version`，`null` 为无能力） |

- **源码**：`sessions` 表 14 列由 Manifest 声明；`bootstrap.ts` 中 `id` 为单列主键（列级 `primaryKey()` 内联），`project_id` 的默认值在 Manifest 中为 `DEFAULT_PROJECT_ID`（引用 `src/application/ports/project-store-port.ts` 的同一常量，不硬编码字符串）；`agent_kind` 和 `conversation_format` 当前为非空且默认 Pi 值，`conversation_ref` 可空，其余会话配置列按各自声明处理。
- **Repository 映射**：`kysely-session-repository.ts` 的 `toRecord` 逐列映射为 `SessionRecord`（`ownerKey` / `projectId` / `agentKind` / `conversationRef` 等）；`update()` 对 `conversationRef` 区分 `undefined`（不更新）和显式 `null`（清空引用）。

### 3.3 idempotency（请求幂等终态）

| 列名 | 类型 | 可空 | 主键/默认值 | 语义 |
| --- | --- | --- | --- | --- |
| `session_id` | `text` | NOT NULL | 复合 PK 之一（`idempotency_pk`） | 会话维度，与 `request_id` 共同定位一条幂等记录 |
| `request_id` | `text` | NOT NULL | 复合 PK 之一 | 客户端生成的请求 ID（`POST /v1/sessions/:id/messages` 必须携带 `requestId`） |
| `result` | `text` | NOT NULL | — | 完成结果的 JSON 序列化（`JSON.stringify(result)`），`{ status: "completed" | "error" | "aborted" }` 等终态 |
| `created_at` | `integer` | NOT NULL | — | 写入时间，毫秒时间戳，用于 TTL 清理排序 |

- **源码**：`idempotency` 表 4 列由 Manifest 声明；`bootstrap.ts` 以命名复合主键约束 `idempotency_pk`（`session_id, request_id`）建表。
- **Repository**：`kysely-idempotency-repository.ts` 的 `get()` 解析 `result` JSON，`put()` 以 `onConflict(columns(["session_id","request_id"])).doUpdateSet({ result, created_at })` 覆盖，`prune(before)` 按 `created_at < before` 删除。

### 3.4 file_operations（JSONL 文件副作用 outbox）

| 列名 | 类型 | 可空 | 语义 |
| --- | --- | --- | --- |
| `id` | `text` / `uuid` | NOT NULL | 应用生成的 outbox ID，主键 |
| `operation_key` | `text` | NOT NULL | 绑定 `agent kind` + `conversation format` + 相对路径摘要的稳定幂等键；当前删除使用 `delete-artifact:<agentKind>:<conversationFormat>:<path-digest>`，**不含 sessionId**，同一 artifact 恒定。删除/failed-creation 入队即形成 tombstone，`reserveConversation` 以同一键拒绝复用已删除 artifact |
| `kind` | `text` | NOT NULL | 当前仅为 `delete` |
| `relative_path` | `text` | NOT NULL | 相对 `DATA_DIR` 的 JSONL 路径；只允许 `sessions/<id>/<file>.jsonl` 或 `projects/<id>/sessions/<id>/<file>.jsonl` |
| `session_id` / `project_id` | `text` / `uuid` | NULL | 关联事实字段，**不设 FK**，避免删除父行时级联丢 outbox |
| `state` | `text` | NOT NULL | `pending → processing → completed/failed`；过期 lease 的 `processing` 可再次 claim |
| `attempt_count` | `integer` | NOT NULL | claim 次数，默认 0 |
| `available_at` | `integer` | NOT NULL | 可 claim 的毫秒时间 |
| `lease_until` / `lease_token` | `integer` / `text` | NULL | 原子 claim 的租约边界 |
| `last_error` | `text` | NULL | 固定、有限 allowlist 内的 canonical error code（≤1000 bytes；见 [file-operations.md](file-operations.md) 错误策略）；不保存原始异常，仓库读取与 restore 对不合规值 fail-closed |
| `created_at` / `updated_at` | `integer` | NOT NULL | 毫秒时间戳 |

`operation_key` 有唯一索引，重复 enqueue 返回既有记录且不重置状态。SQLite 使用同事务 `UPDATE … RETURNING`，PostgreSQL 使用同事务 `FOR UPDATE SKIP LOCKED` 预留；repository 只改变 outbox 状态，不执行文件副作用。

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
  - 应用层删除项目走 `KyselyProjectRepository.deleteProjectWithSessions()` 的 `transaction()`（先删 `sessions` 再删 `projects`），与 FK 双重保障。
- **索引**：
  - `idx_sessions_owner_updated` ON `sessions(owner_key, updated_at DESC)` —— 服务于 `listByOwner(ownerKey) ORDER BY updated_at DESC, id DESC`（`updated_at` 倒序为查询主排序键）；
  - `idx_sessions_owner_project` ON `sessions(owner_key, project_id)` —— 服务于 `listByProject(ownerKey, projectId) ORDER BY updated_at DESC, id DESC`（按项目过滤）。
  - `idx_sessions_conversation` ON `sessions(agent_kind, conversation_format, conversation_ref)`（UNIQUE）—— 禁止共享非空 conversation identity：同 `(agent_kind, conversation_format, conversation_ref)` 至多一个会话；`conversation_ref` 为 NULL 时在 SQLite/PG 中彼此不冲突（唯一索引对 NULL 默认视为互不相同），允许多个未实例化（unmaterialized）会话共存。
  - `kysely-session-repository.ts` 与 `kysely-project-repository.ts` 的 `listByOwner` / `listByProject` 均显式 `orderBy("updated_at","desc").orderBy("id","desc")`（`id` 倒序为并列时的确定性次级排序）。

### 4.3 idempotency

- **主键**：复合主键 `PRIMARY KEY (session_id, request_id)`（约束名 `idempotency_pk`），保证同一会话内 `requestId` 唯一（不同会话的同 `requestId` 互不影响）。
- **索引**：`idx_idempotency_created_at` ON `idempotency(created_at)` —— 服务于 TTL 清理 `DELETE FROM idempotency WHERE created_at < :before`（`KyselyIdempotencyRepository.prune` 与 `RuntimeRegistry` 定期清理共用）。
- **无外键**：`session_id` 不建 FK，避免会话删除后仍需保留幂等记录至 TTL。

### 4.4 file_operations

- **主键**：`file_operations.id` PRIMARY KEY。
- **幂等索引**：`idx_file_operations_key` 是 `operation_key` 的 UNIQUE 索引；重复删除请求不会重置已完成或已租约的操作。
- **claim 索引**：`idx_file_operations_claim` 覆盖 `(state, available_at)`；它是非 UNIQUE 索引。
- **无外键**：`session_id` / `project_id` 只作审计关联字段，业务删除后 outbox 行必须继续存在，绝不使用 `ON DELETE CASCADE`。
- **状态转移**：`pending → processing → completed|failed`，失败操作在 `available_at` 到达后可重新 claim；租约过期的 `processing` 也可重新预留。`complete`/`fail` 必须携带非空 `lease_token`，并同时匹配 `id + processing + token + 非空 lease_until`；新 worker 重领后旧 token 不能改变状态。

## 5. 共享默认项目与会话隔离

- **默认项目**：`projects` 中固定一行 `id=DEFAULT_PROJECT_ID`（`6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c`）、`owner_key=''`（空串）、`name='默认项目'`、`cwd=<服务端 cwd>`、`created_at=0`。由 `src/server/start.ts` 在 schema 初始化之后经 `KyselyProjectRepository.ensureDefaultProject()` 以 `INSERT ... ON CONFLICT(id) DO NOTHING` 幂等写入。
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
  对应 `SessionStorePort.listByProject(ownerKey, DEFAULT_PROJECT_ID)`（`kysely-session-repository.ts` 的 Kysely 实现为 `.where("owner_key","=",ownerKey).where("project_id","=",projectId).orderBy("updated_at","desc").orderBy("id","desc")`）。
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
- **正名**：本机制是“**请求幂等**”（同一 `requestId` 的重复提交去重），**不是**“消息去重”或“永久防重”。不要误称为消息去重、内容去重或永久防重。当前实现包含进程内 in-flight 去重与持久化终态读取。

## 7. 设计原则和非目标

### 原则

- **多用户/多项目**：所有查询以 `owner_key`（`identityKey(UserIdentity)`）隔离；额外项目按 `owner_key` 私有，默认项目按 `owner_key=''` 共享；会话隔离与项目可见性正交（见 §5）。
- **外键完整性**：`sessions.project_id → projects.id ON DELETE CASCADE`，建库启用 `enableForeignKeyConstraints: true`，应用层 `transaction()` 与数据库 FK 双重保证无孤儿会话；`file_operations` 刻意无外键，保证业务删除不会丢待处理副作用。
- **查询索引**：所有列表查询均有覆盖索引（`idx_projects_owner` / `idx_sessions_owner_updated` / `idx_sessions_owner_project` / `idx_idempotency_created_at`），排序键与索引列一致。
- **应用 ID/毫秒时间戳**：`id` 由应用生成，`created_at`/`updated_at` 为 `Date.now()` 毫秒值，便于跨 SQLite/PostgreSQL 保持语义一致（PostgreSQL 阶段共用同一 Manifest，逻辑类型 `integer/bigint` 已在 Manifest 中区分）。

### 非目标（当前不做）

- **不建 `users` / `messages` 表**：用户身份由 `UserIdentity` 派生的 `owner_key` 字符串承载，无需用户表；完整消息正文由 `conversation_ref` 对应的 Agent storage 管理，不在数据库中镜像 `messages` 表（避免双写一致性与大文本存储问题）。
- **服务启动不做自动迁移**：数据模式 `PI_DATA_MODE`（默认 `managed`；`rc` = 显式 disposable）与启动门禁 `PI_MIGRATION_GATE`（默认 `verify`）已实现——所有 data mode 仅接受 `verify`（显式 `off` 一律在任何资源创建前 fail-closed）；所有模式在启动路径都**绝不自动迁移、reset 或 cutover**。`verify` 启动前**真只读** ledger/head 校验（空/legacy/落后库 fail-fast，绝不自动迁移/reset）。非唯一 canonical baseline 或无 ledger 的旧库绝不自动采用；迁移引擎与服务 bootstrap 均 fail-fast。完全空 SQLite DB 或完全空 non-public/non-system PostgreSQL schema 必须先离线执行 `pnpm migrate -- --bootstrap-baseline --bootstrap-confirm CONFIRMED` 建立唯一 canonical baseline；已有唯一 canonical baseline 的数据库才执行 `--apply`，其他状态均 fail-closed。该命令不可混用 backup/maintenance 参数且不会创建 pre-backup。服务 bootstrap 仍执行**严格 schema preflight（M1，非迁移）**：在任何建表/建索引 DDL 之前，库中已含任一 managed 表时要求完整物理契约一致，任何不一致立即失败且不执行 ALTER/补列/建表/建索引；全新/当前唯一 canonical baseline schema 不受影响。当前规则见 [ADR 0002](decisions/0002-canonical-baseline-and-migration-gate.md)。
- **不做 SQLite→PostgreSQL 数据迁移**：当前无 SQLite→PG 数据迁移路径。
- **WP1/WP4A 离线迁移基础（唯一 canonical baseline）**：`src/storage/migration-manifest.ts` 固化不可变唯一 canonical baseline（ledger version=0，manifest=完整 `schemaManifest`，含 `file_operations` 与 6 个业务索引）；`src/storage/migration-engine.ts` 使用自定义 `schema_migrations` ledger、稳定 checksum、SQLite `BEGIN IMMEDIATE` 与 PG advisory lock/transaction。`scripts/migrate.ts` 支持 `--bootstrap-baseline`、`--dry-run`、`--apply`、`--verify`：完全空 SQLite DB 或完全空 non-public/non-system PostgreSQL schema 必须使用 `--bootstrap-baseline --bootstrap-confirm CONFIRMED` 建立唯一 canonical baseline；该模式不 pre-backup 且拒绝 backup/maintenance 参数；`--apply` 只对已有唯一 canonical baseline 的数据库执行已验证 pre-backup→apply→verify；其他状态均 fail-fast。该工具不执行删除、不处理文件副作用；相关离线工具（`pnpm file-ops` 安全只读 planner、`pnpm reconcile-jsonl` DB-only 分析）详见 [file-operations.md](file-operations.md) 与 [reconcile-jsonl.md](reconcile-jsonl.md)，不改变正常服务启动行为。

### 未来扩展

- 扩展前必须先产出：实体/字段/关系、查询清单（JOIN / filter / sort / page / aggregation）、索引/权限、Port/Repository 草案；
- 实现顺序：`schema-manifest.ts`（唯一来源）→ `schema-types.ts`（类型推导）→ `bootstrap.ts`（SQLite/PG 各自方言）→ `Repository`/`Port` → `Service` → `API` → `Test`；
- 一旦开始保留真实用户数据，立即禁止把 destructive reset、final reset 或 cutover 当作迁移路径；新目标只能按 [ADR 0002](decisions/0002-canonical-baseline-and-migration-gate.md) 建立 canonical baseline，并建立正式迁移、备份和回滚策略。

## 8. 相关文档

- 核心数据流、端口契约与解耦边界：[architecture.md](architecture.md)
- 需求基线（会话/项目/幂等/并发/工具与权限）：[../needs.md](../needs.md)

## 9. PostgreSQL 方言

> PG 方言已落地：从同一 Manifest 推导 DDL，Repository 方言中立。真实 PG 集成测试由 `PI_TEST_PG_URL` 门控（无 URL 时整组 skip，打印依据、不发起连接）；`pnpm test:postgres` 为发布门禁，无 URL 时非零退出（见 §9.6）。离线 migration、backup/restore 已提供；SQLite→PG 数据迁移与多实例运行不支持。

### 9.1 启用方式（显式，fail-fast，不静默回退）

| 环境变量 | 作用 | 规则 |
|---|---|---|
| `PI_STORAGE_DIALECT` | 存储方言 | 缺省、空/仅空白或 `sqlite` → SQLite（默认，向后兼容；空/空白归一化为未配置，不抛错）；`postgres` → PG；未知**非空**值启动即抛错（`未知存储方言`） |
| `PI_DATABASE_URL` | PG 连接串 | 仅 `PI_STORAGE_DIALECT=postgres` 时必填；缺失/空白 fail-fast（拒绝启动，绝不静默回退 SQLite） |
| `PI_TEST_PG_URL` | 测试门控 | 仅 PG 集成测试使用；未配置时整组 skip（打印依据，不发起连接、不报告通过） |

对应 `StartConfig.storageDialect?` / `databaseUrl?`，由 `src/server/start.ts` 的 `resolveStorageConfig` 解析校验（进程入口 `src/main.ts` 读取环境变量传入）。**仅设 `PI_DATABASE_URL` 而未设 `PI_STORAGE_DIALECT=postgres` 不启用 PG**（向后兼容）。

### 9.2 Manifest → PG DDL 映射

| Manifest 逻辑类型 | SQLite DDL | PostgreSQL DDL |
|---|---|---|
| `uuid` | `TEXT` | `UUID` |
| `text` | `TEXT` | `TEXT` |
| `integer` | `INTEGER` | `BIGINT`（毫秒时间戳） |
| `bigint` | `INTEGER` | `BIGINT` |
| `json` | `TEXT` | `TEXT`（**非 JSONB**，保持 JSON 文本往返语义） |

- 表/列/主键/外键/索引声明仍全部来自 `schemaManifest`（唯一来源，见 §1）；`src/storage/schema-builder.ts` 是 Manifest→Kysely schema builder 的方言无关流程，SQLite（`bootstrap.ts`）与 PG（`postgres-bootstrap.ts`）只注入各自的物理类型映射。
- 单列未命名主键（projects/sessions/file_operations）→ 列级 `PRIMARY KEY`（PG 默认约束名 `<table>_pkey`）；复合主键（idempotency）→ 命名约束 `idempotency_pk`；FK `sessions_project_id_fk` ON DELETE CASCADE；完整基线的 6 个业务索引（含 `idx_sessions_owner_updated` 的 `updated_at DESC`）均与 SQLite 一致。
- `request_id` / `result` / `capability_versions` / `file_operations.relative_path`：PG 侧均为 `TEXT`（json 逻辑类型不映射 JSONB）。

### 9.3 int8（BIGINT）读回为安全 JS number

- `node-postgres` 默认把 BIGINT（OID 20）读回为 **string**；本服务时间戳列在 PG 侧是 BIGINT，必须在 **PG storage 边界**读回为 number。
- 实现（`src/storage/pg-int8.ts`）：`createPgInt8SafeTypes()` 构造 **per-pool** CustomTypes（只覆盖 OID 20，不污染进程级 pg 全局解析），组装进 `createPostgresPool` 的连接配置；`parsePgInt8` 对超出 `Number.MAX_SAFE_INTEGER` 的值**显式抛错**（拒绝静默丢精度），毫秒时间戳（~1.7e12）远低于安全上限（~9e15），正常数据永不触发。
- Repository 读回后 `created_at`/`updated_at` 等即为 number；`Number(numUpdatedRows/numDeletedRows)` 语义保留（PG 的 Kysely 结果 `numAffectedRows` 为 bigint）。

### 9.4 约束错误映射（PG SQLSTATE，storage 层专用）

| PG SQLSTATE | 映射 | 说明 |
|---|---|---|
| `23505` unique_violation | → `DuplicateIdError` | **仅当**被违反约束为该表自身单列 id 主键（`<table>_pkey`，如 `projects_pkey`）；复合主键 `idempotency_pk`、未来唯一索引等一律原样抛出（不污染有界重试语义） |
| `23503` foreign_key_violation | → `ProjectForeignKeyError` | `sessions.project_id` 引用项目在写入前已被删除 |
| 其他 | 原样抛出 | 绝不吞掉 |

application 层不识别任何 PG code（只依赖存储无关错误）；实现见 `src/storage/pg-constraint-errors.ts`（`pgConstraintErrorMapper`）。

### 9.5 Repository 方言中立化

- `src/storage/kysely-project-repository.ts` / `kysely-session-repository.ts` / `kysely-idempotency-repository.ts`：Kysely CRUD 与行映射完全方言无关（不再有名为 Sqlite 的 Repository），构造时注入 `ConstraintErrorMapper`（SQLite 映射器 `sqliteConstraintErrorMapper` / PG 映射器 `pgConstraintErrorMapper`）。
- 查询语义（where/orderBy/事务/ON CONFLICT/JSON stringify-parse）与 `Number(numAffected)` 对双库一致；`start.ts` / mock / tests 均改用中立 Repository。

### 9.6 Pool 生命周期与测试门控

- 组合根（`start.ts`）按方言构造：SQLite → `DatabaseSync`（timeout/FK/WAL 仅 SQLite）+ `initializeDatabase`；PG → `createPostgresPool` + `initializePostgresDatabase`（失败路径内先 destroy、再抛原始错误）。`createIdempotentStorageCloser` 统一调用 `kysely.destroy()`：PG 侧 `PostgresDriver.destroy` 会 `pool.end()`。
- PG 集成测试 `tests/postgres/` 由 `PI_TEST_PG_URL` 门控：随机 schema（`pi_test_*`）隔离 + `search_path`，afterAll 仅 `DROP SCHEMA IF EXISTS <random> CASCADE`（严禁 drop public/任意用户库）；每用例前 `TRUNCATE TABLE idempotency, sessions, projects CASCADE`，从空表开始，执行顺序无关。无 URL 时整组 skip（打印依据、不发起连接、不报告通过）。
- `pnpm test:postgres`（发布门禁）由跨平台 Node runner `scripts/test-postgres.ts` 驱动：`PI_TEST_PG_URL` 缺失/空白时**非零退出并说明原因**（绝不把 skip 当作验收），有值时仅运行 `tests/postgres/**` 真实集成测试（连接串只进子进程环境，不打印）。发布链见 `package.json` 的 `verify`（日常）/ `verify:release`（发布）。
