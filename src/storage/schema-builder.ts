// Manifest → 方言无关 Kysely schema builder（工作包 C：SQLite 与 PostgreSQL bootstrap 共用）。
//
// 职责边界：
// - 本文件只做「把 Schema Manifest 按顺序转换成 Kysely schema builder 调用」，不含任何方言细节。
// - 逻辑列类型（LogicalColumnType）→ 物理类型名由各方言 bootstrap 提供 LogicalTypeMap 注入：
//     SQLite：uuid/text/json→text、integer/bigint→integer（src/storage/bootstrap.ts）
//     PG：    uuid→uuid、text/json→text、integer/bigint→bigint（src/storage/postgres-bootstrap.ts）
// - Manifest 仍是 schema 的唯一手工来源（schema-manifest.ts）；本文件并不是第二份 DDL。

import { Kysely, type ColumnDefinitionBuilder, type CreateTableBuilder, type ForeignKeyConstraintBuilder } from "kysely";
import { schemaManifest, type LogicalColumnType, type SchemaManifest, type TableManifest } from "./schema-manifest.js";
import type { DatabaseSchema } from "./db-schema.js";

/**
 * 逻辑列类型 → 物理类型名（方言特定），由 SQLite/PG 各自的 bootstrap 提供。
 * 取值限定为本 schema 用到的 Kysely SimpleColumnDataType 子集（text/integer/uuid/bigint），
 * 以便直接用作 DataTypeExpression，不依赖裸 string。
 */
export type PhysicalColumnType = "text" | "integer" | "uuid" | "bigint";

/** 逻辑列类型 → 物理类型名（方言特定），由 SQLite/PG 各自的 bootstrap 提供。 */
export type LogicalTypeMap = Readonly<Record<LogicalColumnType, PhysicalColumnType>>;

/**
 * 可选 bootstrap 覆盖（SQLite bootstrap.ts 与 PostgreSQL postgres-bootstrap.ts 共用）。
 */
export interface SchemaBootstrapOptions {
  /**
   * 测试/诊断 seam：preflight 与 DDL 阶段都用该 Manifest 代替生产的 schemaManifest。
   * 注入一份「DDL 中途必失败」的 Manifest（例如某张表的索引引用不存在的列）即可验证
   * bootstrap 的原子性：失败后整个事务回滚、数据库保持空库，换回生产 Manifest 重试成功。
   * 生产调用方不传。
   */
  readonly manifest?: SchemaManifest;
}

/** 由 Manifest 表声明构建 CREATE TABLE IF NOT EXISTS（列、主键、外键）。
 *  导出：bootstrap 复用 + 测试直接验证对任意单表/任意方言类型映射的建表行为（含 PK 防御性 notNull）。 */
export async function createTableFromManifest(
  kysely: Kysely<DatabaseSchema>,
  table: TableManifest,
  typeMap: LogicalTypeMap,
): Promise<void> {
  let builder: CreateTableBuilder<string, string> = kysely.schema
    .createTable(table.name)
    .ifNotExists() as CreateTableBuilder<string, string>;

  for (const column of table.columns) {
    builder = builder.addColumn(column.name, typeMap[column.type], (col) =>
      buildColumnDefinition(col, table, column),
    );
  }

  const pk = table.primaryKey;
  // 单列且未命名 → 列级 primaryKey()（与 SQLite 历史 DDL 一致；PG 同形态，PG 默认命名 <table>_pkey）；
  // 否则命名/复合约束（idempotency_pk）。
  if (pk.constraintName !== undefined || pk.columns.length > 1) {
    builder = builder.addPrimaryKeyConstraint(pk.constraintName ?? `${table.name}_pk`, [...pk.columns]);
  }

  for (const fk of table.foreignKeys ?? []) {
    builder = builder.addForeignKeyConstraint(
      fk.constraintName,
      [...fk.columns],
      fk.targetTable,
      [...fk.targetColumns],
      (cb: ForeignKeyConstraintBuilder) => cb.onDelete(fk.onDelete),
    );
  }

  await builder.execute();
}

function buildColumnDefinition(
  col: ColumnDefinitionBuilder,
  table: TableManifest,
  column: TableManifest["columns"][number],
): ColumnDefinitionBuilder {
  let c = col;
  const pk = table.primaryKey;
  const isPkColumn = pk.columns.includes(column.name);
  // PK 列恒 NOT NULL：即使列级 nullable 声明或 Manifest 运行期校验被绕过（未来校验变更），
  // bootstrap 也防御性强制 notNull —— 主键值不可为 NULL 是数据库级语义（SQLite/PG 通用）。
  if (!column.nullable || isPkColumn) c = c.notNull();
  if (column.default !== undefined) c = c.defaultTo(column.default);
  if (pk.constraintName === undefined && pk.columns.length === 1 && isPkColumn) {
    c = c.primaryKey();
  }
  return c;
}

/** 由 Manifest 索引声明构建 CREATE INDEX IF NOT EXISTS（列与排序方向，含 updated_at DESC）。 */
export async function createIndexFromManifest(
  kysely: Kysely<DatabaseSchema>,
  table: TableManifest,
  index: NonNullable<TableManifest["indexes"]>[number],
): Promise<void> {
  const orderedColumns = index.columns.map((c) => (c.order === "desc" ? `${c.name} desc` : c.name));
  const builder = kysely.schema.createIndex(index.name).ifNotExists().on(table.name);
  if (index.unique) {
    await builder.unique().columns(orderedColumns).execute();
  } else {
    await builder.columns(orderedColumns).execute();
  }
}

/** 按 Manifest 表顺序（FK 目标先于引用表）幂等创建全部表与索引。SQLite/PG bootstrap 共用。 */
export async function bootstrapSchemaFromManifest(
  kysely: Kysely<DatabaseSchema>,
  typeMap: LogicalTypeMap,
  manifest: SchemaManifest = schemaManifest,
): Promise<void> {
  // Manifest 保留字面量类型供 DatabaseSchema 推导；bootstrap 只需表/列/约束的宽化契约。
  const tables: readonly TableManifest[] = manifest.tables;
  for (const table of tables) {
    await createTableFromManifest(kysely, table, typeMap);
    for (const index of table.indexes ?? []) {
      await createIndexFromManifest(kysely, table, index);
    }
  }
}