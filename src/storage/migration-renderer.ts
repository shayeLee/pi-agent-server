import type { LogicalTypeMap } from "./schema-builder.js";
import type { SchemaManifest, TableManifest } from "./schema-manifest.js";
import type { MigrationDialect } from "./migration-manifest.js";

/** A canonical executable operation. SQL is already normalized and immutable. */
export interface MigrationOperation {
  readonly kind: "ddl";
  readonly dialect: MigrationDialect;
  readonly sql: string;
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`migration renderer: unsafe identifier '${value}'`);
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function canonicalSql(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function renderTable(table: TableManifest, dialect: MigrationDialect, typeMap: LogicalTypeMap): string {
  const definitions: string[] = [];
  for (const column of table.columns) {
    const pk = table.primaryKey.columns.length === 1 && table.primaryKey.constraintName === undefined && table.primaryKey.columns[0] === column.name;
    const parts = [quoteIdentifier(column.name), typeMap[column.type].toUpperCase()];
    if (!column.nullable || table.primaryKey.columns.includes(column.name)) parts.push("NOT NULL");
    if (column.default !== undefined) {
      parts.push(`DEFAULT ${typeof column.default === "number" ? String(column.default) : quoteLiteral(column.default)}`);
    }
    if (pk) parts.push("PRIMARY KEY");
    definitions.push(parts.join(" "));
  }
  const primaryKey = table.primaryKey;
  if (primaryKey.constraintName !== undefined || primaryKey.columns.length > 1) {
    const prefix = primaryKey.constraintName === undefined ? "" : `CONSTRAINT ${quoteIdentifier(primaryKey.constraintName)} `;
    definitions.push(`${prefix}PRIMARY KEY (${primaryKey.columns.map(quoteIdentifier).join(", ")})`);
  }
  for (const foreignKey of table.foreignKeys ?? []) {
    definitions.push(
      `CONSTRAINT ${quoteIdentifier(foreignKey.constraintName)} FOREIGN KEY (${foreignKey.columns.map(quoteIdentifier).join(", ")}) ` +
      `REFERENCES ${quoteIdentifier(foreignKey.targetTable)} (${foreignKey.targetColumns.map(quoteIdentifier).join(", ")}) ` +
      `ON DELETE ${foreignKey.onDelete.toUpperCase()}`,
    );
  }
  // CREATE TABLE is intentionally not IF NOT EXISTS: the migration runner has
  // already proved that this exact operation is safe to apply in an empty DB.
  return canonicalSql(`CREATE TABLE ${quoteIdentifier(table.name)} (${definitions.join(", ")})`);
}

function renderIndex(table: TableManifest, index: NonNullable<TableManifest["indexes"]>[number]): string {
  const unique = index.unique ? "UNIQUE " : "";
  const columns = index.columns.map((column) => `${quoteIdentifier(column.name)}${column.order === "desc" ? " DESC" : ""}`).join(", ");
  return canonicalSql(`CREATE ${unique}INDEX ${quoteIdentifier(index.name)} ON ${quoteIdentifier(table.name)} (${columns})`);
}

/**
 * Stable renderer for the v0 descriptor. Both dialects are rendered from the
 * same immutable logical manifest; no Kysely builder or callback participates
 * in migration execution.
 */
export function renderMigrationOperations(
  manifest: SchemaManifest,
  dialect: MigrationDialect,
  typeMap: LogicalTypeMap,
): readonly MigrationOperation[] {
  const operations: MigrationOperation[] = [];
  for (const table of manifest.tables) {
    operations.push({ kind: "ddl", dialect, sql: renderTable(table, dialect, typeMap) });
    for (const index of table.indexes ?? []) {
      operations.push({ kind: "ddl", dialect, sql: renderIndex(table, index) });
    }
  }
  return Object.freeze(operations.map((operation) => Object.freeze(operation)));
}

export function canonicalizeMigrationOperations(operations: readonly MigrationOperation[]): readonly MigrationOperation[] {
  return Object.freeze(operations.map((operation) => Object.freeze({
    kind: operation.kind,
    dialect: operation.dialect,
    sql: canonicalSql(operation.sql),
  })));
}
