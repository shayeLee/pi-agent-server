import { randomUUID, createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "../storage/db-schema.js";
import { createPostgresKysely, createPostgresPool, POSTGRES_LOGICAL_TYPE } from "../storage/postgres-bootstrap.js";
import { runPostgresMigrations } from "../storage/migration-engine.js";
import { assertSchemaCompatible } from "../storage/schema-compatibility.js";
import { migrationPrefixForLedger, schemaManifestV0, schemaManifestV1, type MigrationDefinition, type MigrationLedgerSnapshot } from "../storage/migration-manifest.js";
import { stableSerialize } from "../storage/migration-manifest.js";
import { validateRestoredFileOperations } from "./restore-validation.js";
import {
  decryptWithAdapter,
  deriveRelativeSessionPath,
  hashFile,
  isJsonlRelative,
  packageFiles,
  parseJsonl,
  relativePayloadPath,
  safeDirectory,
  safeRegular,
  validatePackage,
  validateWithSessionManager,
  restoreAgeAdapter,
  type RestoreAgeAdapter,
} from "./restore-core.js";
import {
  assertPostgresClientServerMajor,
  assertPostgresToolMajorMatch,
  parseClientMajor,
  parsePostgresConnectionUrl,
  parseServerVersionNumMajor,
  pgProcessAdapter,
  runPgProcess,
  sanitizedLibpqEnvironment,
  verifyBinary,
  withPgEnv,
  type PgBackupClient,
  type PgProcessAdapter,
} from "./postgres-backup-core.js";
import type { PostgresBackupManifest, BackupFileRecord } from "./backup-core.js";

const RESTORE_DIR_PREFIX = "restore-";
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_SHA256 = /^[0-9a-f]{64}$/;

export type PgRestoreClient = PgBackupClient;

export interface PostgresRestorePaths {
  readonly inputBackup: string;
  readonly targetRoot: string;
  readonly ageIdentityFile: string;
}

export const POSTGRES_RESTORE_SAFETY_CONTRACT = Object.freeze({
  version: 1,
  target: "new-empty-postgres-database",
  targetDatabasePrefix: "pi_restore_",
  requireEmptyDatabase: true,
  rejectPublicAuthenticatedSchema: true,
  /** A newly created database's inherent `public` namespace is an acceptable bootstrap
   * target only while it holds no objects; it is never an acceptable restore schema. */
  allowEmptyDefaultPublicSchema: true,
  rejectSourceDatabase: true,
  rejectSourceSchema: true,
  allowDefaultPublicSearchPath: true,
} as const);
export type PostgresRestoreSafetyContract = typeof POSTGRES_RESTORE_SAFETY_CONTRACT;

export interface PostgresRestoreOptions {
  readonly paths: PostgresRestorePaths;
  /** Explicit temporary target PG URL. It is never passed as a child argv item. */
  readonly targetDatabaseUrl: string;
  /** Required structural safety contract; a non-empty free-form token is never accepted. */
  readonly safetyContract: PostgresRestoreSafetyContract;
  readonly dryRun?: boolean;
  readonly age?: RestoreAgeAdapter;
  readonly crypto?: RestoreAgeAdapter;
  readonly cryptoAdapter?: RestoreAgeAdapter;
  readonly pgClient?: PgRestoreClient;
  readonly pgProcess?: PgProcessAdapter;
  readonly pgRestoreBinary?: string;
  /** Test/fixture hook; production uses the manifest-driven PG verify runner. */
  readonly verifyMigrations?: (client: PgRestoreClient, schema: string) => Promise<{ readonly version: number | null; readonly pending: number }>;
}

export interface PostgresRestoreReport {
  readonly status: "success";
  readonly dialect: "PostgreSQL";
  readonly format: "pi-agent-server.backup-manifest.v1";
  readonly counts: {
    readonly payloads: number;
    readonly jsonlFiles: number;
    readonly projects: number;
    readonly sessions: number;
    readonly idempotencyRows: number;
    readonly fileOperations: number;
    readonly sessionEntries: number;
    readonly sessionHeaders: number;
    readonly missingSessionReferences: number;
    readonly foreignKeyViolations: number;
  };
  readonly migration: { readonly version: number | null; readonly pending: number; readonly legacy: boolean };
  readonly target: {
    readonly databaseIdentity: string;
    readonly schemaIdentity: string;
    readonly schemaSummary: {
      readonly identity: string;
      readonly tableCount: number;
      readonly migrationVersion: number | null;
      readonly foreignKeyViolations: number;
    };
  };
}

export interface PostgresRestoreResult {
  readonly dryRun: boolean;
  readonly finalPath: string | null;
  readonly report: PostgresRestoreReport;
}

function fail(message: string): never {
  throw new Error(`restore: ${message}`);
}

function checkAncestors(input: string, label: string): string {
  if (!path.isAbsolute(input)) fail(`${label} must be an absolute path`);
  const absolute = path.resolve(input);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      const trustedSystemAlias = (process.platform === "darwin" && (current === "/var" || current === "/tmp")) ||
        (process.platform !== "darwin" && current === "/tmp");
      if (stat.isSymbolicLink() && !trustedSystemAlias) fail(`${label} contains a symbolic-link ancestor`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
  return absolute;
}

function canonicalPath(input: string, label: string): string {
  const absolute = checkAncestors(input, label);
  let existing = absolute;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...suffix);
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateRestorePaths(paths: PostgresRestorePaths): { input: string; target: string; identity: string } {
  const input = canonicalPath(paths.inputBackup, "input backup");
  const target = canonicalPath(paths.targetRoot, "target root");
  const identity = canonicalPath(paths.ageIdentityFile, "age identity file");
  if (path.resolve(target) === path.parse(target).root) fail("target root must not be the filesystem root");
  safeDirectory(input, "input backup");
  if (existsSync(paths.targetRoot)) safeDirectory(paths.targetRoot, "target root");
  safeRegular(paths.ageIdentityFile, "age identity file");
  const stat = lstatSync(paths.ageIdentityFile);
  if ((stat.mode & 0o077) !== 0) fail("age identity file must be owner-only (0600 or 0400)");
  if (within(input, target) || within(target, input) || within(input, identity) || within(identity, input) || within(target, identity) || within(identity, target)) fail("input, target, and identity paths overlap");
  return { input, target, identity };
}

function sourceRootsHash(roots: PostgresBackupManifest["sourceRoots"]): string {
  return createHash("sha256").update(stableSerialize(roots), "utf8").digest("hex");
}

function pgIdentity(value: string, kind: "database" | "schema"): string {
  return createHash("sha256").update(`pi-agent-server.pg-${kind}-identity.v1\0${value}`, "utf8").digest("hex");
}

function quoteIdentifier(value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) fail("PostgreSQL target schema is not a safe identifier");
  return `"${value}"`;
}

function validateLedger(ledger: PostgresBackupManifest["migrationLedger"]): void {
  if (!Number.isSafeInteger(ledger.appliedCount) || ledger.appliedCount < 0 ||
      !(ledger.appliedVersion === null || Number.isSafeInteger(ledger.appliedVersion)) ||
      !Array.isArray(ledger.checksums) || !Array.isArray(ledger.rows) || ledger.pending !== 0 ||
      ledger.rows.length !== ledger.appliedCount || ledger.checksums.length !== ledger.appliedCount ||
      ledger.present !== (ledger.appliedCount > 0)) fail("manifest migration ledger is invalid");
  for (const [index, row] of ledger.rows.entries()) {
    if (!Number.isSafeInteger(row.version) || row.version !== index || typeof row.name !== "string" ||
        !SAFE_SHA256.test(row.checksum) || row.checksum !== ledger.checksums[index] ||
        !Number.isSafeInteger(row.applied_at) || row.applied_at < 0) fail("manifest migration ledger is invalid");
  }
  if (ledger.appliedVersion !== (ledger.appliedCount === 0 ? null : ledger.rows.at(-1)!.version)) fail("manifest migration ledger head is invalid");
}

function validatePostgresManifest(value: unknown): PostgresBackupManifest {
  if (!value || typeof value !== "object") fail("manifest is not an object");
  const manifest = value as Partial<PostgresBackupManifest> & { credentials?: { included?: unknown; policy?: unknown } };
  if (manifest.format !== "pi-agent-server.backup-manifest.v1" || (manifest.kind !== "postgresql" && manifest.kind !== "pre-migration" && manifest.kind !== "pre-reset") || manifest.dialect !== "PostgreSQL") fail("unsupported backup format or dialect");
  if (!manifest.credentials || manifest.credentials.included !== false || manifest.credentials.policy !== "whitelist-excludes-credentials") fail("manifest credential policy is invalid");
  const roots = manifest.sourceRoots;
  if (!roots || typeof roots.dataDir !== "string" || !path.isAbsolute(roots.dataDir) || typeof roots.agentDir !== "string" || !path.isAbsolute(roots.agentDir)) fail("manifest must include explicit authenticated source roots");
  if (typeof manifest.sourceRootsSha256 !== "string" || !SAFE_SHA256.test(manifest.sourceRootsSha256) || manifest.sourceRootsHash !== manifest.sourceRootsSha256 || sourceRootsHash(roots) !== manifest.sourceRootsSha256) fail("manifest source roots hash is invalid");
  if (typeof manifest.createdAt !== "string" || !manifest.timeWindow || typeof manifest.timeWindow.startedAt !== "string" || typeof manifest.timeWindow.finishedAt !== "string") fail("manifest time metadata is invalid");
  const snapshot = manifest.postgres;
  if (!snapshot || !SAFE_SHA256.test(snapshot.databaseIdentity) || !SAFE_SHA256.test(snapshot.schemaIdentity) ||
    typeof snapshot.pgDumpVersion !== "string" || !/^[0-9]+(?:\.[0-9]+)+(?:[-+._A-Za-z0-9]*)?$/.test(snapshot.pgDumpVersion) ||
    typeof snapshot.pgRestoreVersion !== "string" || !/^[0-9]+(?:\.[0-9]+)+(?:[-+._A-Za-z0-9]*)?$/.test(snapshot.pgRestoreVersion)) fail("manifest PostgreSQL snapshot metadata is invalid");
  if (!manifest.migrationLedger) fail("manifest migration ledger is missing");
  validateLedger(manifest.migrationLedger);
  if (!manifest.encryption || manifest.encryption.format !== "age-v1" || !Array.isArray(manifest.encryption.recipients) || manifest.encryption.recipients.length === 0 || manifest.encryption.recipients.some((recipient) => typeof recipient !== "string" || !/^age1[0-9a-z]+$/.test(recipient))) fail("manifest age recipient metadata is invalid");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail("manifest payload list is invalid");

  const seen = new Set<string>();
  for (const value of manifest.files) {
    if (!value || typeof value !== "object") fail("manifest contains an invalid file record");
    const record = value as BackupFileRecord;
    const relative = relativePayloadPath(record.path);
    if (!relative.startsWith("payload/") || seen.has(relative)) fail("manifest contains a duplicate or non-payload path");
    seen.add(relative);
    const encryptedSize = record.encryptedSize;
    if (!(record.kind === "postgres-dump" || record.kind === "jsonl" || record.kind === "config") || !Number.isSafeInteger(record.size) || record.size < 0 || typeof record.sha256 !== "string" || !SAFE_SHA256.test(record.sha256) || typeof encryptedSize !== "number" || !Number.isSafeInteger(encryptedSize) || encryptedSize <= 0 || typeof record.encryptedSha256 !== "string" || !SAFE_SHA256.test(record.encryptedSha256)) fail("manifest contains an invalid file hash or size");
    const expectedKind = relative === "payload/database.pg_dump.age" ? "postgres-dump" : relative.endsWith(".jsonl.age") ? "jsonl" : "config";
    if (record.kind !== expectedKind || (expectedKind === "postgres-dump" && relative !== "payload/database.pg_dump.age") || (expectedKind === "jsonl" && !isJsonlRelative(relative.slice("payload/".length, -4))) || (expectedKind === "config" && relative !== "payload/.pi-agent/models.json.age" && relative !== "payload/agentDir/models.json.age")) fail("manifest contains a path outside the PostgreSQL payload whitelist");
  }
  if (seen.size === 0 || !seen.has("payload/database.pg_dump.age") || [...seen].filter((path) => path.endsWith("database.pg_dump.age")).length !== 1) fail("manifest must contain one PostgreSQL dump payload");
  if (!Array.isArray(manifest.missingSessionReferences) || !Array.isArray(manifest.excludedFiles)) fail("manifest reference metadata is invalid");
  const missingKeys = new Set<string>();
  const missingPaths = new Set<string>();
  for (const value of manifest.missingSessionReferences) {
    if (!value || typeof value !== "object") fail("manifest missing-reference metadata is invalid");
    const reference = value as Record<string, unknown>;
    if (typeof reference.sessionId !== "string" || !reference.sessionId || reference.status !== "missing" || typeof reference.path !== "string") fail("manifest missing-reference metadata is invalid");
    const relative = relativePayloadPath(reference.path);
    const key = `${reference.sessionId}\u0000${relative}`;
    if (!isJsonlRelative(relative) || missingKeys.has(key) || missingPaths.has(relative) || seen.has(`payload/${relative}.age`)) fail("manifest missing-reference metadata conflicts with payloads");
    missingKeys.add(key); missingPaths.add(relative);
  }
  for (const value of manifest.excludedFiles) {
    if (!value || typeof value !== "object" || typeof value.path !== "string" || value.reason !== "auth-file" || path.isAbsolute(value.path) || value.path.includes("..")) fail("manifest excluded-file metadata is invalid");
  }
  return manifest as PostgresBackupManifest;
}

function privateManifestStaging(targetParent: string): string {
  for (const candidate of [tmpdir(), "/var/tmp", process.cwd()]) {
    try {
      const parent = canonicalPath(candidate, "manifest staging parent");
      if (within(targetParent, parent)) continue;
      const staging = mkdtempSync(path.join(parent, ".pi-agent-restore-manifest-"));
      chmodSync(staging, 0o700);
      return staging;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  fail("could not create private manifest staging outside target parent");
}

function clientFromUrl(url: string): { client: PgRestoreClient; pool: ReturnType<typeof createPostgresPool> } {
  const pool = createPostgresPool(url);
  return {
    pool,
    client: {
      query: <T extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => pool.query<T>(text, values as unknown[] | undefined),
      end: () => pool.end(),
    },
  };
}

/** Scope only the post-restore verifier; the operator's target URL need not
 * contain search_path, and this derived URL is never given to pg_restore. */
function schemaScopedConnectionUrl(raw: string, schema: string): string {
  const url = new URL(raw);
  url.searchParams.set("options", `-c search_path=${quoteIdentifier(schema)}`);
  return url.toString();
}

type TargetIdentity = { database: string; schema: string; user: string; searchPath: string | undefined; serverMajor: number };

async function queryTargetServerMajor(client: PgRestoreClient): Promise<number> {
  try {
    const result = await client.query<{ server_version_num: unknown }>("SHOW server_version_num");
    return parseServerVersionNumMajor(result.rows[0]?.server_version_num);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("restore:")) throw error;
    fail("PostgreSQL server version inspection failed");
  }
}

async function targetIdentity(client: PgRestoreClient): Promise<TargetIdentity> {
  try {
    const result = await client.query<{ database: string; schema: string | null; user: string; search_path?: unknown }>("SELECT current_database() AS database, current_schema() AS schema, current_user AS user, current_setting('search_path') AS search_path");
    const row = result.rows[0];
    if (!row || typeof row.database !== "string" || typeof row.schema !== "string" || typeof row.user !== "string" || !row.database || !row.schema || !row.user || (row.search_path !== undefined && typeof row.search_path !== "string")) fail("PostgreSQL target returned no safe identity");
    quoteIdentifier(row.schema);
    const serverMajor = await queryTargetServerMajor(client);
    return { database: row.database, schema: row.schema, user: row.user, searchPath: typeof row.search_path === "string" ? row.search_path : undefined, serverMajor };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("restore:")) throw error;
    fail("PostgreSQL target connection or identity inspection failed");
  }
}

function validateSafetyContract(contract: PostgresRestoreOptions["safetyContract"]): void {
  if (stableSerialize(contract) !== stableSerialize(POSTGRES_RESTORE_SAFETY_CONTRACT)) fail("PostgreSQL restore requires the canonical new-empty-database safety contract");
}

function hasDefaultPublicSearchPath(searchPath: string | undefined): boolean {
  if (!searchPath) return false;
  return searchPath.replace(/\s+/g, "") === '"$user",public';
}

function validateTargetPreflight(target: TargetIdentity, manifest: PostgresBackupManifest): void {
  if (pgIdentity(target.database, "database") === manifest.postgres.databaseIdentity) fail("PostgreSQL restore target matches the authenticated source database");
  if (!/^pi_restore_[A-Za-z0-9_]+$/.test(target.database)) fail("PostgreSQL restore target must be a pi_restore_* temporary database");
  if (pgIdentity(target.schema, "schema") === manifest.postgres.schemaIdentity) fail("PostgreSQL restore target schema matches the authenticated source schema");
  // A default libpq connection starts in public so pg_restore can create the
  // authenticated non-public source schema. An explicitly authenticated public
  // schema is unsafe and is rejected before pg_restore.
  if (target.schema === "public" && !hasDefaultPublicSearchPath(target.searchPath)) fail("authenticated PostgreSQL target schema public is not allowed");
}

async function locateAuthenticatedSchema(client: PgRestoreClient, schemaIdentity: string): Promise<string> {
  if (schemaIdentity === pgIdentity("public", "schema")) fail("authenticated PostgreSQL source schema public is not allowed");
  try {
    const result = await client.query<{ schema_name: unknown }>(
      "SELECT nspname AS schema_name FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('information_schema', 'public') ORDER BY nspname",
    );
    const names = result.rows.map((row) => row.schema_name);
    if (names.some((name) => typeof name !== "string")) fail("PostgreSQL schema catalog is malformed");
    const matches = (names as string[]).filter((name) => SAFE_IDENTIFIER.test(name) && pgIdentity(name, "schema") === schemaIdentity);
    if (matches.length !== 1) fail("restored PostgreSQL authenticated source schema identity is not unique");
    quoteIdentifier(matches[0]!);
    return matches[0]!;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("restore:")) throw error;
    fail("restored PostgreSQL schema catalog inspection failed");
  }
}

/** Emptiness is judged by catalog objects, never by namespace names alone. */
const INHERENT_EMPTY_SCHEMA = "public";
const TARGET_NAMESPACE_MARKER = "pi-agent-server:pg_target_namespaces";
const TARGET_OBJECT_MARKER = "pi-agent-server:pg_target_object_inventory";
const TARGET_DATABASE_LEVEL_MARKER = "pi-agent-server:pg_target_database_level_inventory";
const TARGET_SYSTEM_USER_MARKER = "pi-agent-server:pg_target_system_user_inventory";
const EMPTY_TARGET_REJECTION = "PostgreSQL restore target must be a new empty database; automatic drop is forbidden";

/**
 * FirstNormalObjectId: objects created after initdb (by SQL, extensions, or
 * maintenance commands) always receive OIDs >= 16384, while every object a new
 * database inherits from initdb has a lower OID. A user-created object inside a
 * system schema therefore shows up as `oid >= 16384`, never as a baseline row.
 */
const FIRST_NORMAL_OBJECT_ID = 16384;

/** The initdb baseline extension: every new database on every supported major ships
 * `plpgsql` (installed into template1); it is the ONLY extension a new-empty
 * database may carry. Any other extension means the target was not created fresh. */
const BASELINE_EXTENSION = "plpgsql";

/** Server-owned namespaces: `pg_catalog`, `information_schema`, `pg_toast`, and
 * per-session `pg_temp_*`. Unlike NON_SYSTEM_NAMESPACE, this side of the split is
 * used to catch USER objects that were smuggled into a system schema. */
const SYSTEM_NAMESPACE = `nspname LIKE 'pg\\_%' OR nspname = 'information_schema'`;

/** `pg_toast` holds the TOAST tables of the system catalogs, so it is never empty
 * and must never be mistaken for user content in a newly created database.
 * `public` (OID 2200) is inherent too, and initdb creates no object inside it, so
 * an empty `public` is the only non-system namespace a new-empty target may have. */
const NON_SYSTEM_NAMESPACE = `nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`;

/** Database-level catalogs a new-empty database ships EMPTY (extensions besides
 * the plpgsql baseline, event triggers, publications, subscriptions). The
 * `pg_largeobject_metadata` half of database-level objects is already covered by
 * TARGET_OBJECTS_SQL; `pg_parameter_acl` (PG 15+) is appended when the server
 * major supports it. */
function targetDatabaseLevelSql(serverMajor: number): string {
  const parameterAcl = serverMajor >= 15
    ? `\n  UNION ALL\n  SELECT '(database)'::text, 'parameter acl', parname::text FROM pg_parameter_acl`
    : "";
  return `/* ${TARGET_DATABASE_LEVEL_MARKER} */
SELECT object_schema, object_kind, object_name FROM (
  SELECT '(database)'::text AS object_schema, 'extension'::text AS object_kind, extname::text AS object_name
  FROM pg_extension WHERE extname <> '${BASELINE_EXTENSION}'
  UNION ALL
  SELECT '(database)'::text, 'event trigger', evtname::text FROM pg_event_trigger
  UNION ALL
  SELECT '(database)'::text, 'publication', pubname::text FROM pg_publication
  UNION ALL
  SELECT '(database)'::text, 'subscription', subname::text FROM pg_subscription${parameterAcl}
) db_level ORDER BY object_schema, object_kind, object_name`;
}

/** Schema-scoped catalogs whose rows are objects created inside a namespace.
 * Column names are verified against the shipped bootstrap catalog (postgres.bki);
 * deliberately excludes server-wide catalogs whose shape has changed across versions. */
const TARGET_OBJECT_CATALOGS = [
  { kind: "relation", catalog: "pg_class", namespace: "relnamespace", name: "relname" },
  { kind: "routine", catalog: "pg_proc", namespace: "pronamespace", name: "proname" },
  { kind: "type", catalog: "pg_type", namespace: "typnamespace", name: "typname" },
  { kind: "collation", catalog: "pg_collation", namespace: "collnamespace", name: "collname" },
  { kind: "conversion", catalog: "pg_conversion", namespace: "connamespace", name: "conname" },
  { kind: "operator", catalog: "pg_operator", namespace: "oprnamespace", name: "oprname" },
  { kind: "operator class", catalog: "pg_opclass", namespace: "opcnamespace", name: "opcname" },
  { kind: "operator family", catalog: "pg_opfamily", namespace: "opfnamespace", name: "opfname" },
  { kind: "statistics object", catalog: "pg_statistic_ext", namespace: "stxnamespace", name: "stxname" },
  { kind: "text search configuration", catalog: "pg_ts_config", namespace: "cfgnamespace", name: "cfgname" },
  { kind: "text search dictionary", catalog: "pg_ts_dict", namespace: "dictnamespace", name: "dictname" },
  { kind: "text search parser", catalog: "pg_ts_parser", namespace: "prsnamespace", name: "prsname" },
  { kind: "text search template", catalog: "pg_ts_template", namespace: "tmplnamespace", name: "tmplname" },
] as const;

/** User-created objects hidden inside system schemas. Baseline initdb objects all
 * have OIDs below FirstNormalObjectId (pg_catalog, information_schema, and the
 * pg_toast tables of the system catalogs), so `oid >= 16384` singles out user
 * content without a stored baseline inventory. This scan is only valid while the
 * target holds no user tables (a restored table's own pg_toast entries are user
 * objects); it must never run after pg_restore. */
const TARGET_SYSTEM_USER_SQL = `/* ${TARGET_SYSTEM_USER_MARKER} */
WITH system_ns AS (
  SELECT oid, nspname FROM pg_namespace WHERE ${SYSTEM_NAMESPACE}
)
SELECT object_schema, object_kind, object_name FROM (
${TARGET_OBJECT_CATALOGS.map((entry) => `  SELECT ns.nspname::text AS object_schema, '${entry.kind}'::text AS object_kind, o.${entry.name}::text AS object_name FROM ${entry.catalog} o JOIN system_ns ns ON ns.oid = o.${entry.namespace} WHERE o.oid >= ${FIRST_NORMAL_OBJECT_ID}`).join("\n  UNION ALL\n")}
) user_object_inventory ORDER BY object_schema, object_kind, object_name`;

const TARGET_NAMESPACES_SQL = `/* ${TARGET_NAMESPACE_MARKER} */
SELECT nspname::text AS namespace_name FROM pg_namespace
WHERE ${NON_SYSTEM_NAMESPACE}
ORDER BY nspname`;

const TARGET_OBJECTS_SQL = `/* ${TARGET_OBJECT_MARKER} */
WITH target_ns AS (
  SELECT oid, nspname FROM pg_namespace WHERE ${NON_SYSTEM_NAMESPACE}
)
SELECT * FROM (
${TARGET_OBJECT_CATALOGS.map((entry) => `  SELECT ns.nspname::text AS object_schema, '${entry.kind}'::text AS object_kind, o.${entry.name}::text AS object_name FROM ${entry.catalog} o JOIN target_ns ns ON ns.oid = o.${entry.namespace}`).join("\n  UNION ALL\n")}
  UNION ALL
  SELECT '(database)'::text AS object_schema, 'large object'::text AS object_kind, l.oid::text AS object_name FROM pg_largeobject_metadata l
) inventory
ORDER BY object_schema, object_kind, object_name`;

interface TargetObjectRef {
  readonly schema: string;
  readonly kind: string;
  readonly name: string;
}

function catalogText(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") fail(`PostgreSQL ${label} catalog is malformed`);
  return value;
}

function previewReferences(values: readonly string[]): string {
  return values.length > 5 ? `${values.slice(0, 5).join(", ")}, +${values.length - 5} more` : values.join(", ");
}

function describeObjects(objects: readonly TargetObjectRef[]): string {
  return previewReferences(objects.map((object) => `${object.schema}.${object.kind} ${object.name}`));
}

/** Inspect every non-system namespace and every object it holds. Never drops or mutates anything. */
async function inspectTargetCatalog(client: PgRestoreClient): Promise<{ namespaces: string[]; objects: TargetObjectRef[] }> {
  const namespaces = await client.query<{ namespace_name: unknown }>(TARGET_NAMESPACES_SQL);
  const objects = await client.query<{ object_schema: unknown; object_kind: unknown; object_name: unknown }>(TARGET_OBJECTS_SQL);
  return {
    namespaces: namespaces.rows.map((row) => catalogText(row.namespace_name, "target namespace")),
    objects: objects.rows.map((row) => ({
      schema: catalogText(row.object_schema, "target object schema"),
      kind: catalogText(row.object_kind, "target object kind"),
      name: catalogText(row.object_name, "target object name"),
    })),
  };
}

/** Database-level objects (event triggers, non-baseline extensions, publications,
 * subscriptions, and PG 15+ parameter ACLs). A new-empty database ships none of them. */
async function inspectDatabaseLevelObjects(client: PgRestoreClient, serverMajor: number): Promise<TargetObjectRef[]> {
  const result = await client.query<{ object_schema: unknown; object_kind: unknown; object_name: unknown }>(targetDatabaseLevelSql(serverMajor));
  return result.rows
    .map((row) => ({
      schema: catalogText(row.object_schema, "target database-level schema"),
      kind: catalogText(row.object_kind, "target database-level kind"),
      name: catalogText(row.object_name, "target database-level name"),
    }))
    // The initdb plpgsql extension is the baseline a new-empty database always
    // carries; anything else in a database-level catalog is rejected below.
    .filter((object) => !(object.schema === "(database)" && object.kind === "extension" && object.name === BASELINE_EXTENSION));
}

/** User-created objects hidden inside system schemas (pg_catalog, information_schema,
 * pg_toast, per-session pg_temp_*). Baseline initdb objects all have OIDs below
 * FirstNormalObjectId, so an OID >= 16384 in a system schema is user content. */
async function inspectSystemSchemaUserObjects(client: PgRestoreClient): Promise<TargetObjectRef[]> {
  const result = await client.query<{ object_schema: unknown; object_kind: unknown; object_name: unknown }>(TARGET_SYSTEM_USER_SQL);
  return result.rows.map((row) => ({
    schema: catalogText(row.object_schema, "target system-schema schema"),
    kind: catalogText(row.object_kind, "target system-schema kind"),
    name: catalogText(row.object_name, "target system-schema name"),
  }));
}

/**
 * Accept only a freshly created, object-free database: the server-owned namespaces
 * plus the inherent, empty `public` bootstrap namespace. Rejected (nothing is ever
 * dropped): any user object in a non-system namespace (including `public`),
 * database-level objects (event triggers, non-baseline extensions, publications,
 * subscriptions, parameter ACLs, large objects), and user objects smuggled into a
 * system schema.
 */
async function assertEmptyTarget(client: PgRestoreClient, serverMajor: number): Promise<void> {
  try {
    const { namespaces, objects } = await inspectTargetCatalog(client);
    const unexpectedSchemas = namespaces.filter((name) => name !== INHERENT_EMPTY_SCHEMA);
    if (unexpectedSchemas.length !== 0) fail(`${EMPTY_TARGET_REJECTION}; target has non-system schema(s): ${previewReferences(unexpectedSchemas)}`);
    if (objects.length !== 0) fail(`${EMPTY_TARGET_REJECTION}; target already contains object(s): ${describeObjects(objects)}`);
    const databaseLevel = await inspectDatabaseLevelObjects(client, serverMajor);
    if (databaseLevel.length !== 0) fail(`${EMPTY_TARGET_REJECTION}; target already contains database-level object(s): ${describeObjects(databaseLevel)}`);
    // User objects in system schemas: no user table may exist yet, so a restored
    // database's own pg_toast entries cannot be mistaken for them. A user table,
    // function, type, or operator created inside pg_catalog/pg_toast/pg_temp_*
    // receives an OID >= FirstNormalObjectId and is rejected here.
    const systemUser = await inspectSystemSchemaUserObjects(client);
    if (systemUser.length !== 0) fail(`${EMPTY_TARGET_REJECTION}; target contains user object(s) in a system schema: ${describeObjects(systemUser)}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("restore:")) throw error;
    fail("PostgreSQL target emptiness check failed");
  }
}

/** Re-check the catalog after pg_restore: the dump may only write into the authenticated
 * non-public source schema, so the inherent empty `public` namespace must still be empty
 * and no other namespace may have appeared. Nothing is ever dropped automatically. */
async function assertRestoredSchemaIsolation(client: PgRestoreClient, restoredSchema: string): Promise<void> {
  try {
    if (restoredSchema === INHERENT_EMPTY_SCHEMA) fail("PostgreSQL restore target schema public is not allowed");
    const { namespaces, objects } = await inspectTargetCatalog(client);
    const unexpectedSchemas = namespaces.filter((name) => name !== INHERENT_EMPTY_SCHEMA && name !== restoredSchema);
    if (unexpectedSchemas.length !== 0) fail(`restored PostgreSQL target contains non-system schema(s) besides the authenticated source schema: ${previewReferences(unexpectedSchemas)}`);
    const stray = objects.filter((object) => object.schema !== restoredSchema);
    if (stray.length !== 0) fail(`restored PostgreSQL wrote object(s) outside the authenticated source schema; automatic drop is forbidden: ${describeObjects(stray)}`);
    if (objects.length === 0) fail("restored PostgreSQL schema contains no objects");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("restore:")) throw error;
    fail("restored PostgreSQL schema isolation check failed");
  }
}

type RestoreMigrationContext = {
  readonly legacy: boolean;
  readonly migrations: readonly MigrationDefinition[];
  readonly physicalManifest: typeof schemaManifestV0 | typeof schemaManifestV1 | null;
};

function selectRestoreMigrationContext(ledger: MigrationLedgerSnapshot, allowSyntheticChecksumForTest = false): RestoreMigrationContext {
  if (!ledger.present) return { legacy: true, migrations: [], physicalManifest: null };
  try {
    const migrations = migrationPrefixForLedger(ledger, { requireCanonicalChecksum: !allowSyntheticChecksumForTest });
    const physicalManifest = migrations.at(-1)?.manifest;
    if (!physicalManifest) fail("authenticated migration history is empty");
    return { legacy: false, migrations, physicalManifest: physicalManifest as typeof schemaManifestV0 | typeof schemaManifestV1 };
  } catch (error) {
    fail(error instanceof Error ? error.message.replace(/^schema migration ledger:\s*/, "") : "authenticated migration history is invalid");
  }
}

async function queryLedger(client: PgRestoreClient, schema: string): Promise<PostgresBackupManifest["migrationLedger"]> {
  try {
    // Read the table directly so this remains compatible with the narrow
    // client seam used by offline tests.  A real missing schema_migrations
    // relation is the explicit legacy signal.
    const result = await client.query<{ version: unknown; name: unknown; checksum: unknown; applied_at: unknown }>(`SELECT version, name, checksum, applied_at FROM ${quoteIdentifier(schema)}."schema_migrations" ORDER BY version`);
    const rows = result.rows.map((row) => ({
      version: typeof row.version === "number" ? row.version : Number(row.version),
      name: row.name as string,
      checksum: row.checksum as string,
      applied_at: typeof row.applied_at === "number" ? row.applied_at : Number(row.applied_at),
    }));
    if (rows.some((row) => !Number.isSafeInteger(row.version) || !Number.isSafeInteger(row.applied_at) || typeof row.name !== "string" || !SAFE_SHA256.test(row.checksum))) fail("restored PostgreSQL migration ledger is malformed");
    const ledger = { present: true, appliedCount: rows.length, appliedVersion: rows.length ? rows.at(-1)!.version : null, checksums: rows.map((row) => row.checksum), rows, pending: 0 };
    validateLedger(ledger);
    return ledger;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "42P01") {
      return { present: false, appliedCount: 0, appliedVersion: null, checksums: [], rows: [], pending: 0 };
    }
    if (error instanceof Error && error.message.startsWith("restore:")) throw error;
    fail("restored PostgreSQL migration ledger could not be read");
  }
}

async function detectLegacyPostgresManifest(
  client: PgRestoreClient,
  schema: string,
  kysely: Kysely<DatabaseSchema> | undefined,
): Promise<typeof schemaManifestV0 | typeof schemaManifestV1> {
  const ledger = await queryLedger(client, schema);
  if (ledger.present) fail("legacy restore requires an absent schema_migrations table");
  if (!kysely) {
    // Test clients may provide only a narrow query seam.  Infer only the
    // immutable v0/v1 table set here; validateDatabase still checks the exact
    // table list and all row contracts below.  Real restore also runs the
    // schema-scoped physical preflight.
    const tables = await client.query<{ table_name: unknown }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
      [schema],
    );
    const names = tables.rows.map((row) => row.table_name);
    const v1Names = ["file_operations", "idempotency", "projects", "sessions"];
    const v0Names = ["idempotency", "projects", "sessions"];
    if (stableSerialize(names) === stableSerialize(v1Names)) return schemaManifestV1;
    if (stableSerialize(names) === stableSerialize(v0Names)) return schemaManifestV0;
    fail("legacy restored PostgreSQL database does not match a known table schema");
  }
  for (const candidate of [schemaManifestV1, schemaManifestV0] as const) {
    try {
      const verdict = await assertSchemaCompatible(kysely, "PostgreSQL", POSTGRES_LOGICAL_TYPE, candidate);
      if (verdict !== "complete") continue;
      if (candidate === schemaManifestV0) {
        const outbox = await client.query<{ present: number }>(
          "SELECT 1 AS present FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'file_operations' AND table_type = 'BASE TABLE'",
          [schema],
        );
        if (outbox.rows.length !== 0) continue;
      }
      return candidate;
    } catch {
      // Try the other immutable legacy snapshot, then fail closed.
    }
  }
  fail("legacy restored PostgreSQL database does not match a known physical schema");
}

async function validateDatabase(
  client: PgRestoreClient,
  schema: string,
  manifest: PostgresBackupManifest,
  finalPath: string,
  verifyMigrations: PostgresRestoreOptions["verifyMigrations"],
  migrationContext: RestoreMigrationContext,
  physicalKysely?: Kysely<DatabaseSchema>,
): Promise<{
  migration: { version: number | null; pending: number; legacy: boolean };
  ledger: PostgresBackupManifest["migrationLedger"];
  schemaTableCount: number;
  projects: number;
  sessions: number;
  idempotencyRows: number;
  fileOperations: number;
  foreignKeyViolations: number;
  sessionRows: readonly { id: unknown; pi_session_file: unknown; capability_versions: unknown }[];
  sessionEntries: number;
}> {
  let physicalManifest = migrationContext.physicalManifest;
  let migration: { version: number | null; pending: number; legacy: boolean };
  if (migrationContext.legacy) {
    physicalManifest = await detectLegacyPostgresManifest(client, schema, physicalKysely);
    migration = { version: null, pending: 0, legacy: true };
  } else {
    const checked = verifyMigrations ? await verifyMigrations(client, schema) : fail("PostgreSQL restore requires a migration verification adapter");
    const expectedVersion = migrationContext.migrations.at(-1)!.version;
    if (checked.pending !== 0 || checked.version !== expectedVersion) fail("restored PostgreSQL database did not reach the authenticated migration head");
    migration = { version: checked.version, pending: checked.pending, legacy: false };
  }
  if (!physicalManifest) fail("restored PostgreSQL database has no authenticated physical schema");
  const ledger = await queryLedger(client, schema);
  if (stableSerialize(ledger.rows) !== stableSerialize(manifest.migrationLedger.rows) || ledger.appliedVersion !== manifest.migrationLedger.appliedVersion || ledger.appliedCount !== manifest.migrationLedger.appliedCount) fail("manifest migration ledger does not match the restored PostgreSQL database");
  const qschema = quoteIdentifier(schema);
  try {
    const schemaTables = await client.query<{ table_name: unknown }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
      [schema],
    );
    const tableNames = schemaTables.rows.map((row) => row.table_name);
    const expectedTableNames = [
      ...(migrationContext.legacy ? [] : ["schema_migrations"]),
      ...physicalManifest.tables.map((table) => table.name),
    ].sort();
    if (tableNames.some((name) => typeof name !== "string") || stableSerialize(tableNames) !== stableSerialize(expectedTableNames)) fail("restored PostgreSQL schema does not match the authenticated schema contract");
    const fileOperations = physicalManifest.tables.some((table) => table.name === "file_operations")
      ? (await client.query<Record<string, unknown>>(`SELECT id, operation_key, kind, relative_path, session_id, project_id, state, attempt_count, available_at, lease_until, lease_token, last_error, created_at, updated_at FROM ${qschema}."file_operations"`)).rows
      : [];
    validateRestoredFileOperations(fileOperations);
    const [projects, sessions, idempotency, fks] = await Promise.all([
      client.query<Record<string, unknown>>(`SELECT id, name, cwd, owner_key FROM ${qschema}."projects"`),
      client.query<{ id: unknown; pi_session_file: unknown; capability_versions: unknown }>(`SELECT id, pi_session_file, capability_versions FROM ${qschema}."sessions"`),
      client.query<Record<string, unknown>>(`SELECT session_id, request_id, result FROM ${qschema}."idempotency"`),
      client.query<{ total: number | string; invalid: number | string }>("SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT con.convalidated)::int AS invalid FROM pg_constraint con JOIN pg_namespace ns ON ns.oid = con.connamespace WHERE ns.nspname = $1 AND con.contype = 'f'", [schema]),
    ]);
    for (const row of projects.rows) if (![row.id, row.name, row.cwd, row.owner_key].every((value) => typeof value === "string")) fail("restored PostgreSQL project data is malformed");
    for (const row of sessions.rows) {
      if (typeof row.id !== "string") fail("restored PostgreSQL session data is malformed");
      // The source dump still contains source JSONL paths at this point; the
      // remap transaction below is the operation that binds them to finalPath.
      if (row.pi_session_file !== null && (typeof row.pi_session_file !== "string" || !path.isAbsolute(row.pi_session_file))) fail("restored PostgreSQL session path is malformed");
      if (row.capability_versions !== null) { try { JSON.parse(String(row.capability_versions)); } catch { fail("restored PostgreSQL capability_versions is invalid JSON"); } }
    }
    for (const row of idempotency.rows) {
      if (typeof row.session_id !== "string" || typeof row.request_id !== "string") fail("restored PostgreSQL idempotency key is malformed");
      try { JSON.parse(String(row.result)); } catch { fail("restored PostgreSQL idempotency result is invalid JSON"); }
    }
    const foreignKeyCount = Number(fks.rows[0]?.total ?? 0);
    const foreignKeyViolations = Number(fks.rows[0]?.invalid ?? 0);
    const expectedForeignKeys = physicalManifest.tables.reduce((total, table) => total + (table.foreignKeys?.length ?? 0), 0);
    if (!Number.isSafeInteger(foreignKeyCount) || foreignKeyCount < 0 || !Number.isSafeInteger(foreignKeyViolations) || foreignKeyViolations < 0) fail("restored PostgreSQL foreign-key catalog is malformed");
    if (foreignKeyCount !== expectedForeignKeys) fail("restored PostgreSQL schema foreign-key contract is invalid");
    if (foreignKeyViolations !== 0) fail("restored PostgreSQL schema contains unvalidated foreign keys");
    return { migration, ledger, schemaTableCount: tableNames.length, projects: projects.rows.length, sessions: sessions.rows.length, idempotencyRows: idempotency.rows.length, fileOperations: fileOperations.length, foreignKeyViolations, sessionRows: sessions.rows, sessionEntries: 0 };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("restore:")) throw error;
    fail("restored PostgreSQL data validation failed");
  }
}

function buildPostgresRestoreReport(
  records: ReadonlyMap<string, BackupFileRecord>,
  jsonlFiles: readonly BackupFileRecord[],
  sessionEntries: number,
  checked: { readonly migration: { readonly version: number | null; readonly pending: number; readonly legacy: boolean }; readonly schemaTableCount: number; readonly projects: number; readonly sessions: number; readonly idempotencyRows: number; readonly fileOperations: number; readonly foreignKeyViolations: number },
  database: string,
  schema: string,
  missing: number,
): PostgresRestoreReport {
  const schemaIdentity = pgIdentity(schema, "schema");
  return {
    status: "success",
    dialect: "PostgreSQL",
    format: "pi-agent-server.backup-manifest.v1",
    counts: {
      payloads: records.size,
      jsonlFiles: jsonlFiles.length,
      projects: checked.projects,
      sessions: checked.sessions,
      idempotencyRows: checked.idempotencyRows,
      fileOperations: checked.fileOperations,
      sessionEntries,
      sessionHeaders: jsonlFiles.length,
      missingSessionReferences: missing,
      foreignKeyViolations: checked.foreignKeyViolations,
    },
    migration: checked.migration,
    target: {
      databaseIdentity: pgIdentity(database, "database"),
      schemaIdentity,
      schemaSummary: {
        identity: schemaIdentity,
        tableCount: checked.schemaTableCount,
        migrationVersion: checked.migration.version,
        foreignKeyViolations: checked.foreignKeyViolations,
      },
    },
  };
}

async function remapDatabase(client: PgRestoreClient, schema: string, finalPath: string, manifest: PostgresBackupManifest, included: Set<string>, assembledRoot: string): Promise<number> {
  const missingKeys = new Set(manifest.missingSessionReferences.map((reference) => `${reference.sessionId}\u0000${reference.path}`));
  const consumed = new Set<string>();
  const qschema = quoteIdentifier(schema);
  let missing = 0;
  try {
    await client.query("BEGIN");
    const result = await client.query<{ id: unknown; pi_session_file: unknown }>(`SELECT id, pi_session_file FROM ${qschema}."sessions" WHERE pi_session_file IS NOT NULL`);
    for (const row of result.rows) {
      if (typeof row.id !== "string" || typeof row.pi_session_file !== "string") fail("restored PostgreSQL session reference is malformed");
      const relative = deriveRelativeSessionPath(row.pi_session_file);
      const key = `${row.id}\u0000${relative}`;
      const restoredFile = path.join(assembledRoot, relative);
      if (!within(assembledRoot, restoredFile) || !isJsonlRelative(relative)) fail("restored PostgreSQL session reference escapes target data directory");
      if (missingKeys.has(key)) {
        missing++;
        consumed.add(key);
      } else if (!included.has(`payload/${relative}.age`) || !existsSync(restoredFile)) {
        fail("restored PostgreSQL session reference has no matching JSONL payload");
      }
      await client.query(`UPDATE ${qschema}."sessions" SET pi_session_file = $1 WHERE id = $2`, [path.join(finalPath, relative), row.id]);
    }
    if (consumed.size !== missingKeys.size) fail("manifest missing session references do not match the restored PostgreSQL database exactly");
    await client.query("COMMIT");
    return missing;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Error && error.message.startsWith("restore:")) throw error;
    fail("restored PostgreSQL session remap failed");
  }
}

/** Offline PostgreSQL restore drill. The target database is supplied by a fixture/operator; this core never creates or drops it. */
export async function restorePostgresBackup(options: PostgresRestoreOptions): Promise<PostgresRestoreResult> {
  validateSafetyContract(options.safetyContract);
  const resolved = validateRestorePaths(options.paths);
  const targetParsed = parsePostgresConnectionUrl(options.targetDatabaseUrl);
  const packageLayout = validatePackage(resolved.input);
  const age = options.age ?? options.crypto ?? options.cryptoAdapter ?? restoreAgeAdapter;
  await age.ensureAvailable?.(resolved.identity);
  const manifestStaging = privateManifestStaging(path.dirname(resolved.target));
  let staging: string | undefined;
  let published = false;
  let targetCreated = false;
  let finalPath: string | undefined;
  let targetClient: PgRestoreClient | undefined = options.pgClient;
  let targetPool: ReturnType<typeof createPostgresPool> | undefined;
  let schemaPool: ReturnType<typeof createPostgresPool> | undefined;
  let schemaPoolClosed = false;
  try {
    const manifestPlain = path.join(manifestStaging, "manifest.json");
    if (hashFile(packageLayout.manifestCiphertext).sha256 !== packageLayout.manifestCiphertextSha256) fail("manifest ciphertext does not match COMPLETE");
    await decryptWithAdapter(age, packageLayout.manifestCiphertext, manifestPlain, resolved.identity);
    const manifest = validatePostgresManifest(JSON.parse(readFileSync(manifestPlain, "utf8")));
    // Select the authenticated historical prefix before payload staging.  The
    // restore path only verifies it; an older package is migrated later by the
    // explicit offline migration command.
    const migrationContext = selectRestoreMigrationContext(
      manifest.migrationLedger as MigrationLedgerSnapshot,
      options.verifyMigrations !== undefined,
    );
    const pgDumpMajor = parseClientMajor(manifest.postgres.pgDumpVersion);
    rmSync(manifestPlain, { force: true });
    if (manifest.postgres.schemaIdentity === pgIdentity("public", "schema")) fail("authenticated PostgreSQL source schema public is not allowed");
    const sourceRoots = [manifest.sourceRoots.dataDir, manifest.sourceRoots.agentDir].map((root, index) => canonicalPath(root, `manifest source root ${index}`));
    if (sourceRoots.some((source) => within(source, resolved.target) || within(resolved.target, source))) fail("target root overlaps an authenticated source root");

    if (!targetClient) {
      const created = clientFromUrl(options.targetDatabaseUrl);
      targetClient = created.client;
      targetPool = created.pool;
    }
    const target = await targetIdentity(targetClient);
    validateTargetPreflight(target, manifest);
    await assertEmptyTarget(targetClient, target.serverMajor);

    if (options.dryRun === true) return {
      dryRun: true,
      finalPath: null,
      report: { status: "success", dialect: "PostgreSQL", format: "pi-agent-server.backup-manifest.v1", counts: { payloads: manifest.files.length, jsonlFiles: manifest.files.filter((file) => file.kind === "jsonl").length, projects: 0, sessions: 0, idempotencyRows: 0, fileOperations: 0, sessionEntries: 0, sessionHeaders: 0, missingSessionReferences: manifest.missingSessionReferences.length, foreignKeyViolations: 0 }, migration: { version: manifest.migrationLedger.appliedVersion, pending: 0, legacy: migrationContext.legacy }, target: { databaseIdentity: pgIdentity(target.database, "database"), schemaIdentity: pgIdentity(target.schema, "schema"), schemaSummary: { identity: pgIdentity(target.schema, "schema"), tableCount: 0, migrationVersion: manifest.migrationLedger.appliedVersion, foreignKeyViolations: 0 } } },
    };

    const pgProcess = options.pgProcess ?? pgProcessAdapter;
    await age.ensureAvailable?.(resolved.identity);
    const targetParent = path.dirname(resolved.target);
    if (!existsSync(targetParent)) mkdirSync(targetParent, { recursive: true, mode: 0o700 });
    staging = mkdtempSync(path.join(targetParent, ".pi-agent-restore-staging-"));
    chmodSync(staging, 0o700);
    const decryptedRoot = path.join(staging, "decrypted");
    const assembledRoot = path.join(staging, "assembled");
    mkdirSync(decryptedRoot, { recursive: true, mode: 0o700 });
    mkdirSync(assembledRoot, { recursive: true, mode: 0o700 });
    finalPath = path.join(resolved.target, `${RESTORE_DIR_PREFIX}${randomUUID()}`);
    const records = new Map(manifest.files.map((record) => [record.path, record]));
    const payloadLayout = packageFiles(path.join(resolved.input, "payload"));
    const actualPayloadFiles = payloadLayout.files.map((file) => `payload/${file}`);
    if (actualPayloadFiles.length !== records.size || actualPayloadFiles.some((file) => !records.has(file))) fail("backup payload set does not exactly match the manifest");
    const expectedDirectories = new Set<string>();
    for (const record of records.values()) {
      const parts = record.path.slice("payload/".length).split("/").slice(0, -1);
      for (let index = 1; index <= parts.length; index++) expectedDirectories.add(parts.slice(0, index).join("/"));
    }
    if (payloadLayout.directories.some((directory) => !expectedDirectories.has(directory))) fail("backup contains an unexpected PostgreSQL payload directory");
    for (const record of records.values()) {
      const ciphertext = path.join(resolved.input, record.path);
      const encrypted = hashFile(ciphertext);
      if (encrypted.size !== record.encryptedSize || encrypted.sha256 !== record.encryptedSha256) fail("encrypted PostgreSQL payload hash or size mismatch");
      const plaintext = path.join(decryptedRoot, record.path.slice("payload/".length, -4));
      mkdirSync(path.dirname(plaintext), { recursive: true, mode: 0o700 });
      await decryptWithAdapter(age, ciphertext, plaintext, resolved.identity);
      const actual = hashFile(plaintext);
      if (actual.size !== record.size || actual.sha256 !== record.sha256) fail("decrypted PostgreSQL payload hash or size mismatch");
      if (record.kind === "jsonl" || record.kind === "config") {
        const destination = path.join(assembledRoot, record.path.slice("payload/".length, -4));
        mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        copyFileSync(plaintext, destination);
        chmodSync(destination, 0o600);
      }
    }

    const dump = path.join(decryptedRoot, "database.pg_dump");
    if (!existsSync(dump)) fail("backup has no PostgreSQL dump");
    const jsonlFiles = manifest.files.filter((file) => file.kind === "jsonl");
    const validationRoot = path.join(staging, ".session-validation");
    mkdirSync(validationRoot, { recursive: true, mode: 0o700 });
    let sessionEntries = 0;
    for (const record of jsonlFiles) {
      const file = path.join(assembledRoot, record.path.slice("payload/".length, -4));
      sessionEntries += parseJsonl(file);
      const checked = validateWithSessionManager(file, validationRoot);
      if (!checked.header) fail("PostgreSQL backup JSONL has no Pi session header");
    }

    const username = targetParsed.username ?? target.user;
    const pgRestoreBinary = options.pgRestoreBinary ?? "pg_restore";
    const diagnosticSecrets = [targetParsed.password, process.env.PGPASSWORD, username].filter((value): value is string => Boolean(value));
    const pgRestoreVersion = await withPgEnv(targetParsed, target.database, username, async (env) =>
      verifyBinary(pgProcess, "pg_restore", pgRestoreBinary, env, diagnosticSecrets));
    const pgRestoreMajor = parseClientMajor(pgRestoreVersion);
    assertPostgresClientServerMajor("pg_restore", pgRestoreMajor, target.serverMajor);
    assertPostgresToolMajorMatch(pgDumpMajor, pgRestoreMajor);
    await withPgEnv(targetParsed, target.database, username, async (env) => {
      await runPgProcess(pgProcess, "pg_restore", pgRestoreBinary, [
        "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", `--dbname=${target.database}`,
      ], env, { stdinPath: dump }, diagnosticSecrets);
    });
    // A version check is part of the authenticated drill. pg_restore is not
    // written to the manifest because it is a restore-host property, but the
    // output must be parseable and never be hidden behind a shell.
    if (!pgRestoreVersion) fail("pg_restore version could not be verified");
    const restoredSchema = await locateAuthenticatedSchema(targetClient, manifest.postgres.schemaIdentity);
    await assertRestoredSchemaIsolation(targetClient, restoredSchema);
    if (targetPool) {
      // pg_restore uses the operator's original URL (with no search_path).
      // Only the verifier gets a derived connection scoped to the authenticated
      // schema, so migration/schema checks do not depend on URL preconfiguration.
      schemaPool = createPostgresPool(schemaScopedConnectionUrl(options.targetDatabaseUrl, restoredSchema));
      const kysely = createPostgresKysely(schemaPool);
      try {
        const checked = await validateDatabase(targetClient, restoredSchema, manifest, finalPath, options.verifyMigrations ?? (async () => {
          if (migrationContext.legacy) return { version: null, pending: 0 };
          const result = await runPostgresMigrations(kysely, { mode: "verify", migrations: migrationContext.migrations });
          return { version: result.appliedVersion, pending: result.pending.length };
        }), migrationContext, kysely);
        const included = new Set(records.keys());
        const missing = await remapDatabase(targetClient, restoredSchema, finalPath, manifest, included, assembledRoot);
        const report = buildPostgresRestoreReport(records, jsonlFiles, sessionEntries, checked, target.database, restoredSchema, missing);
        rmSync(validationRoot, { recursive: true, force: true });
        if (existsSync(resolved.target)) safeDirectory(resolved.target, "target root");
        else { mkdirSync(resolved.target, { recursive: true, mode: 0o700 }); chmodSync(resolved.target, 0o700); targetCreated = true; }
        if (existsSync(finalPath)) fail("restore target already exists");
        renameSync(assembledRoot, finalPath);
        published = true;
        return { dryRun: false, finalPath, report };
      } finally { await kysely.destroy(); schemaPoolClosed = true; }
    }
    if (!options.verifyMigrations && !migrationContext.legacy) fail("PostgreSQL restore requires a migration verification adapter");
    const checked = await validateDatabase(targetClient, restoredSchema, manifest, finalPath, options.verifyMigrations, migrationContext);
    const missing = await remapDatabase(targetClient, restoredSchema, finalPath, manifest, new Set(records.keys()), assembledRoot);
    const report = buildPostgresRestoreReport(records, jsonlFiles, sessionEntries, checked, target.database, restoredSchema, missing);
    rmSync(validationRoot, { recursive: true, force: true });
    if (existsSync(resolved.target)) safeDirectory(resolved.target, "target root");
    else { mkdirSync(resolved.target, { recursive: true, mode: 0o700 }); chmodSync(resolved.target, 0o700); targetCreated = true; }
    if (existsSync(finalPath)) fail("restore target already exists");
    renameSync(assembledRoot, finalPath);
    published = true;
    return { dryRun: false, finalPath, report };
  } finally {
    if (!published && finalPath) rmSync(finalPath, { recursive: true, force: true });
    if (targetCreated && finalPath && existsSync(resolved.target) && readdirSync(resolved.target).length === 0) rmSync(resolved.target, { recursive: true, force: true });
    if (staging) rmSync(staging, { recursive: true, force: true });
    rmSync(manifestStaging, { recursive: true, force: true });
    if (schemaPool && !schemaPoolClosed) await schemaPool.end();
    if (targetPool) await targetPool.end();
  }
}
