// 运行时 Schema Manifest —— projects / sessions / idempotency / file_operations 表、列、逻辑类型、
// nullable、default、主键、外键、索引的**唯一手工声明来源**。
//
// 设计要点：
// - 不引入 ORM / JSON Schema / codegen：用一组普通 readonly 接口 + `defineSchema` 工厂
//   （编译期泛型校验 + 运行期结构校验 + 深冻结）表达 schema。
// - 编译期校验（类型层面）：主键列、外键源列、索引列必须引用本表已声明的列；
//   外键目标表必须存在、目标列必须属于目标表。违反时调用点编译失败（见 __schemaIssue）。
//   `@ts-expect-error` 负向用例见 tests/storage/schema-types.test.ts。
// - 运行期校验（createSchema 内部）：表/列/索引名唯一性、外键目标存在且声明顺序
//   （目标表必须先于引用表）、FK 源/目标列非空且等长、源/目标逻辑类型一致、
//   主键列不可 nullable、onDelete 动作合法、default 与逻辑类型匹配等。
// - 逻辑列类型（LogicalColumnType）为方言无关表示，SQLite/PG 各自的 DDL 映射在工作包 B/C
//   各自的 bootstrap 中声明（PG 的 UUID/BIGINT 映射随工作包 C 落地）。
// - sessions.project_id 的历史默认值来自不可变的 DEFAULT_PROJECT_ID 常量，绝不读取可变服务配置。
// - 本文件只导出**一个** 完整 schemaManifest（v0/v1 等历史快照已删除且不再重建：backup/restore 只接受携带 canonical 单基线 ledger 的包，旧包不可恢复）。

import { DEFAULT_PROJECT_ID } from "../application/ports/project-store-port.js";

/** 方言无关的逻辑列类型。SQLite 物理类型映射见 bootstrap.ts（uuid/text/json → TEXT，integer/bigint → INTEGER）。 */
export type LogicalColumnType = "uuid" | "text" | "integer" | "bigint" | "json";

/**
 * 逻辑类型的**权威运行期键集合**：以对象键表达 union 的全部成员。
 * 新增逻辑类型必须同时加入 LogicalColumnType 联合与本对象，缺一即编译失败
 * （Readonly<Record<LogicalColumnType, true>> 强制键与联合一致），
 * 杜绝「union 新增而运行期数组漏项」的脚枪。
 */
export const LOGICAL_COLUMN_TYPE_KEYS: Readonly<Record<LogicalColumnType, true>> = {
  uuid: true,
  text: true,
  integer: true,
  bigint: true,
  json: true,
};

/** 由键集合推导的运行期数组（兼容导出）；不再存在可漂移的第二份成员声明。 */
export const LOGICAL_COLUMN_TYPES: readonly LogicalColumnType[] = Object.keys(
  LOGICAL_COLUMN_TYPE_KEYS,
) as unknown as readonly LogicalColumnType[];

/** 列默认值（SQL 字面量）。当前没有 boolean 逻辑类型，故 boolean 不是合法 default（类型与运行期双重拒绝）。 */
export type DefaultValueLiteral = string | number;

export interface ColumnManifest<N extends string = string> {
  /** 列名（snake_case，如 owner_key / created_at）。 */
  readonly name: N;
  /** 逻辑列类型：uuid / text / integer / bigint / json。 */
  readonly type: LogicalColumnType;
  /** true = NULL 允许；false = NOT NULL。主键列恒为 false。 */
  readonly nullable: boolean;
  /** SQL 字面量默认值；缺省表示无 DEFAULT 子句。 */
  readonly default?: DefaultValueLiteral;
}

export interface PrimaryKeyManifest<N extends string = string> {
  /**
   * 命名约束名。缺省且单列时，bootstrap 以列级 col.primaryKey() 内联声明（与当前 DDL 一致）；
   * 复合主键或给出 constraintName 时以 addPrimaryKeyConstraint 声明。
   */
  readonly constraintName?: string;
  /** 主键列（单列或复合）。 */
  readonly columns: readonly N[];
}

export type ForeignKeyAction = "cascade" | "restrict" | "set null" | "set default" | "no action";

export const FOREIGN_KEY_ACTIONS: readonly ForeignKeyAction[] = [
  "cascade",
  "restrict",
  "set null",
  "set default",
  "no action",
];

export interface ForeignKeyManifest<
  SourceColumn extends string = string,
  TargetTableName extends string = string,
  TargetColumn extends string = string,
> {
  readonly constraintName: string;
  /** 源表（本表）列。 */
  readonly columns: readonly SourceColumn[];
  /** 目标表名（必须在 Manifest 中先于本表声明）。 */
  readonly targetTable: TargetTableName;
  /** 目标表列。 */
  readonly targetColumns: readonly TargetColumn[];
  readonly onDelete: ForeignKeyAction;
}

export type IndexColumnSort = "asc" | "desc";

export interface IndexColumnManifest<N extends string = string> {
  readonly name: N;
  /** 排序方向；缺省 asc。desc 用于如 idx_sessions_owner_updated 的 updated_at DESC。 */
  readonly order?: IndexColumnSort;
}

export interface IndexManifest<N extends string = string> {
  /** 索引名（SQLite 中数据库级唯一，全库不可重复）。 */
  readonly name: string;
  readonly columns: readonly IndexColumnManifest<N>[];
  readonly unique?: boolean;
}

/** 表的宽松声明形态：defineSchema 的编译期校验在字面量层面进行，此处接口供宽化消费（如 bootstrap 循环）。 */
export interface TableManifest {
  readonly name: string;
  readonly columns: readonly ColumnManifest[];
  readonly primaryKey: PrimaryKeyManifest;
  readonly foreignKeys?: readonly ForeignKeyManifest[];
  readonly indexes?: readonly IndexManifest[];
}

/** 由 defineSchema 返回的、保留字面量类型的 Manifest 形态（DatabaseSchema 推导依赖它）。 */
export interface SchemaManifestOf<T extends readonly TableManifest[]> {
  readonly tables: T;
}

/** 宽松的 SchemaManifest 形态（不保留字面量）。 */
export type SchemaManifest = SchemaManifestOf<readonly TableManifest[]>;

// ---------------------------------------------------------------------------
// 编译期校验（never = 无问题；字符串字面量 = 具体问题描述）
// ---------------------------------------------------------------------------

type TableColumnNames<TB extends TableManifest> = TB["columns"][number]["name"];

type TableByName<Tables extends readonly TableManifest[], Name extends string> =
  Tables[number] extends infer TB ? (TB extends { readonly name: Name } ? TB : never) : never;

/** Name 必须是 TableColumns 之一，否则产出描述字面量。分布到列名联合。 */
type ColumnNameError<Name extends string, TableColumns extends string> =
  Name extends TableColumns ? never : `unknown column '${Name}'`;

/** PK 列不可 nullable：主键值不可为 NULL。字面量 Manifest 编译期拒绝；宽化形态由运行期兜底。 */
type PkNullableError<TB extends TableManifest> =
  TB["primaryKey"]["columns"][number] extends infer CName
    ? CName extends TB["columns"][number]["name"]
      ? Extract<TB["columns"][number], { name: CName }>["nullable"] extends true
        ? `PK column '${CName & string}' must be non-nullable`
        : never
      : never
    : never;

type PkError<TB extends TableManifest> =
  ColumnNameError<TB["primaryKey"]["columns"][number], TableColumnNames<TB>> | PkNullableError<TB>;

/** 元组判断：字面量声明（defineSchema 的 const 泛型保留）为 true；宽化数组为 false（由运行期兜底）。 */
type IsTuple<T extends readonly unknown[]> = number extends T["length"] ? false : true;

/**
 * FK 形状编译期检查（仅当源/目标列是字面量元组时生效）：源/目标列必须非空且列数相等。
 * 宽化数组无法静态判断长度，交给运行期兜底。
 */
type FkShapeError<TB extends TableManifest, Target extends TableManifest, FK extends ForeignKeyManifest> =
  [IsTuple<FK["columns"]>, IsTuple<FK["targetColumns"]>] extends [true, true]
    ? FK["columns"] extends readonly [string, ...string[]]
      ? FK["columns"]["length"] extends FK["targetColumns"]["length"]
        ? never
        : `FK '${FK["constraintName"] & string}': source (${FK["columns"]["length"]}) and target (${FK["targetColumns"]["length"]}) column counts differ`
      : `FK '${FK["constraintName"] & string}': must declare at least one source column`
    : never;

type FkError<Tables extends readonly TableManifest[], TB extends TableManifest, FK extends ForeignKeyManifest> =
  TableByName<Tables, FK["targetTable"]> extends infer Target
    ? [Target] extends [never]
      ? `FK '${FK["constraintName"] & string}': unknown targetTable '${FK["targetTable"] & string}' (must be declared in the manifest)`
      : Target extends TableManifest
        ? ColumnNameError<FK["columns"][number] & string, TableColumnNames<TB>> |
          ColumnNameError<FK["targetColumns"][number] & string, TableColumnNames<Target>> |
          FkShapeError<TB, Target, FK>
        : never
    : never;

type FkErrors<Tables extends readonly TableManifest[], TB extends TableManifest> =
  TB["foreignKeys"] extends readonly ForeignKeyManifest[]
    ? FkError<Tables, TB, TB["foreignKeys"][number]>
    : never;

type IndexNameErrors<TB extends TableManifest, IDX extends IndexManifest> = ColumnNameError<
  IDX["columns"][number]["name"],
  TableColumnNames<TB>
>;

type IndexErrors<TB extends TableManifest> =
  TB["indexes"] extends readonly IndexManifest[]
    ? IndexNameErrors<TB, TB["indexes"][number]>
    : never;

type TableError<Tables extends readonly TableManifest[], TB extends TableManifest> =
  PkError<TB> | FkErrors<Tables, TB> | IndexErrors<TB>;

type SchemaError<T extends readonly TableManifest[]> = T[number] extends TableManifest
  ? TableError<T, T[number]>
  : "table does not match TableManifest";

type ValidateSchema<T extends readonly TableManifest[]> = [SchemaError<T>] extends [never]
  ? unknown
  : { readonly __schemaIssue: SchemaError<T> };

/**
 * 创建运行时 Schema Manifest：编译期 + 运行期双重校验后返回深冻结对象。
 * `const` 泛型保留字面量（表/列/约束名），供 `DatabaseSchema` 类型推导（schema-types.ts）。
 */
export function defineSchema<const T extends readonly TableManifest[]>(
  tables: T & ValidateSchema<T>,
): SchemaManifestOf<T> {
  validateManifest(tables);
  return Object.freeze({ tables: deepFreeze(tables) });
}

// ---------------------------------------------------------------------------
// 运行期校验（防御纵深：编译期字面量校验之外，还需保证唯一性/顺序/枚举值在运行期成立）
// ---------------------------------------------------------------------------

function validateManifest(tables: readonly TableManifest[]): void {
  // 两趟：先注册全部表/列（外键目标可能在后面才声明），再集中校验主键/外键/索引。
  const tableIndexes = new Map<string, number>();
  const tableColumnNames = new Map<string, Set<string>>();

  for (const [tableIdx, table] of tables.entries()) {
    if (table.name.length === 0) throw new Error(`schema manifest: table #${tableIdx} has empty name`);
    if (tableIndexes.has(table.name)) {
      throw new Error(`schema manifest: duplicate table name '${table.name}'`);
    }
    tableIndexes.set(table.name, tableIdx);

    const columnNames = new Set<string>();
    for (const column of table.columns) {
      if (column.name.length === 0) throw new Error(`schema manifest: table '${table.name}' has a column with empty name`);
      if (columnNames.has(column.name)) {
        throw new Error(`schema manifest: table '${table.name}' has duplicate column '${column.name}'`);
      }
      columnNames.add(column.name);
      if (!(column.type in LOGICAL_COLUMN_TYPE_KEYS)) {
        throw new Error(`schema manifest: table '${table.name}' column '${column.name}' has unknown logical type '${String(column.type)}'`);
      }
      if (column.default !== undefined) {
        const expected = column.type === "integer" || column.type === "bigint" ? "number" : "string";
        if (typeof column.default !== expected) {
          throw new Error(
            `schema manifest: table '${table.name}' column '${column.name}' default must be ${expected} for logical type '${column.type}'`,
          );
        }
      }
    }
    tableColumnNames.set(table.name, columnNames);
  }

  const indexNames = new Set<string>();
  for (const [tableIdx, table] of tables.entries()) {
    const columnNames = tableColumnNames.get(table.name) ?? new Set<string>();

    const pk = table.primaryKey;
    if (pk.columns.length === 0) {
      throw new Error(`schema manifest: table '${table.name}' primaryKey must declare at least one column`);
    }
    for (const c of pk.columns) {
      if (!columnNames.has(c)) {
        throw new Error(`schema manifest: table '${table.name}' primaryKey references unknown column '${c}'`);
      }
      const pkColumn = table.columns.find((col) => col.name === c);
      if (pkColumn?.nullable) {
        throw new Error(
          `schema manifest: table '${table.name}' primaryKey column '${c}' must be non-nullable (PK 列恒 NOT NULL)`,
        );
      }
    }

    for (const fk of table.foreignKeys ?? []) {
      if (!FOREIGN_KEY_ACTIONS.includes(fk.onDelete)) {
        throw new Error(`schema manifest: table '${table.name}' FK '${fk.constraintName}' has unknown onDelete '${String(fk.onDelete)}'`);
      }
      if (fk.columns.length === 0) {
        throw new Error(`schema manifest: table '${table.name}' FK '${fk.constraintName}' must declare at least one source column`);
      }
      if (fk.targetColumns.length === 0) {
        throw new Error(`schema manifest: table '${table.name}' FK '${fk.constraintName}' must declare at least one target column`);
      }
      if (fk.columns.length !== fk.targetColumns.length) {
        throw new Error(
          `schema manifest: table '${table.name}' FK '${fk.constraintName}' source column count (${fk.columns.length}) must equal target column count (${fk.targetColumns.length})`,
        );
      }
      const targetIdx = tableIndexes.get(fk.targetTable);
      if (targetIdx === undefined) {
        throw new Error(`schema manifest: table '${table.name}' FK '${fk.constraintName}' references unknown table '${fk.targetTable}'`);
      }
      if (targetIdx >= tableIdx) {
        throw new Error(
          `schema manifest: table '${table.name}' FK '${fk.constraintName}' references table '${fk.targetTable}' which must be declared before it`,
        );
      }
      const target = tables[targetIdx];
      if (!target) continue; // 已在上面保证存在
      const targetColumnNames = tableColumnNames.get(target.name) ?? new Set<string>();
      for (let i = 0; i < fk.columns.length; i++) {
        const source = fk.columns[i]!;
        const targetColumn = fk.targetColumns[i]!;
        if (!columnNames.has(source)) {
          throw new Error(`schema manifest: table '${table.name}' FK '${fk.constraintName}' source column '${source}' is not in the table`);
        }
        if (!targetColumnNames.has(targetColumn)) {
          throw new Error(`schema manifest: table '${table.name}' FK '${fk.constraintName}' target column '${targetColumn}' is not in table '${fk.targetTable}'`);
        }
        // 源/目标逻辑类型必须一致（如 sessions.project_id(uuid) → projects.id(uuid)）
        const sourceType = table.columns.find((col) => col.name === source)!.type;
        const targetType = target.columns.find((col) => col.name === targetColumn)!.type;
        if (sourceType !== targetType) {
          throw new Error(
            `schema manifest: table '${table.name}' FK '${fk.constraintName}' column '${source}' (${sourceType}) type mismatch with '${fk.targetTable}.${targetColumn}' (${targetType})`,
          );
        }
      }
    }

    for (const index of table.indexes ?? []) {
      if (index.name.length === 0) throw new Error(`schema manifest: table '${table.name}' has an index with empty name`);
      if (indexNames.has(index.name)) {
        throw new Error(`schema manifest: duplicate index name '${index.name}' (must be unique across the database)`);
      }
      indexNames.add(index.name);
      if (index.columns.length === 0) {
        throw new Error(`schema manifest: index '${index.name}' on table '${table.name}' has no columns`);
      }
      for (const c of index.columns) {
        if (!columnNames.has(c.name)) {
          throw new Error(`schema manifest: index '${index.name}' on table '${table.name}' references unknown column '${c.name}'`);
        }
        if (c.order !== undefined && c.order !== "asc" && c.order !== "desc") {
          throw new Error(`schema manifest: index '${index.name}' on table '${table.name}' has unknown sort order '${String(c.order)}'`);
        }
      }
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 当前 schema 的唯一手工声明（与既有 SQLite DDL 一一对应；DDL 由 bootstrap.ts 消费）
// ---------------------------------------------------------------------------

/**
 * 完整运行时 Schema Manifest（唯一来源；new-baseline 单一版本）。
 * 表顺序即 bootstrap 建表顺序（FK 目标必须先于引用表：projects → sessions → idempotency → file_operations）。
 *
 * 与「当前 DDL」的对应关系（工作包 B/C）：
 * - 单列主键（projects.id / sessions.id / file_operations.id）无 constraintName → 列级 primaryKey() 内联声明，
 *   且主键列由 bootstrap 防御性显式 notNull（Manifest 运行期校验也强制 PK 列不可 nullable）——
 *   比历史 DDL 更严格、但符合「主键值不可为 NULL」的业务语义；
 * - idempotency 复合主键 → 命名约束 idempotency_pk；
 * - sessions.project_id → projects.id ON DELETE CASCADE；
 * - 6 个业务索引含 idx_sessions_owner_updated 的 updated_at DESC 顺序语义；file_operations 的幂等
 *   key 唯一索引与 claim 索引；
 * - file_operations 刻意不设 FK：projects/sessions 删除提交后，待处理 outbox 必须保留。
 *
 * 新基线迁移（migration-manifest.ts）以本 Manifest 为单一 head：迁移引擎/verify/bootstrap 都是
 * 同一个完整 schema 的消费者，不存在 v0/v1 历史版本。
 */
export const schemaManifest = defineSchema([
  {
    name: "projects",
    columns: [
      { name: "id", type: "uuid", nullable: false },
      { name: "name", type: "text", nullable: false },
      { name: "cwd", type: "text", nullable: false },
      { name: "owner_key", type: "text", nullable: false },
      { name: "created_at", type: "integer", nullable: false },
    ],
    primaryKey: { columns: ["id"] },
    foreignKeys: [],
    indexes: [{ name: "idx_projects_owner", columns: [{ name: "owner_key" }] }],
  },
  {
    name: "sessions",
    columns: [
      { name: "id", type: "uuid", nullable: false },
      { name: "owner_key", type: "text", nullable: false },
      {
        name: "project_id",
        type: "uuid",
        nullable: false,
        // The single baseline is pinned to the immutable application constant; it never reads mutable service configuration.
        default: DEFAULT_PROJECT_ID,
      },
      { name: "title", type: "text", nullable: false },
      { name: "created_at", type: "integer", nullable: false },
      { name: "updated_at", type: "integer", nullable: false },
      { name: "pi_session_file", type: "text", nullable: true },
      { name: "model_provider", type: "text", nullable: true },
      { name: "model_id", type: "text", nullable: true },
      { name: "thinking_level", type: "text", nullable: true },
      { name: "system_prompt", type: "text", nullable: true },
      { name: "capability_versions", type: "json", nullable: true },
    ],
    primaryKey: { columns: ["id"] },
    foreignKeys: [
      {
        constraintName: "sessions_project_id_fk",
        columns: ["project_id"],
        targetTable: "projects",
        targetColumns: ["id"],
        onDelete: "cascade",
      },
    ],
    indexes: [
      {
        name: "idx_sessions_owner_updated",
        columns: [{ name: "owner_key" }, { name: "updated_at", order: "desc" }],
      },
      {
        name: "idx_sessions_owner_project",
        columns: [{ name: "owner_key" }, { name: "project_id" }],
      },
    ],
  },
  {
    name: "idempotency",
    columns: [
      { name: "session_id", type: "uuid", nullable: false },
      { name: "request_id", type: "text", nullable: false },
      { name: "result", type: "json", nullable: false },
      { name: "created_at", type: "integer", nullable: false },
    ],
    primaryKey: { constraintName: "idempotency_pk", columns: ["session_id", "request_id"] },
    foreignKeys: [],
    indexes: [{ name: "idx_idempotency_created_at", columns: [{ name: "created_at" }] }],
  },
  {
    name: "file_operations",
    columns: [
      { name: "id", type: "uuid", nullable: false },
      { name: "operation_key", type: "text", nullable: false },
      { name: "kind", type: "text", nullable: false },
      { name: "relative_path", type: "text", nullable: false },
      { name: "session_id", type: "uuid", nullable: true },
      { name: "project_id", type: "uuid", nullable: true },
      { name: "state", type: "text", nullable: false },
      { name: "attempt_count", type: "integer", nullable: false, default: 0 },
      { name: "available_at", type: "integer", nullable: false },
      { name: "lease_until", type: "integer", nullable: true },
      { name: "lease_token", type: "text", nullable: true },
      { name: "last_error", type: "text", nullable: true },
      { name: "created_at", type: "integer", nullable: false },
      { name: "updated_at", type: "integer", nullable: false },
    ],
    primaryKey: { columns: ["id"] },
    foreignKeys: [],
    indexes: [
      { name: "idx_file_operations_key", columns: [{ name: "operation_key" }], unique: true },
      { name: "idx_file_operations_claim", columns: [{ name: "state" }, { name: "available_at" }] },
    ],
  },
]);