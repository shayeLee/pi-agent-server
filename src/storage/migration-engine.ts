// Offline Manifest-driven migration runner (WP1).
// Service startup always requires an already migrated, verified database. It never
// bootstraps a baseline; offline `migrate` is the only writer that establishes it.
// The registry is a single immutable baseline (version 0 = the complete schemaManifest). Legacy
// ledgers from the removed v0/v1 registry and managed tables without any ledger fail fast in
// every mode and are never adopted by the runner or by server bootstrap.

import { DatabaseSync } from "node:sqlite";
import { Kysely, SqliteDialect, sql } from "kysely";
import { NodeSqliteAdapter } from "./node-sqlite-adapter.js";
import { assertSchemaCompatible } from "./schema-compatibility.js";
import type { DatabaseSchema } from "./db-schema.js";
import {
  migrationChecksum,
  migrationDefinitions,
  type MigrationDefinition,
  type MigrationDialect,
  validateMigrationDefinitions,
} from "./migration-manifest.js";
import type { SchemaManifest } from "./schema-manifest.js";
import type { LogicalTypeMap } from "./schema-builder.js";
import type { MigrationOperation } from "./migration-renderer.js";
import { registerSqliteWriteLockKey, sqliteWriteLockKeyForFilename } from "./sqlite-write-lock.js";
import { assertPostgresApplicationSchema } from "./postgres-schema-guard.js";

export const MIGRATION_LEDGER_TABLE = "schema_migrations";
/** One stable key for all instances migrating the same PostgreSQL schema. */
export const POSTGRES_MIGRATION_LOCK_KEY = 7_421_963_017;

export type MigrationMode = "apply" | "dry-run" | "verify";
export interface MigrationRunOptions {
  readonly mode?: MigrationMode;
  /** Bootstrap-only: with apply and no existing ledger, refuse any existing user object
   *  before creating the baseline. The check runs inside the same transactional connection
   *  that holds the write lock, closing the check/lock/apply race. */
  readonly assertEmptySchema?: boolean;
}

/** Test-isolation-only seam. Production runners never inspect this type/property. */
export interface TestMigrationRunOptions extends MigrationRunOptions {
  readonly migrations: readonly MigrationDefinition[];
}

type InternalMigrationRunOptions = MigrationRunOptions & {
  readonly migrations: readonly MigrationDefinition[];
};

export interface MigrationPlanItem {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied: boolean;
}

export interface MigrationRunResult {
  readonly mode: MigrationMode;
  readonly status: "planned" | "applied" | "verified";
  readonly appliedVersion: number | null;
  readonly pending: readonly MigrationPlanItem[];
}

type LedgerRow = { version: number; name: string; checksum: string; applied_at: number };
type MigrationState = { ledgerExists: boolean; rows: LedgerRow[] };

async function executeMigration(migration: MigrationDefinition, dialect: MigrationDialect, kysely: Kysely<DatabaseSchema>): Promise<void> {
  // The runner accepts only canonical immutable operations. There is no callback
  // escape hatch: execution is exactly the descriptor that was checksummed.
  for (const operation of migration.operations[dialect] as readonly MigrationOperation[]) {
    await sql.raw(operation.sql).execute(kysely);
  }
}

function defs(options: InternalMigrationRunOptions): readonly MigrationDefinition[] {
  const migrations = options.migrations;
  validateMigrationDefinitions(migrations);
  return migrations;
}

function migrationPlan(migrations: readonly MigrationDefinition[], appliedVersion: number | null): MigrationPlanItem[] {
  return migrations.map((migration) => ({
    version: migration.version,
    name: migration.name,
    checksum: migrationChecksum(migration),
    applied: appliedVersion !== null && migration.version <= appliedVersion,
  }));
}

/** Verify is a strict readiness check, not a report about a partially migrated database. */
function assertMigrationHead(
  mode: MigrationMode,
  migrations: readonly MigrationDefinition[],
  appliedVersion: number | null,
  pending: readonly MigrationPlanItem[],
): void {
  if (mode === "dry-run") return;
  const canonicalHead = migrations.at(-1)!.version;
  if (pending.length !== 0 || appliedVersion !== canonicalHead) {
    throw ledgerError(
      `${mode} did not reach the canonical migration head (applied v${String(appliedVersion)}, canonical head v${canonicalHead}, pending ${pending.length})`,
    );
  }
}

function ledgerError(message: string): Error {
  return new Error(`schema migration ledger: ${message}`);
}

function validInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}


function validateLedgerRows(rows: LedgerRow[], migrations: readonly MigrationDefinition[]): number {
  if (rows.length === 0) throw ledgerError("ledger exists but is empty/incomplete; refusing empty bootstrap");
  // The current registry is exactly one immutable baseline. Any additional
  // applied row belongs to an unsupported database and is never adopted.
  if (rows.length > migrations.length) {
    throw ledgerError(`applied ledger has ${rows.length} row(s), but the single-baseline registry has ${migrations.length}; recreate the database`);
  }
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const expected = migrations[index];
    if (!validInteger(row.version) || row.version < 0 || !expected || row.version !== index) {
      throw ledgerError(`version sequence is not strict contiguous order at row ${index} (found ${String(row.version)})`);
    }
    if (typeof row.name !== "string" || row.name !== expected.name) {
      throw ledgerError(`version ${row.version} name mismatch (ledger '${String(row.name)}', definition '${expected.name}')`);
    }
    if (typeof row.checksum !== "string" || !/^[0-9a-f]{64}$/.test(row.checksum)) {
      throw ledgerError(`version ${row.version} checksum mismatch: malformed (expected lowercase SHA-256 hex)`);
    }
    if (row.checksum !== migrationChecksum(expected)) {
      throw ledgerError(`version ${row.version} checksum mismatch; recreate the database from the single baseline`);
    }
    if (!validInteger(row.applied_at) || row.applied_at < 0) {
      throw ledgerError(`version ${row.version} applied_at is malformed (expected an integer)`);
    }
  }
  return rows.at(-1)!.version;
}

function quoteSqliteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`migration: unsafe identifier '${name}'`);
  return `"${name}"`;
}

function sqliteTableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    | { present: number }
    | undefined;
  return row !== undefined;
}

function sqliteManagedTableExists(db: DatabaseSync, manifests: readonly SchemaManifest[]): boolean {
  const names = new Set(manifests.flatMap((manifest) => manifest.tables.map((table) => table.name)));
  return [...names].some((name) => sqliteTableExists(db, name));
}

export function assertSqliteMigrationLedgerContract(db: DatabaseSync): void {
  const state = readSqliteLedger(db);
  if (!state.ledgerExists) throw ledgerError("migration ledger does not exist");
}

/** Bootstrap-only strict precondition: the SQLite target contains no user object at all.
 *  SQLite reserves the `sqlite_` prefix for internal objects (autoindexes, sqlite_sequence),
 *  so any row not prefixed with `sqlite_` is a user object and the database is not empty. */
function assertSqliteCompletelyEmpty(db: DatabaseSync): void {
  const row = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").get() as { count: number };
  if (row.count !== 0) {
    throw new Error("schema migration bootstrap: refusing to establish a baseline in a non-empty SQLite database (a user object already exists); start from an empty database");
  }
}

/** Bootstrap-only strict precondition: the PostgreSQL target schema contains no user object
 *  at all. Enumerates pg_catalog directly (not information_schema) so views, sequences,
 *  functions, composite/enum/domain types, and every relation kind are all caught. */
async function assertPostgresSchemaCompletelyEmpty(kysely: Kysely<DatabaseSchema>): Promise<void> {
  const result = await sql<{ kind: string; name: string }>`
    SELECT 'relation' AS kind, c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
    UNION ALL
    SELECT 'function', p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema()
    UNION ALL
    SELECT 'type', t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = current_schema()
    UNION ALL
    SELECT 'operator', o.oprname
    FROM pg_operator o
    JOIN pg_namespace n ON n.oid = o.oprnamespace
    WHERE n.nspname = current_schema()
    UNION ALL
    SELECT 'collation', c.collname
    FROM pg_collation c
    JOIN pg_namespace n ON n.oid = c.collnamespace
    WHERE n.nspname = current_schema()
    LIMIT 1
  `.execute(kysely);
  if (result.rows.length !== 0) {
    throw new Error("schema migration bootstrap: refusing to establish a baseline in a non-empty PostgreSQL schema (a user object already exists); create an empty non-public schema first");
  }
}

function readSqliteLedger(db: DatabaseSync): MigrationState {
  if (!sqliteTableExists(db, MIGRATION_LEDGER_TABLE)) return { ledgerExists: false, rows: [] };
  const columns = db.prepare(`PRAGMA table_xinfo(${quoteSqliteIdent(MIGRATION_LEDGER_TABLE)})`).all() as Array<{
    name: string; type: string; notnull: number; pk: number; hidden: number; dflt_value: string | null;
  }>;
  const expected = ["version", "name", "checksum", "applied_at"];
  const expectedTypes = [["INTEGER", "BIGINT"], ["TEXT"], ["TEXT"], ["INTEGER", "BIGINT"]];
  const tableSql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(MIGRATION_LEDGER_TABLE) as { sql?: unknown } | undefined)?.sql ?? "");
  const hasForbiddenTableFeature = /\b(?:CHECK|REFERENCES|WITHOUT\s+ROWID|STRICT)\b/i.test(tableSql);
  const indexes = db.prepare(`PRAGMA index_list(${quoteSqliteIdent(MIGRATION_LEDGER_TABLE)})`).all() as Array<{ origin: string; name: string }>;
  const uniqueIndexes = indexes.filter((index) => index.origin === "u");
  const primaryIndexes = indexes.filter((index) => index.origin === "pk");
  const primaryColumns = primaryIndexes.length === 1
    ? (db.prepare(`PRAGMA index_xinfo(${quoteSqliteIdent(primaryIndexes[0]!.name)})`).all() as Array<{ name: string | null; key: number }>).filter((column) => column.key === 1).map((column) => column.name)
    : [];
  const uniqueColumns = uniqueIndexes.length === 1
    ? (db.prepare(`PRAGMA index_xinfo(${quoteSqliteIdent(uniqueIndexes[0]!.name)})`).all() as Array<{ name: string | null; key: number; coll: string; desc: number }>).filter((column) => column.key === 1).map((column) => ({ name: column.name, coll: column.coll, desc: column.desc }))
    : [];
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteSqliteIdent(MIGRATION_LEDGER_TABLE)})`).all();
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").all(MIGRATION_LEDGER_TABLE);
  if (
    columns.length !== expected.length ||
    columns.some((column, index) => column.name !== expected[index] || column.notnull !== 1 || column.pk !== (index === 0 ? 1 : 0) || column.hidden !== 0 || column.dflt_value !== null || !expectedTypes[index]!.includes(column.type.trim().toUpperCase())) ||
    hasForbiddenTableFeature || indexes.some((index) => index.origin !== "u" && index.origin !== "pk") || primaryIndexes.length > 1 || (primaryIndexes.length === 1 && (primaryColumns.length !== 1 || primaryColumns[0] !== "version")) || uniqueColumns.length !== 1 || uniqueColumns[0]!.name !== "name" || uniqueColumns[0]!.coll !== "BINARY" || uniqueColumns[0]!.desc !== 0 || foreignKeys.length !== 0 || triggers.length !== 0
  ) {
    throw ledgerError("ledger table has an unexpected schema/object (only the four declared columns and version PK are allowed); refusing to alter or adopt it");
  }
  const rows = db.prepare(`SELECT version, name, checksum, applied_at FROM ${quoteSqliteIdent(MIGRATION_LEDGER_TABLE)} ORDER BY version`).all() as LedgerRow[];
  return { ledgerExists: true, rows };
}

function createSqliteKysely(db: DatabaseSync): Kysely<DatabaseSchema> {
  const kysely = new Kysely<DatabaseSchema>({
    // Migration transactions already issue their own explicit BEGIN IMMEDIATE;
    // keep Kysely's unused transaction hook deferred on this executor.
    dialect: new SqliteDialect({ database: new NodeSqliteAdapter(db, false, false) }),
  });
  const filename = sqliteFilename(db);
  registerSqliteWriteLockKey(kysely, filename ? sqliteWriteLockKeyForFilename(filename) : db);
  return kysely;
}

function sqliteFilename(db: DatabaseSync): string | null {
  const row = db.prepare("PRAGMA database_list").get() as { file?: unknown } | undefined;
  return typeof row?.file === "string" && row.file.length > 0 ? row.file : null;
}

/** File migrations use a short-lived, exclusively owned connection. Memory DBs
 * cannot be reopened, so their supplied connection is the executor. */
function openSqliteMigrationExecutor(db: DatabaseSync, mode: MigrationMode): { db: DatabaseSync; owned: boolean } {
  if (mode !== "apply") return { db, owned: false };
  const filename = sqliteFilename(db);
  if (!filename) return { db, owned: false };
  return {
    db: new DatabaseSync(filename, { timeout: 5000, enableForeignKeyConstraints: true }),
    owned: true,
  };
}

async function assertPhysical(
  kysely: Kysely<DatabaseSchema>,
  dialect: MigrationDialect,
  typeMap: LogicalTypeMap,
  manifest: SchemaManifest,
  message: string,
): Promise<void> {
  const verdict = await assertSchemaCompatible(kysely, dialect, typeMap, manifest);
  if (verdict !== "complete") throw ledgerError(message);
}

async function inspectSqlite(
  db: DatabaseSync,
  kysely: Kysely<DatabaseSchema>,
  migrations: readonly MigrationDefinition[],
  typeMap: LogicalTypeMap,
  mode: MigrationMode,
): Promise<{ state: MigrationState; appliedVersion: number | null }> {
  const state = readSqliteLedger(db);
  if (!state.ledgerExists) {
    if (sqliteManagedTableExists(db, migrations.map((migration) => migration.manifest))) {
      throw ledgerError("managed tables exist without the migration ledger; this is a legacy database and adoption is forbidden — start from an empty database and apply the single baseline");
    }
    if (mode === "verify") throw ledgerError("database has not been initialized by the migration runner");
    return { state, appliedVersion: null };
  }
  const appliedVersion = validateLedgerRows(state.rows, migrations);
  await assertPhysical(kysely, "SQLite", typeMap, migrations[appliedVersion]!.manifest, "physical schema is missing or incompatible with the applied manifest snapshot");
  return { state, appliedVersion };
}

function insertSqliteLedger(db: DatabaseSync, migration: MigrationDefinition): void {
  db.prepare(
    `INSERT INTO ${quoteSqliteIdent(MIGRATION_LEDGER_TABLE)} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
  ).run(migration.version, migration.name, migrationChecksum(migration), Date.now());
}

function createSqliteLedger(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE ${quoteSqliteIdent(MIGRATION_LEDGER_TABLE)} (\n` +
      "  version INTEGER PRIMARY KEY NOT NULL,\n" +
      "  name TEXT UNIQUE NOT NULL,\n" +
      "  checksum TEXT NOT NULL,\n" +
      "  applied_at INTEGER NOT NULL\n" +
      ")",
  );
}

// SQLite is explicitly single-instance. This mutex covers concurrent callers in
// one process; BEGIN IMMEDIATE remains the cross-process write exclusion.
const sqliteMemoryLocks = new WeakMap<object, Promise<void>>();
const sqliteFileLocks = new Map<string, Promise<void>>();
async function withSqliteMigrationLock<T>(db: DatabaseSync, action: () => Promise<T>): Promise<T> {
  const filename = sqliteFilename(db);
  const previous = filename ? sqliteFileLocks.get(filename) ?? Promise.resolve() : sqliteMemoryLocks.get(db) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  if (filename) sqliteFileLocks.set(filename, current);
  else sqliteMemoryLocks.set(db, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (filename) {
      if (sqliteFileLocks.get(filename) === current) sqliteFileLocks.delete(filename);
    } else if (sqliteMemoryLocks.get(db) === current) {
      sqliteMemoryLocks.delete(db);
    }
  }
}

function appendCleanupFailure(original: unknown, cleanup: unknown): never {
  const originalError = original instanceof Error ? original : new Error(String(original));
  const cleanupMessage = cleanup instanceof Error ? cleanup.message : String(cleanup);
  originalError.message = `${originalError.message}; migration cleanup failed: ${cleanupMessage}`;
  throw originalError;
}

/** SQLite runner: an exclusive BEGIN IMMEDIATE transaction surrounds DDL and ledger writes. */
async function runSqliteMigrationsInternal(
  db: DatabaseSync,
  options: InternalMigrationRunOptions,
): Promise<MigrationRunResult> {
  return withSqliteMigrationLock(db, async () => {
    const mode = options.mode ?? "apply";
    const migrations = defs(options);
    const executor = openSqliteMigrationExecutor(db, mode);
    const executorDb = executor.db;
    let executorClosed = false;
    const kysely = createSqliteKysely(executorDb);
    try {
      if (mode !== "apply") {
        const physicalTypeMap = migrations.at(-1)!.physicalTypeMaps.SQLite;
        const inspection = await inspectSqlite(executorDb, kysely, migrations, physicalTypeMap, mode);
        const pending = migrationPlan(migrations, inspection.appliedVersion).filter((item) => !item.applied);
        assertMigrationHead(mode, migrations, inspection.appliedVersion, pending);
        return { mode, status: mode === "verify" ? "verified" : "planned", appliedVersion: inspection.appliedVersion, pending };
      }

      executorDb.exec("BEGIN IMMEDIATE");
      try {
        const physicalTypeMap = migrations.at(-1)!.physicalTypeMaps.SQLite;
        // Bootstrap-only (assertEmptySchema): the target must be completely empty, regardless of
        // any existing ledger. The check owns the same BEGIN IMMEDIATE transaction connection as
        // the apply, so the empty check, the write lock, and the baseline creation cannot race.
        if (options.assertEmptySchema) assertSqliteCompletelyEmpty(executorDb);
        const inspection = await inspectSqlite(executorDb, kysely, migrations, physicalTypeMap, mode);
        let appliedVersion = inspection.appliedVersion;
        if (!inspection.state.ledgerExists) {
          createSqliteLedger(executorDb);
          for (const migration of migrations) {
            await executeMigration(migration, "SQLite", kysely);
            insertSqliteLedger(executorDb, migration);
            appliedVersion = migration.version;
          }
        } else {
          for (const migration of migrations) {
            if (migration.version <= (appliedVersion ?? -1)) continue;
            await executeMigration(migration, "SQLite", kysely);
            insertSqliteLedger(executorDb, migration);
            appliedVersion = migration.version;
          }
        }
        const pending = migrationPlan(migrations, appliedVersion).filter((item) => !item.applied);
        assertMigrationHead(mode, migrations, appliedVersion, pending);
        await assertPhysical(kysely, "SQLite", migrations.at(-1)!.physicalTypeMaps.SQLite, migrations.at(-1)!.manifest, "physical schema is incompatible with the migration head");
        executorDb.exec("COMMIT");
        return { mode, status: "applied", appliedVersion, pending };
      } catch (error) {
        try {
          executorDb.exec("ROLLBACK");
        } catch (cleanupError) {
          // A failed rollback means this connection may still hold a write lock
          // or an unknown transaction state. Never return it to the caller.
          try {
            executorDb.close();
            executorClosed = true;
          } catch (closeError) {
            appendCleanupFailure(error, new Error(`${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}; close failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`));
          }
          appendCleanupFailure(error, cleanupError);
        }
        throw error;
      }
    } finally {
      await kysely.destroy();
      if (executor.owned && !executorClosed) {
        try { executorDb.close(); } catch { /* original migration/cleanup error is preserved */ }
      }
    }
  });
}

type PgLedgerConstraintRow = {
  constraint_id: string;
  constraint_type: string;
  index_id: string | null;
  column_name: string | null;
  column_position: number | null;
  validated: boolean;
};

type PgLedgerIndexRow = {
  index_id: string;
  is_primary: boolean;
  is_unique: boolean;
  key_column_count: number;
  column_count: number;
  has_no_predicate: boolean;
  has_no_expressions: boolean;
  is_valid: boolean;
  is_ready: boolean;
  is_live: boolean;
  access_method: string;
  column_name: string | null;
  column_position: number | null;
};

/**
 * The ledger's PostgreSQL physical contract is deliberately small and explicit:
 * one BIGINT version primary key and one TEXT name UNIQUE constraint, plus the
 * two indexes PostgreSQL creates for those constraints.  Catalog object names
 * are not part of the contract; conindid/indexrelid links and index attributes
 * are checked instead, so renamed system objects remain valid while any extra
 * constraint or index remains fail-fast.
 */
export async function assertPostgresMigrationLedgerContract(kysely: Kysely<DatabaseSchema>): Promise<void> {
  const state = await pgLedgerState(kysely);
  if (!state.ledgerExists) throw ledgerError("migration ledger does not exist");
}

async function pgLedgerState(kysely: Kysely<DatabaseSchema>): Promise<MigrationState> {
  const table = await sql<{ relkind: string; relpersistence: string; is_partition: boolean; row_security: boolean; force_row_security: boolean; trigger_count: number }>`
    SELECT c.relkind,
           c.relpersistence,
           c.relispartition AS is_partition,
           c.relrowsecurity AS row_security,
           c.relforcerowsecurity AS force_row_security,
           count(t.oid)::int AS trigger_count
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    LEFT JOIN pg_trigger t ON t.tgrelid = c.oid AND NOT t.tgisinternal
    WHERE ns.nspname = current_schema() AND c.relname = 'schema_migrations'
    GROUP BY c.oid, c.relkind, c.relispartition, c.relrowsecurity, c.relforcerowsecurity
  `.execute(kysely);
  if (table.rows.length === 0) return { ledgerExists: false, rows: [] };
  if (table.rows[0]!.relkind !== "r" || table.rows[0]!.relpersistence !== "p" || table.rows[0]!.is_partition || table.rows[0]!.row_security || table.rows[0]!.force_row_security || table.rows[0]!.trigger_count !== 0) {
    throw ledgerError("ledger table has an unexpected relation/trigger/RLS object; refusing to alter or adopt it");
  }

  const columns = await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null; is_identity: string; is_generated: string }>`
    SELECT column_name, data_type, is_nullable, column_default, is_identity, is_generated
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'schema_migrations'
    ORDER BY ordinal_position
  `.execute(kysely);
  const expected = ["version", "name", "checksum", "applied_at"];
  // The released ledger DDL is BIGINT. Do not accept a complete INTEGER
  // ledger: its values may look compatible in JavaScript while its physical
  // contract is not the one this runner writes.
  const allowedTypes = [["bigint"], ["text"], ["text"], ["bigint"]];
  if (
    columns.rows.length !== expected.length ||
    columns.rows.some((column, index) => column.column_name !== expected[index] || column.is_nullable !== "NO" || !allowedTypes[index]!.includes(column.data_type) || column.column_default !== null || column.is_identity !== "NO" || column.is_generated !== "NEVER")
  ) {
    throw ledgerError("ledger table has an unexpected schema/type/default/generated column (version and applied_at must be BIGINT); refusing to alter or adopt it");
  }

  // Read every constraint and every index by catalog identity and attributes.
  // In particular, do not infer the expected objects from generated names.
  const constraintRows = await sql<PgLedgerConstraintRow>`
    SELECT con.oid::text AS constraint_id,
           con.contype AS constraint_type,
           CASE WHEN con.conindid = 0::oid THEN NULL ELSE con.conindid::text END AS index_id,
           a.attname AS column_name,
           key.ord::int AS column_position,
           con.convalidated AS validated
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    LEFT JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord) ON true
    LEFT JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key.attnum
    WHERE ns.nspname = current_schema() AND rel.relname = 'schema_migrations'
    ORDER BY con.oid, key.ord
  `.execute(kysely);
  const indexRows = await sql<PgLedgerIndexRow>`
    SELECT ix.indexrelid::text AS index_id,
           ix.indisprimary AS is_primary,
           ix.indisunique AS is_unique,
           ix.indnkeyatts::int AS key_column_count,
           ix.indnatts::int AS column_count,
           ix.indpred IS NULL AS has_no_predicate,
           ix.indexprs IS NULL AS has_no_expressions,
           ix.indisvalid AS is_valid,
           ix.indisready AS is_ready,
           ix.indislive AS is_live,
           am.amname AS access_method,
           a.attname AS column_name,
           key.ord::int AS column_position
    FROM pg_index ix
    JOIN pg_class rel ON rel.oid = ix.indrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    JOIN pg_class index_rel ON index_rel.oid = ix.indexrelid
    JOIN pg_am am ON am.oid = index_rel.relam
    LEFT JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS key(attnum, ord) ON true
    LEFT JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = key.attnum
    WHERE ns.nspname = current_schema() AND rel.relname = 'schema_migrations'
    ORDER BY ix.indexrelid, key.ord
  `.execute(kysely);

  const constraints = new Map<string, { type: string; indexId: string | null; columns: string[]; validated: boolean }>();
  for (const row of constraintRows.rows) {
    const constraint = constraints.get(row.constraint_id) ?? { type: row.constraint_type, indexId: row.index_id, columns: [], validated: row.validated };
    if (row.column_name !== null) constraint.columns.push(row.column_name);
    constraints.set(row.constraint_id, constraint);
  }
  const indexes = new Map<string, { primary: boolean; unique: boolean; keyColumnCount: number; columnCount: number; noPredicate: boolean; noExpressions: boolean; valid: boolean; ready: boolean; live: boolean; accessMethod: string; columns: string[]; hasExpression: boolean }>();
  for (const row of indexRows.rows) {
    const index = indexes.get(row.index_id) ?? {
      primary: row.is_primary,
      unique: row.is_unique,
      keyColumnCount: row.key_column_count,
      columnCount: row.column_count,
      noPredicate: row.has_no_predicate,
      noExpressions: row.has_no_expressions,
      valid: row.is_valid,
      ready: row.is_ready,
      live: row.is_live,
      accessMethod: row.access_method,
      columns: [],
      hasExpression: false,
    };
    if (row.column_name === null) index.hasExpression = true;
    else index.columns.push(row.column_name);
    indexes.set(row.index_id, index);
  }

  const constraintList = [...constraints.values()];
  const primary = constraintList.find((constraint) => constraint.type === "p");
  const nameUnique = constraintList.find((constraint) => constraint.type === "u");
  const primaryIndex = primary ? indexes.get(primary.indexId ?? "") : undefined;
  const nameUniqueIndex = nameUnique ? indexes.get(nameUnique.indexId ?? "") : undefined;
  const isExpectedIndex = (index: typeof primaryIndex, primaryIndexExpected: boolean, column: string): boolean => Boolean(
    index && index.primary === primaryIndexExpected && index.unique && index.keyColumnCount === 1 && index.columnCount === 1 &&
    index.noPredicate && index.noExpressions && !index.hasExpression && index.valid && index.ready && index.live &&
    index.accessMethod === "btree" && index.columns.length === 1 && index.columns[0] === column,
  );
  if (
    constraintList.length !== 2 || !primary || !nameUnique || primary.type !== "p" || nameUnique.type !== "u" ||
    !primary.validated || !nameUnique.validated || primary.columns.length !== 1 || primary.columns[0] !== "version" ||
    nameUnique.columns.length !== 1 || nameUnique.columns[0] !== "name" || indexes.size !== 2 ||
    !isExpectedIndex(primaryIndex, true, "version") || !isExpectedIndex(nameUniqueIndex, false, "name")
  ) {
    throw ledgerError("ledger table has an unexpected UNIQUE/CHECK/FK/index object; only version PRIMARY KEY and name UNIQUE with their backing indexes are allowed");
  }

  const result = await sql<LedgerRow>`
    SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version
  `.execute(kysely);
  return { ledgerExists: true, rows: result.rows };
}

async function inspectPostgres(
  kysely: Kysely<DatabaseSchema>,
  migrations: readonly MigrationDefinition[],
  typeMap: LogicalTypeMap,
  mode: MigrationMode,
): Promise<{ state: MigrationState; appliedVersion: number | null }> {
  const state = await pgLedgerState(kysely);
  if (!state.ledgerExists) {
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
    `.execute(kysely);
    const managed = new Set(migrations.flatMap((migration) => migration.manifest.tables.map((table) => table.name)));
    if (tables.rows.some((table) => managed.has(table.table_name))) {
      throw ledgerError("managed tables exist without the migration ledger; this is a legacy database and adoption is forbidden — start from an empty database and apply the single baseline");
    }
    if (mode === "verify") throw ledgerError("database has not been initialized by the migration runner");
    return { state, appliedVersion: null };
  }
  const appliedVersion = validateLedgerRows(state.rows, migrations);
  await assertPhysical(kysely, "PostgreSQL", typeMap, migrations[appliedVersion]!.manifest, "physical schema is missing or incompatible with the applied manifest snapshot");
  return { state, appliedVersion };
}

async function createPostgresLedger(kysely: Kysely<DatabaseSchema>): Promise<void> {
  await sql`
    CREATE TABLE schema_migrations (
      version BIGINT PRIMARY KEY NOT NULL,
      name TEXT UNIQUE NOT NULL,
      checksum TEXT NOT NULL,
      applied_at BIGINT NOT NULL
    )
  `.execute(kysely);
}

async function insertPostgresLedger(kysely: Kysely<DatabaseSchema>, migration: MigrationDefinition): Promise<void> {
  await sql`
    INSERT INTO schema_migrations (version, name, checksum, applied_at)
    VALUES (${migration.version}, ${migration.name}, ${migrationChecksum(migration)}, ${Date.now()})
  `.execute(kysely);
}

/** PostgreSQL runner: transaction-scoped advisory lock on the same dedicated transaction connection. */
async function runPostgresMigrationsInternal(
  kysely: Kysely<DatabaseSchema>,
  options: InternalMigrationRunOptions,
): Promise<MigrationRunResult> {
  const mode = options.mode ?? "apply";
  const migrations = defs(options);
  if (mode !== "apply") {
    // A dry-run/verify uses the same dedicated transaction connection as apply,
    // takes the same xact lock, and fixes its snapshot before catalog reads.
    return kysely.transaction().execute(async (transaction) => {
      const tx = transaction as unknown as Kysely<DatabaseSchema>;
      // PostgreSQL requires `SET TRANSACTION` to be issued before the first query
      // (including the current_schema() guard): `SET TRANSACTION ISOLATION LEVEL
      // ...` after any SELECT fails with "SET TRANSACTION ISOLATION LEVEL must be
      // called before any query". The non-public/system-schema guard is still the
      // first catalog/DDL-side check and still precedes the advisory lock, ledger
      // access, and application catalog lookup.
      await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.execute(tx);
      await assertPostgresApplicationSchema(tx);
      await sql`SELECT pg_advisory_xact_lock(${POSTGRES_MIGRATION_LOCK_KEY})`.execute(tx);
      const inspection = await inspectPostgres(tx, migrations, migrations.at(-1)!.physicalTypeMaps.PostgreSQL, mode);
      const pending = migrationPlan(migrations, inspection.appliedVersion).filter((item) => !item.applied);
      assertMigrationHead(mode, migrations, inspection.appliedVersion, pending);
      return { mode, status: mode === "verify" ? "verified" : "planned", appliedVersion: inspection.appliedVersion, pending };
    });
  }

  return kysely.transaction().execute(async (transaction) => {
    const tx = transaction as unknown as Kysely<DatabaseSchema>;
    // PostgreSQL gates/DDL check current_schema() first and reject public and system schemas.
    // This must precede any advisory lock, ledger access, catalog lookup, or application DDL.
    await assertPostgresApplicationSchema(tx);
    await sql`SELECT pg_advisory_xact_lock(${POSTGRES_MIGRATION_LOCK_KEY})`.execute(tx);
    // Bootstrap-only (assertEmptySchema): the target schema must be completely empty, regardless
    // of any existing ledger. The check shares the transaction-scoped advisory-lock connection
    // with the apply, so the empty check, the lock, and the baseline creation cannot race.
    if (options.assertEmptySchema) await assertPostgresSchemaCompletelyEmpty(tx);
    const inspection = await inspectPostgres(tx, migrations, migrations.at(-1)!.physicalTypeMaps.PostgreSQL, mode);
    let appliedVersion = inspection.appliedVersion;
    if (!inspection.state.ledgerExists) {
      await createPostgresLedger(tx);
      for (const migration of migrations) {
        await executeMigration(migration, "PostgreSQL", tx);
        await insertPostgresLedger(tx, migration);
        appliedVersion = migration.version;
      }
    } else {
      for (const migration of migrations) {
        if (migration.version <= (appliedVersion ?? -1)) continue;
        await executeMigration(migration, "PostgreSQL", tx);
        await insertPostgresLedger(tx, migration);
        appliedVersion = migration.version;
      }
    }
    const pending = migrationPlan(migrations, appliedVersion).filter((item) => !item.applied);
    assertMigrationHead(mode, migrations, appliedVersion, pending);
    await assertPhysical(tx, "PostgreSQL", migrations.at(-1)!.physicalTypeMaps.PostgreSQL, migrations.at(-1)!.manifest, "physical schema is incompatible with the migration head");
    return { mode, status: "applied", appliedVersion, pending };
  });
}

/** Production/offline runner: the checked-in one-row baseline is immutable and cannot be injected. */
export function runSqliteMigrations(
  db: DatabaseSync,
  options: MigrationRunOptions = {},
): Promise<MigrationRunResult> {
  return runSqliteMigrationsInternal(db, { ...options, migrations: migrationDefinitions });
}

/** Test-only isolated registry seam. Do not use from service or offline production code. */
export function runSqliteMigrationsForTest(
  db: DatabaseSync,
  options: TestMigrationRunOptions,
): Promise<MigrationRunResult> {
  return runSqliteMigrationsInternal(db, options);
}

/** Production/offline runner: the checked-in one-row baseline is immutable and cannot be injected. */
export function runPostgresMigrations(
  kysely: Kysely<DatabaseSchema>,
  options: MigrationRunOptions = {},
): Promise<MigrationRunResult> {
  return runPostgresMigrationsInternal(kysely, { ...options, migrations: migrationDefinitions });
}

/** Test-only isolated registry seam. Do not use from service or offline production code. */
export function runPostgresMigrationsForTest(
  kysely: Kysely<DatabaseSchema>,
  options: TestMigrationRunOptions,
): Promise<MigrationRunResult> {
  return runPostgresMigrationsInternal(kysely, options);
}
