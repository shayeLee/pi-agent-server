import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Kysely, SqliteDialect } from "kysely";
import { runSqliteMigrations } from "../storage/migration-engine.js";
import { assertSchemaCompatible } from "../storage/schema-compatibility.js";
import { NodeSqliteAdapter } from "../storage/node-sqlite-adapter.js";
import { schemaManifestV0, schemaManifestV1, SQLITE_PHYSICAL_TYPES, migrationPrefixForLedger, type MigrationDefinition, type MigrationLedgerSnapshot } from "../storage/migration-manifest.js";
import { stableSerialize } from "../storage/migration-manifest.js";
import type { DatabaseSchema } from "../storage/db-schema.js";
import { validateRestoredFileOperations } from "./restore-validation.js";
import type { BackupFileRecord, BackupManifest, BackupSourceRoots } from "./backup-core.js";

const AGE_TIMEOUT_MS = 60_000;
const READ_CHUNK_SIZE = 64 * 1024;
const RESTORE_DIR_PREFIX = "restore-";

type RestoreFile = BackupFileRecord & { readonly path: string };

export interface RestorePaths {
  readonly inputBackup: string;
  readonly targetRoot: string;
  readonly ageIdentityFile: string;
}

/** Injectable decryption boundary used by all restore-core tests. */
export interface RestoreAgeAdapter {
  readonly ensureAvailable?: (identityFile: string) => Promise<void> | void;
  readonly decryptFile?: (inputPath: string, outputPath: string, identityFile: string) => Promise<void>;
  /** Small in-memory adapter hook; production uses decryptFile. */
  readonly decrypt?: (ciphertext: Buffer, identityFile: string) => Promise<Buffer> | Buffer;
}

export type RestoreCryptoAdapter = RestoreAgeAdapter;

export const restoreAgeAdapter: RestoreAgeAdapter = {
  async ensureAvailable(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("age", ["--version"], { shell: false, stdio: ["ignore", "ignore", "pipe"] });
      child.stderr.resume();
      child.once("error", () => reject(new Error("restore: age binary is unavailable")));
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error("restore: age binary is unavailable")));
    });
  },
  async decryptFile(input, output, identity): Promise<void> { await decryptAgeBinary(input, output, identity); },
};

export interface RestoreOptions {
  readonly paths: RestorePaths;
  readonly dryRun?: boolean;
  readonly age?: RestoreAgeAdapter;
  readonly crypto?: RestoreAgeAdapter;
  readonly cryptoAdapter?: RestoreAgeAdapter;
}

export interface RestoreDrillReport {
  readonly status: "success";
  readonly dialect: "SQLite";
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
  readonly migration: {
    readonly version: number | null;
    readonly pending: number;
    /** True when the package explicitly carries no migration ledger. */
    readonly legacy: boolean;
  };
}

export interface RestoreResult {
  readonly dryRun: boolean;
  /** The unique published drill directory. Null for dry-run. */
  readonly finalPath: string | null;
  readonly report: RestoreDrillReport;
}

function fail(message: string): never {
  throw new Error(`restore: ${message}`);
}

function safePath(input: string, label: string): string {
  if (!path.isAbsolute(input)) fail(`${label} must be an absolute path`);
  return input;
}

function checkAncestors(input: string, label: string): string {
  const absolute = safePath(input, label);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const entry = lstatSync(current);
      const trustedSystemAlias = process.platform === "darwin"
        ? (current === "/var" || current === "/tmp")
        : current === "/tmp";
      if (entry.isSymbolicLink() && !trustedSystemAlias) fail(`${label} contains a symbolic-link ancestor`);
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

function createPrivateManifestStaging(targetParent: string): string {
  // Normally os.tmpdir() is independent of an application target. Keep a
  // fallback list so even a target directly under the system temp directory
  // does not get its manifest staging beside that target.
  const candidates = [tmpdir(), "/var/tmp", process.cwd()];
  for (const candidate of candidates) {
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
  fail("could not create a private manifest staging directory outside the target parent");
}

export function safeRegular(file: string, label: string): void {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail(`${label} is not a safe regular file`);
  if ((stat.mode & 0o022) !== 0) fail(`${label} has unsafe permissions`);
}

export function safeDirectory(directory: string, label: string): void {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} is not a safe directory`);
  if ((stat.mode & 0o022) !== 0) fail(`${label} has unsafe permissions`);
}

export function hashFile(file: string): { readonly size: number; readonly sha256: string } {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) fail("staged payload is not a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_SIZE);
    let size = 0;
    while (size < before.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - size), size);
      if (count === 0) fail("staged payload was truncated");
      hash.update(buffer.subarray(0, count));
      size += count;
    }
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || size !== before.size) fail("staged payload changed while hashing");
    return { size, sha256: hash.digest("hex") };
  } finally { closeSync(fd); }
}

/**
 * Decrypts with the real age binary. The identity path is passed as an argv
 * item, never through a shell. `spawnImpl` is injectable and `timeoutMs`
 * overridable so tests can replay real child lifecycle orderings (a `close`
 * or `error` event that trails the timeout `kill` — the delayed-close
 * contract) with a bounded budget.
 *
 * Failure contract (P1): a spawn error (the process never started) settles at
 * once — there is nothing to kill or reap. A runtime failure (non-zero exit)
 * is already confirmed by its own `close`. A KILL error (the safety budget)
 * defers BOTH the cleanup (removal of the partial decrypted output) and the
 * rejection until the CONFIRMED child `close`: only then is the killed child
 * known to be reaped, and no result is ever handed back (and no partial
 * output removed) while the child may still be running. A child that cannot
 * be terminated therefore never settles early — the promise stays pending
 * (fail closed).
 */
export async function decryptAgeBinary(input: string, output: string, identity: string, spawnImpl: typeof spawn = spawn, timeoutMs: number = AGE_TIMEOUT_MS): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl("age", ["--decrypt", "--identity", identity, "--output", output, input], {
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch {
      rmSync(output, { force: true });
      reject(new Error("restore: age decryption failed"));
      return;
    }
    let settled = false;
    // Confirmed-close flags: the close/error handlers set these BEFORE the
    // deferred teardown runs, so it never waits on a close event that already
    // fired (or on a child that never spawned).
    let childClosed = false;
    let spawnFailed = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch { /* already gone */ }
      const teardown = (): void => {
        rmSync(output, { force: true });
        reject(error);
      };
      // Spawn error (never spawned) or already-confirmed close: no wait is
      // needed. Any other failure path (timeout kill) must wait for the
      // confirmed 'close' before the cleanup + rejection run.
      if (spawnFailed || childClosed) {
        teardown();
        return;
      }
      child.once("close", teardown);
    };
    const timer = setTimeout(() => {
      fail(new Error(`restore: age decryption exceeded the ${timeoutMs}ms safety budget`));
    }, timeoutMs);
    child.stderr?.resume();
    child.once("error", () => {
      spawnFailed = true;
      fail(new Error("restore: age decryption failed"));
    });
    child.once("close", (code) => {
      childClosed = true;
      if (code !== 0) {
        fail(new Error("restore: age decryption failed"));
        return;
      }
      try { safeRegular(output, "decrypted file"); }
      catch { fail(new Error("restore: age produced an unsafe output")); return; }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function decryptWithAdapter(age: RestoreAgeAdapter, input: string, output: string, identity: string): Promise<void> {
  if (age.decryptFile) {
    await age.decryptFile(input, output, identity);
  } else if (age.decrypt) {
    const plaintext = Buffer.from(await age.decrypt(readFileSync(input), identity));
    if (plaintext.length === 0) fail("decryption produced an empty file");
    writeFileSync(output, plaintext, { mode: 0o600, flag: "wx" });
  } else {
    fail("restore crypto adapter is incomplete");
  }
  chmodSync(output, 0o600);
  safeRegular(output, "decrypted file");
}

function sourceRootsSha256(sourceRoots: BackupSourceRoots): string {
  return createHash("sha256").update(stableSerialize(sourceRoots), "utf8").digest("hex");
}

export function relativePayloadPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") || path.isAbsolute(value)) fail("manifest contains an unsafe payload path");
  const normalized = value.split("/");
  if (normalized.some((part) => part === "" || part === "." || part === "..")) fail("manifest contains path traversal");
  return normalized.join("/");
}

export function isJsonlRelative(value: string): boolean {
  const parts = value.split("/");
  return value.endsWith(".jsonl") && ((parts[0] === "sessions" && parts.length === 3) ||
    (parts[0] === "projects" && parts.length === 5 && parts[2] === "sessions"));
}

function validateManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== "object") fail("manifest is not an object");
  const manifest = value as {
    format?: unknown; kind?: unknown; dialect?: unknown; encryption?: unknown;
    sourceRoots?: unknown; sourceRootsSha256?: unknown; sourceRootsHash?: unknown;
    credentials?: { included?: unknown; policy?: unknown };
    createdAt?: unknown;
    timeWindow?: { startedAt?: unknown; finishedAt?: unknown };
    migrationLedger?: { present?: unknown; appliedCount?: unknown; appliedVersion?: unknown; checksums?: unknown[]; rows?: unknown[]; pending?: unknown };
    files?: unknown[]; missingSessionReferences?: unknown[]; excludedFiles?: unknown[];
  };
  if (manifest.format !== "pi-agent-server.backup-manifest.v1") fail("unsupported backup format");
  if (manifest.dialect === "PostgreSQL" || manifest.kind === "postgresql-online") fail("PostgreSQL backup requires an explicit temporary target PG connection");
  if ((manifest.kind !== "sqlite-online" && manifest.kind !== "pre-migration" && manifest.kind !== "pre-reset") || manifest.dialect !== "SQLite") fail("unsupported backup format or dialect");
  if (!manifest.credentials || manifest.credentials.included !== false || manifest.credentials.policy !== "whitelist-excludes-credentials") fail("manifest credential policy is invalid");
  const sourceRoots = manifest.sourceRoots as { dataDir?: unknown; agentDir?: unknown; dbPath?: unknown } | undefined;
  if (!sourceRoots || typeof sourceRoots.dataDir !== "string" || !path.isAbsolute(sourceRoots.dataDir) ||
    typeof sourceRoots.agentDir !== "string" || !path.isAbsolute(sourceRoots.agentDir) ||
    typeof sourceRoots.dbPath !== "string" || !path.isAbsolute(sourceRoots.dbPath)) fail("manifest must include explicit authenticated source roots");
  if (typeof manifest.sourceRootsSha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.sourceRootsSha256) ||
    typeof manifest.sourceRootsHash !== "string" || manifest.sourceRootsHash !== manifest.sourceRootsSha256 ||
    sourceRootsSha256(sourceRoots as BackupSourceRoots) !== manifest.sourceRootsSha256) fail("manifest source roots hash is invalid");
  if (typeof (manifest as { createdAt?: unknown }).createdAt !== "string" || !manifest.timeWindow ||
    typeof manifest.timeWindow.startedAt !== "string" || typeof manifest.timeWindow.finishedAt !== "string" ||
    !manifest.migrationLedger || typeof manifest.migrationLedger.present !== "boolean" ||
    !Number.isSafeInteger(manifest.migrationLedger.appliedCount) ||
    !(manifest.migrationLedger.appliedVersion === null || Number.isSafeInteger(manifest.migrationLedger.appliedVersion)) ||
    !Array.isArray(manifest.migrationLedger.checksums) || manifest.migrationLedger.checksums.some((checksum) => typeof checksum !== "string") ||
    !Array.isArray(manifest.migrationLedger.rows) || manifest.migrationLedger.pending !== 0) fail("manifest metadata is invalid");
  const ledgerRows = manifest.migrationLedger.rows as Array<Record<string, unknown>>;
  const ledgerChecksums = manifest.migrationLedger.checksums as string[];
  if (ledgerRows.length !== manifest.migrationLedger.appliedCount || ledgerRows.length !== ledgerChecksums.length ||
    manifest.migrationLedger.present !== (ledgerRows.length > 0) ||
    manifest.migrationLedger.appliedVersion !== (ledgerRows.length === 0 ? null : ledgerRows.at(-1)!.version) ||
    ledgerRows.some((row, index) =>
      !Number.isSafeInteger(row.version) || row.version !== index || typeof row.name !== "string" || !/^[0-9a-f]{64}$/.test(String(row.checksum)) ||
      row.checksum !== ledgerChecksums[index] || !Number.isSafeInteger(row.applied_at) || Number(row.applied_at) < 0)) fail("manifest migration ledger is invalid");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail("manifest payload list is invalid");
  {
    const encryption = manifest.encryption as { format?: unknown; recipients?: unknown } | undefined;
    if (encryption?.format !== "age-v1" || !Array.isArray(encryption.recipients) || encryption.recipients.length === 0 ||
      encryption.recipients.some((recipient) => typeof recipient !== "string" || !/^age1[0-9a-z]+$/.test(recipient))) fail("manifest age recipient metadata is invalid");
  }

  const seen = new Set<string>();
  for (const item of manifest.files) {
    if (!item || typeof item !== "object") fail("manifest contains an invalid file record");
    const record = item as BackupFileRecord;
    const relative = relativePayloadPath(record.path);
    if (!relative.startsWith("payload/") || seen.has(relative)) fail("manifest contains a duplicate or non-payload path");
    seen.add(relative);
    const encryptedSize = record.encryptedSize;
    const encryptedSha256 = record.encryptedSha256;
    if (!(record.kind === "sqlite-snapshot" || record.kind === "jsonl" || record.kind === "config") ||
      !Number.isSafeInteger(record.size) || record.size < 0 || typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256) ||
      typeof encryptedSize !== "number" || !Number.isSafeInteger(encryptedSize) || encryptedSize <= 0 || typeof encryptedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(encryptedSha256)) fail("manifest contains an invalid file hash or size");
    const expectedKind = relative === "payload/database.sqlite.age" ? "sqlite-snapshot" :
      relative.endsWith(".jsonl.age") ? "jsonl" : "config";
    if (record.kind !== expectedKind || (expectedKind === "sqlite-snapshot" && relative !== "payload/database.sqlite.age") ||
      (expectedKind === "jsonl" && !isJsonlRelative(relative.slice("payload/".length, -4))) ||
      (expectedKind === "config" && relative !== "payload/.pi-agent/models.json.age" && relative !== "payload/agentDir/models.json.age")) fail("manifest contains a path outside the payload whitelist");
  }
  const missing = manifest.missingSessionReferences;
  if (!Array.isArray(missing)) fail("manifest missing-reference metadata is invalid");
  const missingKeys = new Set<string>();
  const missingPaths = new Set<string>();
  for (const value of missing) {
    if (!value || typeof value !== "object") fail("manifest missing-reference metadata is invalid");
    const reference = value as Record<string, unknown>;
    if (typeof reference.sessionId !== "string" || reference.sessionId.length === 0 || reference.status !== "missing" || typeof reference.path !== "string") fail("manifest missing-reference metadata is invalid");
    const relative = relativePayloadPath(reference.path);
    const key = `${reference.sessionId}\u0000${relative}`;
    if (!isJsonlRelative(relative) || missingKeys.has(key) || missingPaths.has(relative) || seen.has(`payload/${relative}.age`)) fail("manifest missing-reference metadata conflicts with payloads");
    missingKeys.add(key); missingPaths.add(relative);
  }
  const excluded = manifest.excludedFiles;
  if (!Array.isArray(excluded)) fail("manifest excluded-file metadata is invalid");
  for (const value of excluded) {
    if (!value || typeof value !== "object") fail("manifest excluded-file metadata is invalid");
    const entry = value as Record<string, unknown>;
    if (typeof entry.path !== "string" || entry.reason !== "auth-file" || entry.path.includes("..") || path.isAbsolute(entry.path)) fail("manifest excluded-file metadata is invalid");
  }
  return manifest as unknown as BackupManifest;
}

export function packageFiles(root: string): { files: string[]; directories: string[] } {
  const result: string[] = [];
  const directories: string[] = [];
  const walk = (directory: string, relative: string): void => {
    if (relative) directories.push(relative);
    safeDirectory(directory, "backup directory");
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(directory, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail("backup contains a symbolic link");
      if (entry.isDirectory()) walk(child, childRelative);
      else if (entry.isFile()) { safeRegular(child, "backup file"); result.push(childRelative); }
      else fail("backup contains a special file");
    }
  };
  walk(root, "");
  return { files: result, directories };
}

function validatePaths(paths: RestorePaths): { input: string; target: string; identity: string } {
  const input = canonicalPath(safePath(paths.inputBackup, "input backup"), "input backup");
  const target = canonicalPath(safePath(paths.targetRoot, "target root"), "target root");
  const identity = canonicalPath(safePath(paths.ageIdentityFile, "age identity file"), "age identity file");
  if (path.resolve(target) === path.parse(target).root) fail("target root must not be the filesystem root");
  safeDirectory(input, "input backup");
  if (existsSync(paths.targetRoot)) safeDirectory(paths.targetRoot, "target root");
  safeRegular(paths.ageIdentityFile, "age identity file");
  const identityStat = lstatSync(paths.ageIdentityFile);
  if ((identityStat.mode & 0o077) !== 0) fail("age identity file must be owner-only (0600 or 0400)");
  if (within(input, target) || within(target, input) || within(input, identity) || within(identity, input) || within(target, identity) || within(identity, target)) fail("input, target, and identity paths overlap");
  return { input, target, identity };
}

export function validatePackage(input: string): { manifestCiphertext: string; manifestCiphertextSha256: string } {
  const layout = packageFiles(input);
  const files = layout.files;
  const expectedTop = new Set(["COMPLETE", "manifest.json.age"]);
  if (!files.includes("COMPLETE") || !files.includes("manifest.json.age") || !files.every((file) => file === "COMPLETE" || file === "manifest.json.age" || file.startsWith("payload/"))) fail("backup is not a complete WP3A package");
  if (files.some((file) => file === "COMPLETE" || file === "manifest.json.age" ? false : !file.startsWith("payload/"))) fail("backup contains an unexpected file");
  const complete = statSync(path.join(input, "COMPLETE"));
  const completeText = readFileSync(path.join(input, "COMPLETE"), "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(completeText)) fail("COMPLETE marker is invalid or not bound to the encrypted manifest");
  // The set is used to make the intent explicit and to reject future top-level files.
  if (files.filter((file) => !file.startsWith("payload/")).some((file) => !expectedTop.has(file))) fail("backup contains an unexpected top-level file");
  if (layout.directories.some((directory) => directory !== "payload" && !directory.startsWith("payload/"))) fail("backup contains an unexpected directory");
  return { manifestCiphertext: path.join(input, "manifest.json.age"), manifestCiphertextSha256: completeText };
}

export function parseJsonl(file: string): number {
  let bytes: Buffer;
  try { bytes = readFileSync(file); } catch { fail("staged file could not be read"); }
  const text = bytes.toString("utf8");
  if (text.length === 0 || text.includes("\uFFFD")) fail("JSONL is not valid UTF-8");
  const records: Array<Record<string, unknown>> = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (index === text.split("\n").length - 1 && line === "") continue;
    if (line.trim() === "") fail("JSONL contains a blank line");
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { fail("JSONL contains invalid JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("JSONL record is not an object");
    records.push(parsed as Record<string, unknown>);
  }
  if (records.length === 0 || records[0]!.type !== "session") fail("JSONL must begin with one session header");
  if (records.filter((record) => record.type === "session").length !== 1) fail("JSONL must contain exactly one session header");
  const ids = new Set<string>();
  const parents = new Map<string, string | null>();
  for (const [index, record] of records.entries()) {
    if (typeof record.id !== "string" || record.id.length === 0 || ids.has(record.id)) fail("JSONL record ids must be unique");
    ids.add(record.id);
    if (index === 0) continue;
    if (!(record.parentId === null || typeof record.parentId === "string")) fail("JSONL parentId is malformed");
    if (record.parentId === record.id) fail("JSONL record cannot be its own parent");
    parents.set(record.id, record.parentId as string | null);
  }
  for (const parent of parents.values()) if (parent !== null && !ids.has(parent)) fail("JSONL parentId does not exist");
  for (const id of parents.keys()) {
    const seen = new Set<string>(); let current: string | null | undefined = id;
    while (current !== null && current !== undefined) {
      if (seen.has(current)) fail("JSONL parent graph contains a cycle");
      seen.add(current); current = parents.get(current);
    }
  }
  return records.length;
}

export function deriveRelativeSessionPath(source: string): string {
  if (!path.isAbsolute(source)) fail("sessions.pi_session_file is not absolute");
  const parts = source.split(path.sep).filter(Boolean);
  const projects = parts.lastIndexOf("projects");
  if (projects >= 0 && parts.length === projects + 5 && parts[projects + 2] === "sessions" && parts.at(-1)?.endsWith(".jsonl")) return parts.slice(projects).join("/");
  const sessions = parts.lastIndexOf("sessions");
  if (sessions >= 0 && parts.length === sessions + 3 && parts.at(-1)?.endsWith(".jsonl")) return parts.slice(sessions).join("/");
  fail("sessions.pi_session_file is outside the restore data layout");
}

type RestoreMigrationContext = {
  readonly legacy: boolean;
  readonly migrations: readonly MigrationDefinition[];
  readonly physicalManifest: typeof schemaManifestV0 | typeof schemaManifestV1 | null;
};

/** Select the authenticated history before any restored data is trusted. */
function selectRestoreMigrationContext(ledger: MigrationLedgerSnapshot): RestoreMigrationContext {
  if (!ledger.present) {
    // A missing ledger is not silently treated as current.  It is an explicit
    // legacy branch and is physically checked against a known released schema
    // below; it is never migrated by restore.
    return { legacy: true, migrations: [], physicalManifest: null };
  }
  try {
    const migrations = migrationPrefixForLedger(ledger);
    const physicalManifest = migrations.at(-1)?.manifest;
    if (!physicalManifest) fail("authenticated migration history is empty");
    return { legacy: false, migrations, physicalManifest: physicalManifest as typeof schemaManifestV0 | typeof schemaManifestV1 };
  } catch (error) {
    fail(error instanceof Error ? error.message.replace(/^schema migration ledger:\s*/, "") : "authenticated migration history is invalid");
  }
}

/**
 * Legacy RC databases had no ledger.  They are accepted only when their
 * complete physical schema is exactly one of the immutable v0/v1 manifests;
 * the result remains explicitly legacy and no migration is applied.
 */
async function detectLegacySqliteManifest(dbPath: string): Promise<typeof schemaManifestV0 | typeof schemaManifestV1> {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000, enableForeignKeyConstraints: true });
  const kysely = new Kysely<DatabaseSchema>({ dialect: new SqliteDialect({ database: new NodeSqliteAdapter(db, false) }) });
  try {
    if (db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()) {
      fail("legacy restore requires an absent schema_migrations table");
    }
    for (const manifest of [schemaManifestV1, schemaManifestV0] as const) {
      try {
        const verdict = await assertSchemaCompatible(kysely, "SQLite", SQLITE_PHYSICAL_TYPES, manifest);
        if (verdict !== "complete") continue;
        if (manifest === schemaManifestV0 && db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'file_operations'").get()) continue;
        return manifest;
      } catch {
        // Try the other immutable legacy snapshot; malformed/partial schemas
        // fail closed after both candidates are exhausted.
      }
    }
    fail("legacy restored database does not match a known physical schema");
  } finally {
    await kysely.destroy();
    db.close();
  }
}

function remapDatabase(dbPath: string, finalPath: string, manifest: BackupManifest, included: Set<string>): { missing: number } {
  const db = new DatabaseSync(dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
  try {
    const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='sessions'").get();
    if (!table) fail("restored database has no sessions table");
    const missingKeys = new Set(manifest.missingSessionReferences.map((reference) => `${reference.sessionId}\u0000${reference.path}`));
    const consumedMissing = new Set<string>();
    const rows = db.prepare("SELECT id, pi_session_file FROM sessions WHERE pi_session_file IS NOT NULL").all() as Array<{ id: unknown; pi_session_file: unknown }>;
    let missing = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (typeof row.id !== "string" || typeof row.pi_session_file !== "string") fail("restored session reference is malformed");
        const relative = deriveRelativeSessionPath(row.pi_session_file);
        const payloadRelative = `payload/${relative}.age`;
        const restored = path.join(finalPath, relative);
        if (!within(finalPath, restored) || !isJsonlRelative(relative)) fail("restored session reference escapes target data directory");
        const missingKey = `${row.id}\u0000${relative}`;
        if (missingKeys.has(missingKey)) {
          missing++;
          consumedMissing.add(missingKey);
        } else if (!included.has(payloadRelative) || !existsSync(path.join(path.dirname(dbPath), relative))) {
          fail("restored session reference has no matching manifest payload");
        }
        db.prepare("UPDATE sessions SET pi_session_file = ? WHERE id = ?").run(restored, row.id);
      }
      if (consumedMissing.size !== missingKeys.size) fail("manifest missing session references do not match the database exactly");
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch { /* preserve validation error */ } throw error; }
    return { missing };
  } finally { db.close(); }
}

async function validateDatabase(
  dbPath: string,
  finalPath: string,
  migrationContext: RestoreMigrationContext,
): Promise<{
  version: number | null;
  pending: number;
  legacy: boolean;
  ledgerCount: number;
  ledgerChecksums: string[];
  ledgerRows: Array<{ version: number; name: string; checksum: string; applied_at: number }>;
  projects: number;
  sessions: number;
  idempotencyRows: number;
  fileOperations: number;
  foreignKeyViolations: number;
}> {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000, enableForeignKeyConstraints: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    if (integrity?.integrity_check !== "ok") fail("restored database integrity check failed");

    let physicalManifest = migrationContext.physicalManifest;
    let migration: { appliedVersion: number | null; pending: readonly unknown[] };
    if (migrationContext.legacy) {
      physicalManifest = await detectLegacySqliteManifest(dbPath);
      migration = { appliedVersion: null, pending: [] };
    } else {
      // Verify exactly the authenticated historical prefix.  In particular,
      // a v0 package must not be rejected merely because this code knows v1;
      // restore remains read-only and never applies the missing suffix.
      const checked = await runSqliteMigrations(db, { mode: "verify", migrations: migrationContext.migrations });
      migration = { appliedVersion: checked.appliedVersion, pending: checked.pending };
      if (migration.pending.length !== 0 || migration.appliedVersion !== migrationContext.migrations.at(-1)!.version) {
        fail("restored database did not reach the authenticated migration head");
      }
    }
    if (!physicalManifest) fail("restored database has no authenticated physical schema");
    if (physicalManifest === schemaManifestV0 && db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'file_operations'").get()) {
      fail("restored database contains file_operations but the authenticated migration history is v0");
    }

    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length !== 0) fail("restored database has foreign-key violations");
    const ledgerRows = migrationContext.legacy
      ? []
      : db.prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version").all() as Array<{ version: unknown; name: unknown; checksum: unknown; applied_at: unknown }>;
    if (ledgerRows.some((row) => !Number.isSafeInteger(row.version) || typeof row.name !== "string" || typeof row.checksum !== "string" || !Number.isSafeInteger(row.applied_at))) fail("restored migration ledger is malformed");
    const normalizedLedger = ledgerRows.map((row) => ({ version: Number(row.version), name: row.name as string, checksum: row.checksum as string, applied_at: Number(row.applied_at) }));
    const projects = db.prepare("SELECT id, name, cwd, owner_key FROM projects").all() as Array<Record<string, unknown>>;
    const sessions = db.prepare("SELECT id, owner_key, project_id, title, pi_session_file, capability_versions FROM sessions").all() as Array<Record<string, unknown>>;
    const idempotency = db.prepare("SELECT session_id, request_id, result FROM idempotency").all() as Array<Record<string, unknown>>;
    const fileOperations = physicalManifest.tables.some((table) => table.name === "file_operations")
      ? db.prepare("SELECT id, operation_key, kind, relative_path, session_id, project_id, state, attempt_count, available_at, lease_until, lease_token, last_error, created_at, updated_at FROM file_operations").all() as Array<Record<string, unknown>>
      : [];
    validateRestoredFileOperations(fileOperations);
    for (const row of projects) if (![row.id, row.name, row.cwd, row.owner_key].every((value) => typeof value === "string")) fail("restored project data is malformed");
    for (const row of sessions) {
      if (![row.id, row.owner_key, row.project_id, row.title].every((value) => typeof value === "string")) fail("restored session data is malformed");
      if (row.pi_session_file !== null && (typeof row.pi_session_file !== "string" || !path.isAbsolute(row.pi_session_file) || !within(finalPath, row.pi_session_file))) fail("restored session path was not safely remapped");
      if (row.capability_versions !== null) { try { JSON.parse(String(row.capability_versions)); } catch { fail("restored capability_versions is invalid JSON"); } }
    }
    for (const row of idempotency) {
      if (typeof row.session_id !== "string" || typeof row.request_id !== "string") fail("restored idempotency key is malformed");
      try { JSON.parse(String(row.result)); } catch { fail("restored idempotency result is invalid JSON"); }
    }
    return {
      version: migration.appliedVersion,
      pending: migration.pending.length,
      legacy: migrationContext.legacy,
      ledgerCount: normalizedLedger.length,
      ledgerChecksums: normalizedLedger.map((row) => row.checksum),
      ledgerRows: normalizedLedger,
      projects: projects.length,
      sessions: sessions.length,
      idempotencyRows: idempotency.length,
      fileOperations: fileOperations.length,
      foreignKeyViolations: foreignKeys.length,
    };
  } finally { db.close(); }
}

export function validateWithSessionManager(file: string, disposableRoot: string): { entries: number; header: boolean } {
  const copy = path.join(disposableRoot, `${randomUUID()}.jsonl`);
  copyFileSync(file, copy);
  chmodSync(copy, 0o600);
  try {
    // The SDK is pointed exclusively at the disposable copy/root; it never
    // receives the publish path and cannot mutate restored output.
    const manager = SessionManager.open(copy, disposableRoot, disposableRoot);
    const header = manager.getHeader();
    const entries = manager.getEntries();
    if (!header || header.type !== "session" || typeof header.id !== "string" || !Array.isArray(manager.getTree())) fail("JSONL is not a structurally valid Pi session");
    const ids = new Set<string>();
    for (const entry of entries) {
      if (typeof entry.id !== "string" || ids.has(entry.id) || (entry.parentId !== null && typeof entry.parentId !== "string")) fail("Pi session entry structure is invalid");
      ids.add(entry.id);
    }
    return { entries: entries.length, header: true };
  } finally { rmSync(copy, { force: true }); }
}

/** Offline SQLite restore drill. It never opens the service, starts Fastify, or calls a model. */
export async function restoreSqliteBackup(options: RestoreOptions): Promise<RestoreResult> {
  const resolved = validatePaths(options.paths);
  const packageLayout = validatePackage(resolved.input);
  const age = options.age ?? options.crypto ?? options.cryptoAdapter ?? restoreAgeAdapter;
  await age.ensureAvailable?.(resolved.identity);

  // The manifest is the authenticated source-root binding. It must be
  // decrypted in a private system temporary directory before anything is
  // created below the target parent. In particular, an overlapping target must
  // fail before target-side staging (or any target-parent mkdir) is attempted.
  const manifestStaging = createPrivateManifestStaging(path.dirname(resolved.target));
  let staging: string | undefined;
  let published = false;
  let targetCreated = false;
  let finalPath: string | undefined;
  let target = resolved.target;
  try {
    const manifestPlain = path.join(manifestStaging, "manifest.json");
    if (hashFile(packageLayout.manifestCiphertext).sha256 !== packageLayout.manifestCiphertextSha256) fail("manifest ciphertext does not match COMPLETE");
    await decryptWithAdapter(age, packageLayout.manifestCiphertext, manifestPlain, resolved.identity);
    const manifest = validateManifest(JSON.parse(readFileSync(manifestPlain, "utf8")));
    // Authenticate and select the immutable historical migration prefix before
    // any payload is staged.  Restore never applies the selected suffix.
    const migrationContext = selectRestoreMigrationContext(manifest.migrationLedger as MigrationLedgerSnapshot);
    rmSync(manifestPlain, { force: true });

    // The source roots are authenticated metadata. Check every root, including
    // custom agentDir and databases with no session references, before staging.
    target = canonicalPath(options.paths.targetRoot, "target root");
    const sourceRoots = [manifest.sourceRoots.dataDir, manifest.sourceRoots.agentDir, manifest.sourceRoots.dbPath]
      .map((root, index) => canonicalPath(root, `manifest source root ${index}`));
    if (sourceRoots.some((source) => within(source, target) || within(target, source))) fail("target root overlaps an authenticated source root");

    // Only the authenticated, physically isolated path may now receive a
    // same-filesystem staging directory. The final publish remains one rename.
    const targetParent = path.dirname(target);
    if (!existsSync(targetParent)) mkdirSync(targetParent, { recursive: true, mode: 0o700 });
    staging = mkdtempSync(path.join(targetParent, ".pi-agent-restore-staging-"));
    chmodSync(staging, 0o700);
    const decryptedRoot = path.join(staging, "decrypted");
    const assembledRoot = path.join(staging, "assembled");
    mkdirSync(decryptedRoot, { recursive: true, mode: 0o700 });
    mkdirSync(assembledRoot, { recursive: true, mode: 0o700 });
    finalPath = path.join(target, `${RESTORE_DIR_PREFIX}${randomUUID()}`);

    const records = new Map(manifest.files.map((record) => [record.path, record as RestoreFile]));
    const payloadLayout = packageFiles(path.join(resolved.input, "payload"));
    const actualPayloadFiles = payloadLayout.files.map((file) => `payload/${file}`);
    if (actualPayloadFiles.length !== records.size || actualPayloadFiles.some((file) => !records.has(file))) fail("backup payload set does not exactly match the manifest");
    const expectedDirectories = new Set<string>();
    for (const record of records.values()) {
      const parts = record.path.slice("payload/".length).split("/").slice(0, -1);
      for (let index = 1; index <= parts.length; index++) expectedDirectories.add(parts.slice(0, index).join("/"));
    }
    if (payloadLayout.directories.some((directory) => !expectedDirectories.has(directory))) fail("backup contains an unexpected payload directory");

    // Decryption and assembly have deliberately separate roots. No plaintext is
    // ever copied onto itself, and only assembledRoot is eligible for publish.
    for (const [relative, record] of records) {
      const ciphertext = path.join(resolved.input, relative);
      const encrypted = hashFile(ciphertext);
      if (encrypted.size !== record.encryptedSize || encrypted.sha256 !== record.encryptedSha256) fail("encrypted payload hash or size mismatch");
      const plaintext = path.join(decryptedRoot, relative.slice("payload/".length, -4));
      mkdirSync(path.dirname(plaintext), { recursive: true, mode: 0o700 });
      await decryptWithAdapter(age, ciphertext, plaintext, resolved.identity);
      const actual = hashFile(plaintext);
      if (actual.size !== record.size || actual.sha256 !== record.sha256) fail("decrypted payload hash or size mismatch");
    }

    const databaseSnapshot = path.join(decryptedRoot, "database.sqlite");
    const database = path.join(assembledRoot, "pi-agent-server.db");
    if (!existsSync(databaseSnapshot)) fail("backup has no database snapshot");
    copyFileSync(databaseSnapshot, database);
    chmodSync(database, 0o600);
    const dataRoot = assembledRoot;
    for (const record of records.values()) {
      if (record.kind === "jsonl" || record.kind === "config") {
        const relative = record.path.slice("payload/".length, -4);
        const source = path.join(decryptedRoot, relative);
        const destination = path.join(dataRoot, relative);
        mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        copyFileSync(source, destination);
        chmodSync(destination, 0o600);
        if (hashFile(source).sha256 !== hashFile(destination).sha256) fail("assembled payload changed during copy");
      }
    }
    const jsonlFiles = [...records.values()].filter((record) => record.kind === "jsonl");
    let sessionEntries = 0;
    const validationCopyRoot = path.join(staging, ".session-validation");
    mkdirSync(validationCopyRoot, { recursive: true, mode: 0o700 });
    for (const record of jsonlFiles) {
      const relative = record.path.slice("payload/".length, -4);
      const file = path.join(dataRoot, relative);
      sessionEntries += parseJsonl(file);
      const checked = validateWithSessionManager(file, validationCopyRoot);
      if (!checked.header) fail("Pi session header is missing");
    }

    const included = new Set(records.keys());
    const remap = remapDatabase(database, finalPath, manifest, included);
    const dbCheck = await validateDatabase(database, finalPath, migrationContext);
    if (manifest.migrationLedger.appliedCount !== dbCheck.ledgerCount || manifest.migrationLedger.appliedVersion !== dbCheck.version ||
      manifest.migrationLedger.checksums.length !== dbCheck.ledgerChecksums.length || manifest.migrationLedger.checksums.some((checksum, index) => checksum !== dbCheck.ledgerChecksums[index]) ||
      stableSerialize(manifest.migrationLedger.rows) !== stableSerialize(dbCheck.ledgerRows)) fail("manifest migration ledger does not match the restored database");
    rmSync(validationCopyRoot, { recursive: true, force: true });
    const report: RestoreDrillReport = {
      status: "success", dialect: "SQLite", format: "pi-agent-server.backup-manifest.v1",
      counts: {
        payloads: records.size, jsonlFiles: jsonlFiles.length, projects: dbCheck.projects, sessions: dbCheck.sessions,
        idempotencyRows: dbCheck.idempotencyRows, fileOperations: dbCheck.fileOperations, sessionEntries, sessionHeaders: jsonlFiles.length,
        missingSessionReferences: remap.missing, foreignKeyViolations: dbCheck.foreignKeyViolations,
      },
      migration: { version: dbCheck.version, pending: dbCheck.pending, legacy: dbCheck.legacy },
    };
    if (options.dryRun === true) return { dryRun: true, finalPath: null, report };

    if (existsSync(target)) safeDirectory(target, "target root");
    else { mkdirSync(target, { recursive: true, mode: 0o700 }); chmodSync(target, 0o700); targetCreated = true; }
    if (existsSync(finalPath)) fail("restore target already exists");
    renameSync(assembledRoot, finalPath);
    published = true;
    return { dryRun: false, finalPath, report };
  } finally {
    if (!published && finalPath) rmSync(finalPath, { recursive: true, force: true });
    if (targetCreated && finalPath && existsSync(target) && readdirSync(target).length === 0) rmSync(target, { recursive: true, force: true });
    if (staging) rmSync(staging, { recursive: true, force: true });
    rmSync(manifestStaging, { recursive: true, force: true });
  }
}

export { restorePostgresBackup, POSTGRES_RESTORE_SAFETY_CONTRACT } from "./postgres-restore-core.js";
export type { PostgresRestoreOptions, PostgresRestorePaths, PostgresRestoreReport, PostgresRestoreResult, PgRestoreClient, PostgresRestoreSafetyContract } from "./postgres-restore-core.js";