// 严格 schema 兼容性 preflight（M1 升级 / 最终测试审计补强）：
//
// 职责：在任何建表 / 建索引 DDL **之前**审查数据库，按结果分三类处理：
//   1. 数据库完全没有 managed 表（全新库，或只有无关表）→ 返回 "empty"，
//      调用方随后执行正常的 Manifest → DDL bootstrap；
//   2. 数据库已含任一 managed 表 → 要求**完整** managed schema 与 Manifest 物理契约
//      一致（全部 3 张表都在 + 每张表的列名 / 物理类型 / nullable / DEFAULT /
//      单列或复合 PK / FK（目标列 + ON DELETE）/ 显式索引（列顺序、DESC、非 UNIQUE）
//      逐一吻合），任何不一致 → fail-fast（抛出聚合错误），**不执行任何 ALTER /
//      补列 / 建表 / 建索引**——旧版「只比列名、缺索引可被 IF NOT EXISTS 补建」的
//      宽容行为被移除；
//   3. 已含全部 managed 表且契约完全一致 → 返回 "complete"，调用方跳过 DDL（不重建）。
//
// 不引入 migration / metadata 表（无 kysely_migration 等）；Manifest 仍是 schema 的
// 唯一来源（schema-manifest.ts），本模块只读 introspection / catalog，不写任何 schema。
//
// 方言实现：SQLite 用 PRAGMA（table_info / foreign_key_list / index_list /
// index_xinfo），PostgreSQL 用 information_schema + pg_catalog；两套 catalog 暴露同一
// 个只读接口，由共享的比较逻辑消费（Manifest → 期望值）。

import { sql, type Kysely } from "kysely";
import { schemaManifest, type SchemaManifest, type TableManifest } from "./schema-manifest.js";
import type { DatabaseSchema } from "./db-schema.js";
import type { LogicalTypeMap } from "./schema-builder.js";

export type SchemaDialect = "SQLite" | "PostgreSQL";

/** The single-baseline migration ledger table; the only extra relation allowed alongside the manifest tables. */
const MIGRATION_LEDGER_TABLE_NAME = "schema_migrations";

/** preflight 结论：空库/无 managed 表（调用方应 bootstrap）或已完整一致（调用方应跳过 DDL）。 */
export type SchemaCompatVerdict = "empty" | "complete";

// ---------------------------------------------------------------------------
// Catalog 只读接口（方言实现见下）
// ---------------------------------------------------------------------------

interface CatalogColumn {
  name: string;
  /** 声明的物理类型（规范化小写，如 "text" / "integer" / "uuid" / "bigint"）。 */
  dataType: string;
  nullable: boolean;
  /** DEFAULT 表达式原文（无默认值为 null；比较时按 Manifest default 渲染期望）。 */
  defaultExpr: string | null;
}

interface CatalogForeignKey {
  /** 约束名；SQLite 的 PRAGMA 不暴露 FK 约束名 → null（该方言跳过名字比较）。 */
  constraintName: string | null;
  columns: string[];
  targetTable: string;
  targetColumns: string[];
  /** 规范化小写（cascade / restrict / set null / set default / no action）。 */
  onDelete: string;
}

interface CatalogIndexColumn {
  name: string;
  desc: boolean;
}

interface CatalogIndex {
  name: string;
  unique: boolean;
  columns: CatalogIndexColumn[];
}

interface Catalog {
  tableNames(): Promise<string[]>;
  columns(table: string): Promise<CatalogColumn[]>;
  /** 主键列（按声明顺序）；无主键返回 null。 */
  primaryKeyColumns(table: string): Promise<string[] | null>;
  foreignKeys(table: string): Promise<CatalogForeignKey[]>;
  /** 仅「显式」索引（排除 SQLite sqlite_autoindex_* / PG indisprimary 自动索引）。 */
  indexes(table: string): Promise<CatalogIndex[]>;
  /** 非关系对象（视图 / 触发器 / 序列等），manifest 从不声明任何此类对象。 */
  extraObjects(): Promise<string[]>;
}

/** 标识符白名单：本模块只拼接 Manifest 中的常量表/索引名，运行时校验防注入。 */
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`schema compatibility: unsafe identifier '${name}'`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// SQLite catalog（PRAGMA）
// ---------------------------------------------------------------------------

type SqliteTableInfoRow = { name: string; type: string | null; notnull: number; dflt_value: string | null; pk: number };
type SqliteFkRow = { id: number; seq: number; table: string; from: string; to: string; on_delete: string };
type SqliteIndexListRow = { name: string; unique: number; origin: string };
type SqliteIndexXinfoRow = { name: string | null; desc: number; key: number };

class SqliteCatalog implements Catalog {
  constructor(private readonly kysely: Kysely<DatabaseSchema>) {}

  private async rows<T>(query: string): Promise<T[]> {
    const { rows } = await sql<T>`${sql.raw(query)}`.execute(this.kysely);
    return rows as T[];
  }

  async tableNames(): Promise<string[]> {
    const rows = await this.rows<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    );
    return rows.map((r) => r.name).sort();
  }

  async columns(table: string): Promise<CatalogColumn[]> {
    const rows = await this.rows<SqliteTableInfoRow>(`PRAGMA table_info(${ident(table)})`);
    return rows.map((r) => ({
      name: r.name,
      dataType: String(r.type ?? "").toLowerCase(),
      nullable: r.notnull === 0,
      defaultExpr: r.dflt_value ?? null,
    }));
  }

  async primaryKeyColumns(table: string): Promise<string[] | null> {
    const rows = await this.rows<SqliteTableInfoRow>(`PRAGMA table_info(${ident(table)})`);
    const pk = rows.filter((r) => r.pk > 0).sort((a, b) => a.pk - b.pk).map((r) => r.name);
    return pk.length > 0 ? pk : null;
  }

  async foreignKeys(table: string): Promise<CatalogForeignKey[]> {
    const rows = await this.rows<SqliteFkRow>(`PRAGMA foreign_key_list(${ident(table)})`);
    // PRAGMA 不暴露 FK 约束名：按 (id) 分组保持多列 FK 的列顺序；名字置 null（该方言跳过名字比较）。
    const grouped = new Map<number, { columns: string[]; targetTable: string; targetColumns: string[]; onDelete: string }>();
    for (const row of rows) {
      const group = grouped.get(row.id) ?? { columns: [], targetTable: row.table, targetColumns: [], onDelete: String(row.on_delete).toLowerCase() };
      group.columns.push(row.from);
      group.targetColumns.push(row.to);
      grouped.set(row.id, group);
    }
    return [...grouped.values()].map((g) => ({
      constraintName: null,
      columns: g.columns,
      targetTable: g.targetTable,
      targetColumns: g.targetColumns,
      onDelete: g.onDelete,
    }));
  }

  async indexes(table: string): Promise<CatalogIndex[]> {
    const list = await this.rows<SqliteIndexListRow>(`PRAGMA index_list(${ident(table)})`);
    const out: CatalogIndex[] = [];
    for (const row of list) {
      // 只认显式 CREATE INDEX（origin='c'）；PK/UNIQUE 约束自动索引（origin='pk'/'u'）排除。
      if (row.origin !== "c") continue;
      const xinfo = await this.rows<SqliteIndexXinfoRow>(`PRAGMA index_xinfo(${ident(row.name)})`);
      const columns = xinfo
        .filter((c) => c.name !== null && c.key === 1)
        .map((c) => ({ name: c.name as string, desc: c.desc === 1 }));
      out.push({ name: row.name, unique: row.unique === 1, columns });
    }
    return out;
  }

  async extraObjects(): Promise<string[]> {
    const rows = await this.rows<{ type: string; name: string }>(
      `SELECT type, name FROM sqlite_master WHERE type IN ('view', 'trigger')`,
    );
    return rows.map((r) => `${r.type}:${r.name}`);
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL catalog（information_schema + pg_catalog）
// ---------------------------------------------------------------------------

const PG_CONFDEL: Readonly<Record<string, string>> = {
  c: "cascade",
  r: "restrict",
  n: "set null",
  d: "set default",
  a: "no action",
};

type PgColumnRow = { column_name: string; data_type: string; is_nullable: string; column_default: string | null };
type PgFkRow = {
  constraint_name: string;
  // node-postgres normally decodes PostgreSQL text[] (OID 1009) to string[],
  // but a raw/custom result parser may leave the wire-format value as text.
  // Keep this unknown until the catalog boundary validates it.
  columns: unknown;
  target_columns: unknown;
  target_table: string;
  confdeltype: string;
};
type PgIndexRow = { indexname: string; indisunique: boolean; indexdef: string };

/**
 * Normalize the two forms a PostgreSQL text[] can have at the Kysely catalog
 * boundary. With the normal node-postgres parser (OID 1009), array_agg(text)
 * is already a JavaScript string[]. A raw/custom parser can instead expose the
 * PostgreSQL wire representation (for example `{"project_id"}`), so do not
 * let that representation reach the shared comparer as an object/string.
 *
 * The catalog query below casts pg_attribute.attname (the PostgreSQL `name`
 * type) to text before aggregating. Without that cast, array_agg(name) has the
 * name[] OID (1003), which node-postgres returns as the raw string
 * `{"project_id"}` rather than a JavaScript array.
 */
export function normalizePgTextArray(value: unknown, field: string): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    if (value.every((item): item is string => typeof item === "string")) return [...value];
    throw new Error(`schema compatibility: PostgreSQL ${field} is not a text[]`);
  }
  if (typeof value !== "string") {
    throw new Error(`schema compatibility: PostgreSQL ${field} is not a text[]`);
  }

  const text = value.trim();
  if (text.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`schema compatibility: PostgreSQL ${field} is not a valid text[]`);
    }
    if (Array.isArray(parsed) && parsed.every((item): item is string => typeof item === "string")) return [...parsed];
    throw new Error(`schema compatibility: PostgreSQL ${field} is not a text[]`);
  }
  if (!text.startsWith("{") || !text.endsWith("}")) {
    throw new Error(`schema compatibility: PostgreSQL ${field} is not a text[]`);
  }

  // Parse the scalar PostgreSQL array form. Constraint column names are
  // identifiers, but handling quoting/escaping here keeps this a real parser
  // rather than a comma split and rejects malformed catalog data explicitly.
  const result: string[] = [];
  let item = "";
  let quoted = false;
  let escaped = false;
  for (const character of text.slice(1, -1)) {
    if (escaped) {
      item += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quoted) {
      if (character === '"') quoted = false;
      else item += character;
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      if (item === "NULL") throw new Error(`schema compatibility: PostgreSQL ${field} contains a NULL array element`);
      result.push(item);
      item = "";
    } else {
      item += character;
    }
  }
  if (escaped || quoted || item === "NULL") {
    throw new Error(`schema compatibility: PostgreSQL ${field} is not a valid text[]`);
  }
  if (text !== "{}") result.push(item);
  return result;
}

class PostgresCatalog implements Catalog {
  constructor(private readonly kysely: Kysely<DatabaseSchema>) {}

  async tableNames(): Promise<string[]> {
    const { rows } = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
    `.execute(this.kysely);
    return rows.map((r) => r.table_name).sort();
  }

  async columns(table: string): Promise<CatalogColumn[]> {
    const { rows } = await sql<PgColumnRow>`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ${table}
      ORDER BY ordinal_position
    `.execute(this.kysely);
    return rows.map((r) => ({
      name: r.column_name,
      dataType: String(r.data_type).toLowerCase(),
      nullable: r.is_nullable === "YES",
      defaultExpr: r.column_default ?? null,
    }));
  }

  async primaryKeyColumns(table: string): Promise<string[] | null> {
    // 不能用 information_schema.table_constraints：它的权限过滤只认
    // INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER（含列级
    // INSERT/UPDATE/REFERENCES），`SELECT` 不在其中。仅 SELECT 权限的只读
    // planner role 会看到 0 行，把真实主键误判成「无主键」→ 严格 verify 失败。
    // 改用 pg_catalog（pg_constraint/pg_attribute 对能读表的任何用户可见，且
    // 与同类 foreignKeys()/indexes() 的 catalog 查询一致）：主键身份与列序语义
    // 不变，owner 与只读 role 都能完成同一 strict preflight。
    const { rows } = await sql<{ column_name: string }>`
      SELECT a.attname AS column_name
      FROM pg_constraint con
      JOIN pg_namespace ns ON ns.oid = con.connamespace
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key.attnum
      WHERE ns.nspname = current_schema()
        AND rel.relname = ${table}
        AND con.contype = 'p'
      ORDER BY key.ord
    `.execute(this.kysely);
    const columns = rows.map((r) => r.column_name);
    return columns.length > 0 ? columns : null;
  }

  async foreignKeys(table: string): Promise<CatalogForeignKey[]> {
    const { rows } = await sql<PgFkRow>`
      SELECT con.conname AS constraint_name,
             (SELECT array_agg(a.attname::text ORDER BY k.ord)
                FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
             (SELECT array_agg(a.attname::text ORDER BY k.ord)
                FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS target_columns,
             ct.relname AS target_table,
             con.confdeltype AS confdeltype
      FROM pg_constraint con
      JOIN pg_namespace n ON n.oid = con.connamespace
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_class ct ON ct.oid = con.confrelid
      WHERE n.nspname = current_schema() AND c.relname = ${table} AND con.contype = 'f'
    `.execute(this.kysely);
    return rows.map((r) => ({
      constraintName: r.constraint_name,
      columns: normalizePgTextArray(r.columns, `${r.constraint_name}.columns`),
      targetTable: r.target_table,
      targetColumns: normalizePgTextArray(r.target_columns, `${r.constraint_name}.target_columns`),
      onDelete: PG_CONFDEL[r.confdeltype] ?? r.confdeltype.toLowerCase(),
    }));
  }

  async indexes(table: string): Promise<CatalogIndex[]> {
    const { rows } = await sql<PgIndexRow>`
      SELECT ic.relname AS indexname, ix.indisunique, pg_get_indexdef(ic.oid) AS indexdef
      FROM pg_index ix
      JOIN pg_class ic ON ic.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = ic.relnamespace
      JOIN pg_class itab ON itab.oid = ix.indrelid
      WHERE n.nspname = current_schema() AND itab.relname = ${table} AND ix.indisprimary = false
    `.execute(this.kysely);
    return rows.map((r) => {
      const columns = parsePgIndexColumns(r.indexdef);
      return { name: r.indexname, unique: r.indisunique, columns };
    });
  }

  async extraObjects(): Promise<string[]> {
    // relkind: S=sequence, v=view, m=materialized view, f=foreign table,
    // p=partitioned table. Ordinary tables (r) and their indexes are covered
    // by the managed-table / extra-table and per-table index checks.
    const relations = await sql<{ relkind: string; relname: string }>`
      SELECT c.relkind, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind IN ('S', 'v', 'm', 'f', 'p')
    `.execute(this.kysely);
    const triggers = await sql<{ tgname: string }>`
      SELECT DISTINCT t.tgname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND NOT t.tgisinternal
    `.execute(this.kysely);
    return [
      ...relations.rows.map((r) => `${r.relkind}:${r.relname}`),
      ...triggers.rows.map((r) => `trigger:${r.tgname}`),
    ];
  }
}

/** 从 pg_get_indexdef 提取 btree 索引列（含 DESC 判定），如 (owner_key, updated_at DESC)。 */
function parsePgIndexColumns(indexdef: string): CatalogIndexColumn[] {
  const m = indexdef.match(/\(([^)]*)\)\s*$/);
  if (!m?.[1]) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((token) => {
      const desc = / desc$/i.test(token);
      const name = desc ? token.replace(/\s+desc$/i, "") : token;
      return { name: name.trim(), desc };
    });
}

// ---------------------------------------------------------------------------
// 共享比较逻辑（Manifest → 期望值）
// ---------------------------------------------------------------------------

function arrayEq(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function indexColumnsEq(a: readonly CatalogIndexColumn[], b: readonly CatalogIndexColumn[]): boolean {
  return a.length === b.length && a.every((v, i) => v.name === b[i]!.name && v.desc === b[i]!.desc);
}

function compareColumns(problems: string[], table: TableManifest, typeMap: LogicalTypeMap, actual: CatalogColumn[]): void {
  const byName = new Map(actual.map((c) => [c.name, c]));
  for (const column of table.columns) {
    const found = byName.get(column.name);
    if (!found) {
      problems.push(`表 '${table.name}' 缺少 Manifest 列 '${column.name}'`);
      continue;
    }
    const expectedType = typeMap[column.type];
    if (found.dataType !== expectedType) {
      problems.push(`表 '${table.name}' 列 '${column.name}' 物理类型不匹配：期望 ${expectedType}，实际 ${found.dataType}`);
    }
    if (found.nullable !== column.nullable) {
      problems.push(
        `表 '${table.name}' 列 '${column.name}' nullable 不匹配：期望 ${column.nullable ? "可空" : "NOT NULL"}，实际 ${found.nullable ? "可空" : "NOT NULL"}`,
      );
    }
    if (column.default === undefined) {
      if (found.defaultExpr !== null) {
        problems.push(`表 '${table.name}' 列 '${column.name}' 存在 Manifest 之外的多余 DEFAULT`);
      }
    } else {
      const literal = String(column.default);
      if (found.defaultExpr === null) {
        problems.push(`表 '${table.name}' 列 '${column.name}' 缺少 DEFAULT 子句`);
      } else if (!found.defaultExpr.includes(literal)) {
        problems.push(`表 '${table.name}' 列 '${column.name}' DEFAULT 不匹配：期望 ${literal}，实际 ${found.defaultExpr}`);
      }
    }
  }
  for (const column of actual) {
    if (!table.columns.some((c) => c.name === column.name)) {
      problems.push(`表 '${table.name}' 存在 Manifest 之外的列 '${column.name}'`);
    }
  }
}

function comparePrimaryKey(problems: string[], table: TableManifest, actual: string[] | null): void {
  const expected = table.primaryKey.columns;
  const label = (cols: string[] | null): string =>
    cols === null ? "无主键" : `[${cols.join(", ")}]`;
  if (actual === null || !arrayEq(actual, expected)) {
    problems.push(
      `表 '${table.name}' 主键不匹配：期望 ${label(expected as unknown as string[])}，实际 ${label(actual)}`,
    );
  }
}

function compareForeignKeys(
  problems: string[],
  dialect: SchemaDialect,
  table: TableManifest,
  actual: CatalogForeignKey[],
): void {
  const expected = table.foreignKeys ?? [];
  const shapeMatches = (c: CatalogForeignKey, e: (typeof expected)[number]): boolean =>
    arrayEq(c.columns, [...e.columns]) &&
    c.targetTable === e.targetTable &&
    arrayEq(c.targetColumns, [...e.targetColumns]) &&
    c.onDelete === e.onDelete;

  for (const fk of expected) {
    const match = actual.find((c) => shapeMatches(c, fk));
    if (!match) {
      problems.push(
        `表 '${table.name}' 缺少/不匹配外键 '${fk.constraintName}'（[${fk.columns.join(", ")}] → ${fk.targetTable}[${fk.targetColumns.join(", ")}] onDelete=${fk.onDelete}）`,
      );
    } else if (dialect === "PostgreSQL" && match.constraintName !== fk.constraintName) {
      problems.push(`表 '${table.name}' 外键 '${match.constraintName}' 名称与 Manifest '${fk.constraintName}' 不一致`);
    }
  }
  for (const fk of actual) {
    if (!expected.some((e) => shapeMatches(fk, e))) {
      problems.push(
        `表 '${table.name}' 存在 Manifest 之外的外键 '${fk.constraintName ?? "[无约束名]"}'（[${fk.columns.join(", ")}] → ${fk.targetTable}[${fk.targetColumns.join(", ")}] onDelete=${fk.onDelete}）`,
      );
    }
  }
}

const indexColumnsLabel = (columns: readonly CatalogIndexColumn[]): string =>
  columns.map((c) => (c.desc ? `${c.name} desc` : c.name)).join(", ");

function compareIndexes(problems: string[], table: TableManifest, actual: CatalogIndex[]): void {
  const expected = table.indexes ?? [];
  for (const index of expected) {
    const found = actual.find((i) => i.name === index.name);
    if (!found) {
      problems.push(
        `表 '${table.name}' 缺少显式索引 '${index.name}'（[${index.columns.map((c) => (c.order === "desc" ? `${c.name} desc` : c.name)).join(", ")}]）`,
      );
      continue;
    }
    const expectedColumns = index.columns.map((c) => ({ name: c.name, desc: c.order === "desc" }));
    if (!indexColumnsEq(found.columns, expectedColumns)) {
      problems.push(
        `索引 '${index.name}' 列不匹配：期望 [${indexColumnsLabel(expectedColumns)}]，实际 [${indexColumnsLabel(found.columns)}]`,
      );
    }
    if (Boolean(index.unique) !== found.unique) {
      problems.push(
        `索引 '${index.name}' unique 不匹配：期望 ${index.unique ? "UNIQUE" : "非 UNIQUE"}，实际 ${found.unique ? "UNIQUE" : "非 UNIQUE"}`,
      );
    }
  }
  for (const index of actual) {
    if (!expected.some((e) => e.name === index.name)) {
      problems.push(`表 '${table.name}' 存在 Manifest 之外的显式索引 '${index.name}'`);
    }
  }
}

function formatProblem(dialect: SchemaDialect, problems: string[]): Error {
  return new Error(
    [
      `${dialect} 数据库已存在 managed 表，schema 与当前 Manifest 物理契约不兼容（启动前 fail-fast：未执行任何 ALTER/补列/建表/建索引）`,
      `请以当前 schema 的空库启动，或删除旧库重建（validate 发现 ${problems.length} 处不一致）：`,
      ...problems.map((p) => `  - ${p}`),
    ].join("\n"),
  );
}

/**
 * 严格 schema 兼容性 preflight（在任何建表/建索引 DDL 之前调用）：
 * - 数据库无任何 managed 表 → "empty"（调用方可正常 bootstrap）；
 * - 已含任一 managed 表 → 完整校验列名/物理类型/nullable/DEFAULT/PK/FK/显式索引，
 *   全部一致 → "complete"（调用方应跳过 DDL）；任何不一致 → 抛聚合错误 fail-fast。
 *
 * @param kysely 只读 catalog 查询（不写 schema）
 * @param dialect "SQLite" | "PostgreSQL"
 * @param typeMap 逻辑类型 → 物理类型映射（物理契约；由各方言 bootstrap 注入）
 */
export async function assertSchemaCompatible(
  kysely: Kysely<DatabaseSchema>,
  dialect: SchemaDialect,
  typeMap: LogicalTypeMap,
  manifest: SchemaManifest = schemaManifest,
): Promise<SchemaCompatVerdict> {
  const catalog: Catalog =
    dialect === "SQLite" ? new SqliteCatalog(kysely) : new PostgresCatalog(kysely);
  const existingTables = new Set(await catalog.tableNames());
  const managedTables: readonly TableManifest[] = manifest.tables;

  if (!managedTables.some((t) => existingTables.has(t.name))) {
    return "empty"; // 全新库 / 只有无关表：允许正常 bootstrap
  }

  const problems: string[] = [];
  // Additional objects are never tolerated. A managed database that also
  // contains a table outside the manifest (and outside the single-baseline
  // ledger) is NOT the canonical single-baseline physical schema: it must not
  // be verified complete, adopted by bootstrap, or accepted as a backup source.
  // The ledger table is the only allowed extra relation.
  const managedNames = new Set(managedTables.map((table) => table.name));
  for (const table of existingTables) {
    if (!managedNames.has(table) && table !== MIGRATION_LEDGER_TABLE_NAME) {
      problems.push(`数据库存在 Manifest 之外的额外表 '${table}'（仅允许 canonical 表与 schema_migrations ledger）`);
    }
  }
  // Non-relation objects (views / triggers / sequences / matviews ...) are never
  // part of the manifest and must fail the gate if present.
  for (const object of await catalog.extraObjects()) {
    problems.push(`数据库存在 Manifest 之外的对象 '${object}'`);
  }
  for (const table of managedTables) {
    if (!existingTables.has(table.name)) {
      // 部分 managed 表存在：其余禁止「只建缺失表/只补索引」（必须整体一致或整体重建）。
      problems.push(`数据库已存在 managed 表但缺少 Manifest 表 '${table.name}'（不允许只创建缺失表）`);
      continue;
    }
    const [columns, pkColumns, foreignKeys, indexes] = await Promise.all([
      catalog.columns(table.name),
      catalog.primaryKeyColumns(table.name),
      catalog.foreignKeys(table.name),
      catalog.indexes(table.name),
    ]);
    compareColumns(problems, table, typeMap, columns);
    comparePrimaryKey(problems, table, pkColumns);
    compareForeignKeys(problems, dialect, table, foreignKeys);
    compareIndexes(problems, table, indexes);
  }

  if (problems.length > 0) {
    throw formatProblem(dialect, problems);
  }
  return "complete";
}