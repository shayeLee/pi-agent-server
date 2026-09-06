// Immutable, descriptor-driven migration registry (new baseline). The registry
// is now a SINGLE immutable migration at version 0 that builds the complete
// current schema from the full schemaManifest (projects / sessions /
// idempotency / file_operations). Published migrations contain data, not
// executable up callbacks: the exact canonical operations are rendered once
// from the immutable manifest and are the only operations the runner executes.
//
// The v0/v1 historical registry was removed with the legacy RC world (the
// controlled cutover tool is gone). Legacy ledgers and legacy databases
// without a ledger fail fast in the runner, in bootstrap, and in backup
// restore, and are never adopted automatically. Backup restore accepts only
// packages whose manifest carries exactly this canonical single baseline;
// packages from the removed v0/v1 world are not recoverable.

import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { renderMigrationOperations, type MigrationOperation } from "./migration-renderer.js";
import {
  LOGICAL_COLUMN_TYPE_KEYS,
  schemaManifest,
  type LogicalColumnType,
  type SchemaManifest,
} from "./schema-manifest.js";
import type { DatabaseSchema } from "./db-schema.js";
import type { LogicalTypeMap } from "./schema-builder.js";

export type MigrationDialect = "SQLite" | "PostgreSQL";
export const MIGRATION_DESCRIPTOR_FORMAT = "pi-agent-server.manifest-baseline.v1" as const;
export const MIGRATION_DDL_FORMAT_VERSION = 3 as const;
export const MIGRATION_OPERATION_FORMAT_VERSION = 3 as const;

// Kept as a public type for callers that need to type-check a transaction, but
// migration definitions deliberately do not contain a callback using it.
export interface MigrationExecutionContext {
  readonly kysely: Kysely<DatabaseSchema>;
  readonly dialect: MigrationDialect;
  readonly typeMap: LogicalTypeMap;
}

export type DataTransformDescriptor = Readonly<Record<string, unknown>>;

export interface MigrationDefinition {
  readonly version: number;
  readonly name: string;
  /** The complete schema snapshot; never replace this with a mutable head. */
  readonly manifest: SchemaManifest;
  readonly physicalTypeMaps: Readonly<Record<MigrationDialect, LogicalTypeMap>>;
  readonly operations: Readonly<Record<MigrationDialect, readonly MigrationOperation[]>>;
  readonly dataTransform: DataTransformDescriptor;
}

/** The authenticated ledger shape carried by backup manifests. */
export interface MigrationLedgerSnapshot {
  readonly present: boolean;
  readonly appliedCount: number;
  readonly appliedVersion: number | null;
  readonly checksums: readonly string[];
  readonly rows: readonly { readonly version: number; readonly name: string; readonly checksum: string; readonly applied_at: number }[];
  readonly pending: number;
}

/**
 * Select the immutable migration prefix represented by an authenticated
 * ledger.  A restore must verify the historical prefix, not the mutable
 * current head.  With the single-baseline registry this is exactly the v0
 * baseline; a missing ledger and legacy multi-row ledgers from the removed
 * v0/v1 registry are rejected.  This function performs no DDL and never
 * applies a migration.
 */
export interface MigrationPrefixOptions {
  /** Only test/fixture verifiers may bypass the registry checksum; real runners remain strict. */
  readonly requireCanonicalChecksum?: boolean;
}

export function migrationPrefixForLedger(ledger: MigrationLedgerSnapshot, options: MigrationPrefixOptions = {}): readonly MigrationDefinition[] {
  if (!ledger.present) {
    if (ledger.appliedCount !== 0 || ledger.appliedVersion !== null || ledger.checksums.length !== 0 || ledger.rows.length !== 0 || ledger.pending !== 0) {
      throw new Error("schema migration ledger: legacy ledger metadata is not empty");
    }
    return [];
  }
  const version = ledger.appliedVersion;
  const checkedVersion = typeof version === "number" ? version : -1;
  if (!Number.isSafeInteger(version) || checkedVersion < 0 ||
      ledger.appliedCount !== checkedVersion + 1 || ledger.rows.length !== ledger.appliedCount ||
      ledger.checksums.length !== ledger.appliedCount || ledger.pending !== 0) {
    throw new Error("schema migration ledger: authenticated ledger head is invalid");
  }
  const prefix = migrationDefinitions.slice(0, checkedVersion + 1);
  if (prefix.length !== ledger.appliedCount) {
    throw new Error(`schema migration ledger: backup references an unknown migration version ${checkedVersion}`);
  }
  for (const [index, migration] of prefix.entries()) {
    const row = ledger.rows[index];
    if (!row || row.version !== migration.version || row.name !== migration.name || row.checksum !== ledger.checksums[index] ||
        (options.requireCanonicalChecksum !== false && row.checksum !== migrationChecksum(migration))) {
      throw new Error(`schema migration ledger: backup history/checksum does not match the published migration at version ${index}`);
    }
  }
  return prefix;
}

/** Stable JSON: object keys are sorted, array order remains significant. */
export function stableSerialize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(object[key])}`).join(",")}}`;
}

/** Checksum covers every dialect's canonical operations, logical snapshot, type map and transform. */
export function migrationChecksum(migration: Pick<MigrationDefinition,
  "version" | "name" | "manifest" | "physicalTypeMaps" | "operations" | "dataTransform"
>): string {
  return createHash("sha256").update(stableSerialize({
    format: MIGRATION_DESCRIPTOR_FORMAT,
    version: migration.version,
    name: migration.name,
    manifest: migration.manifest,
    physicalTypeMaps: migration.physicalTypeMaps,
    operations: migration.operations,
    dataTransform: migration.dataTransform,
  }), "utf8").digest("hex");
}

export const SQLITE_PHYSICAL_TYPES: LogicalTypeMap = Object.freeze({
  uuid: "text", text: "text", integer: "integer", bigint: "integer", json: "text",
});
export const POSTGRES_PHYSICAL_TYPES: LogicalTypeMap = Object.freeze({
  uuid: "uuid", text: "text", integer: "bigint", bigint: "bigint", json: "text",
});
const BASELINE_PHYSICAL_TYPE_MAPS = Object.freeze({
  SQLite: SQLITE_PHYSICAL_TYPES,
  PostgreSQL: POSTGRES_PHYSICAL_TYPES,
});

/** Fixed golden snapshots for the single immutable baseline. Changing renderer
 * semantics must fail this module/tests. */
export const MIGRATION_BASELINE_GOLDEN_DDL_SNAPSHOT = Object.freeze({
  SQLite: Object.freeze([
    'CREATE TABLE "projects" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "cwd" TEXT NOT NULL, "owner_key" TEXT NOT NULL, "created_at" INTEGER NOT NULL)',
    'CREATE INDEX "idx_projects_owner" ON "projects" ("owner_key")',
    'CREATE TABLE "sessions" ("id" TEXT NOT NULL PRIMARY KEY, "owner_key" TEXT NOT NULL, "project_id" TEXT NOT NULL DEFAULT \'6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c\', "title" TEXT NOT NULL, "created_at" INTEGER NOT NULL, "updated_at" INTEGER NOT NULL, "pi_session_file" TEXT, "model_provider" TEXT, "model_id" TEXT, "thinking_level" TEXT, "system_prompt" TEXT, "capability_versions" TEXT, CONSTRAINT "sessions_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE)',
    'CREATE INDEX "idx_sessions_owner_updated" ON "sessions" ("owner_key", "updated_at" DESC)',
    'CREATE INDEX "idx_sessions_owner_project" ON "sessions" ("owner_key", "project_id")',
    'CREATE TABLE "idempotency" ("session_id" TEXT NOT NULL, "request_id" TEXT NOT NULL, "result" TEXT NOT NULL, "created_at" INTEGER NOT NULL, CONSTRAINT "idempotency_pk" PRIMARY KEY ("session_id", "request_id"))',
    'CREATE INDEX "idx_idempotency_created_at" ON "idempotency" ("created_at")',
    'CREATE TABLE "file_operations" ("id" TEXT NOT NULL PRIMARY KEY, "operation_key" TEXT NOT NULL, "kind" TEXT NOT NULL, "relative_path" TEXT NOT NULL, "session_id" TEXT, "project_id" TEXT, "state" TEXT NOT NULL, "attempt_count" INTEGER NOT NULL DEFAULT 0, "available_at" INTEGER NOT NULL, "lease_until" INTEGER, "lease_token" TEXT, "last_error" TEXT, "created_at" INTEGER NOT NULL, "updated_at" INTEGER NOT NULL)',
    'CREATE UNIQUE INDEX "idx_file_operations_key" ON "file_operations" ("operation_key")',
    'CREATE INDEX "idx_file_operations_claim" ON "file_operations" ("state", "available_at")',
  ]),
  PostgreSQL: Object.freeze([
    'CREATE TABLE "projects" ("id" UUID NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "cwd" TEXT NOT NULL, "owner_key" TEXT NOT NULL, "created_at" BIGINT NOT NULL)',
    'CREATE INDEX "idx_projects_owner" ON "projects" ("owner_key")',
    'CREATE TABLE "sessions" ("id" UUID NOT NULL PRIMARY KEY, "owner_key" TEXT NOT NULL, "project_id" UUID NOT NULL DEFAULT \'6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c\', "title" TEXT NOT NULL, "created_at" BIGINT NOT NULL, "updated_at" BIGINT NOT NULL, "pi_session_file" TEXT, "model_provider" TEXT, "model_id" TEXT, "thinking_level" TEXT, "system_prompt" TEXT, "capability_versions" TEXT, CONSTRAINT "sessions_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE)',
    'CREATE INDEX "idx_sessions_owner_updated" ON "sessions" ("owner_key", "updated_at" DESC)',
    'CREATE INDEX "idx_sessions_owner_project" ON "sessions" ("owner_key", "project_id")',
    'CREATE TABLE "idempotency" ("session_id" UUID NOT NULL, "request_id" TEXT NOT NULL, "result" TEXT NOT NULL, "created_at" BIGINT NOT NULL, CONSTRAINT "idempotency_pk" PRIMARY KEY ("session_id", "request_id"))',
    'CREATE INDEX "idx_idempotency_created_at" ON "idempotency" ("created_at")',
    'CREATE TABLE "file_operations" ("id" UUID NOT NULL PRIMARY KEY, "operation_key" TEXT NOT NULL, "kind" TEXT NOT NULL, "relative_path" TEXT NOT NULL, "session_id" UUID, "project_id" UUID, "state" TEXT NOT NULL, "attempt_count" BIGINT NOT NULL DEFAULT 0, "available_at" BIGINT NOT NULL, "lease_until" BIGINT, "lease_token" TEXT, "last_error" TEXT, "created_at" BIGINT NOT NULL, "updated_at" BIGINT NOT NULL)',
    'CREATE UNIQUE INDEX "idx_file_operations_key" ON "file_operations" ("operation_key")',
    'CREATE INDEX "idx_file_operations_claim" ON "file_operations" ("state", "available_at")',
  ]),
});
export const MIGRATION_BASELINE_GOLDEN_CHECKSUM = "85eb743ebcbe0e04f740ce58e8920218daadab091b6600d1f9f6cbb6b512c05c";

export const initialSchemaMigration: MigrationDefinition = deepFreeze({
  version: 0,
  name: "initial-schema",
  manifest: schemaManifest,
  physicalTypeMaps: BASELINE_PHYSICAL_TYPE_MAPS,
  operations: {
    SQLite: renderMigrationOperations(schemaManifest, "SQLite", SQLITE_PHYSICAL_TYPES),
    PostgreSQL: renderMigrationOperations(schemaManifest, "PostgreSQL", POSTGRES_PHYSICAL_TYPES),
  },
  dataTransform: { kind: "none", format: "pi-agent-server.data-transform.v1" },
});

export const migrationDefinitions: readonly MigrationDefinition[] = deepFreeze([
  initialSchemaMigration,
]);
export const migrationHeadManifest: SchemaManifest = schemaManifest;

function validateCanonicalBaseline(migration: MigrationDefinition): void {
  const operationsMatch = stableSerialize(migration.operations) === stableSerialize(initialSchemaMigration.operations);
  const descriptorMatch = stableSerialize(migration.dataTransform) === stableSerialize(initialSchemaMigration.dataTransform);
  const goldenMatch = (Object.keys(MIGRATION_BASELINE_GOLDEN_DDL_SNAPSHOT) as MigrationDialect[]).every((dialect) =>
    stableSerialize(migration.operations[dialect].map((operation) => operation.sql)) === stableSerialize(MIGRATION_BASELINE_GOLDEN_DDL_SNAPSHOT[dialect]),
  );
  if (
    migration.version !== 0 ||
    migration.name !== initialSchemaMigration.name ||
    migration.manifest !== schemaManifest ||
    migration.physicalTypeMaps !== initialSchemaMigration.physicalTypeMaps ||
    !operationsMatch ||
    !descriptorMatch ||
    !goldenMatch ||
    migrationChecksum(migration) !== MIGRATION_BASELINE_GOLDEN_CHECKSUM
  ) {
    throw new Error("migration manifest: registry version 0 does not exactly match the released canonical baseline descriptor, operations, checksum, and golden DDL");
  }
}

export function validateMigrationDefinitions(migrations: readonly MigrationDefinition[] = migrationDefinitions): void {
  if (migrations.length === 0) throw new Error("migration manifest: registry must not be empty");
  for (let index = 0; index < migrations.length; index++) {
    const migration = migrations[index]!;
    if (!Number.isInteger(migration.version) || migration.version !== index) {
      throw new Error(`migration manifest: versions must be strict contiguous order starting at 0 (found ${migration.version} at position ${index})`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(migration.name)) throw new Error(`migration manifest: unsafe or empty name at version ${migration.version}`);
    if (!migration.manifest || !migration.physicalTypeMaps || !migration.operations) throw new Error(`migration manifest: version ${migration.version} is incomplete`);
    for (const dialect of ["SQLite", "PostgreSQL"] as const) {
      const map = migration.physicalTypeMaps[dialect];
      const operations = migration.operations[dialect];
      if (!map || Object.keys(LOGICAL_COLUMN_TYPE_KEYS).some((key) => !(key in map))) throw new Error(`migration manifest: version ${migration.version} has incomplete ${dialect} physical type map`);
      if (!Array.isArray(operations) || operations.length === 0 || operations.some((op) => op.kind !== "ddl" || op.dialect !== dialect || typeof op.sql !== "string" || op.sql.trim() !== op.sql || /\s{2,}|[\r\n\t]/.test(op.sql))) {
        throw new Error(`migration manifest: version ${migration.version} has non-canonical ${dialect} operations`);
      }
    }
    if (!migration.dataTransform || typeof migration.dataTransform.kind !== "string") throw new Error(`migration manifest: version ${migration.version} has no explicit data-transform descriptor`);
  }
  validateCanonicalBaseline(migrations[0]!);
  if (migrations === migrationDefinitions && migrations.at(-1)!.manifest !== migrationHeadManifest) throw new Error("migration manifest: registry head does not match schemaManifest");
}

validateMigrationDefinitions();
for (const dialect of ["SQLite", "PostgreSQL"] as const) {
  const actual = initialSchemaMigration.operations[dialect].map((operation) => operation.sql);
  if (stableSerialize(actual) !== stableSerialize(MIGRATION_BASELINE_GOLDEN_DDL_SNAPSHOT[dialect])) {
    throw new Error(`migration manifest: released baseline ${dialect} DDL snapshot changed; append a migration instead`);
  }
}
if (migrationChecksum(initialSchemaMigration) !== MIGRATION_BASELINE_GOLDEN_CHECKSUM) {
  throw new Error("migration manifest: released baseline descriptor checksum changed; update only by appending a new migration");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  } else if (typeof value === "function") Object.freeze(value);
  return value;
}

export { schemaManifest, renderMigrationOperations };
export type { MigrationOperation } from "./migration-renderer.js";