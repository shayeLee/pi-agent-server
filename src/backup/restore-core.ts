import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { DatabaseSync } from "node:sqlite";
import { runSqliteMigrations } from "../storage/migration-engine.js";
import { classifyPiJsonlReference } from "../agent/pi-jsonl-reference.js";
import { migrationPrefixForLedger, type MigrationDefinition, type MigrationLedgerSnapshot } from "../storage/migration-manifest.js";
import { stableSerialize } from "../storage/migration-manifest.js";
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
    /** Present-but-invalid session histories discarded (invalid-as-empty degradation). */
    readonly invalidSessionHistories: number;
    readonly foreignKeyViolations: number;
  };
  readonly migration: {
    readonly version: number | null;
    readonly pending: number;
    /** True when the package explicitly carries no migration ledger. */
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
  if ((manifest.kind !== "sqlite-online" && manifest.kind !== "pre-migration" && manifest.kind !== "pre-owner-transfer") || manifest.dialect !== "SQLite") fail("unsupported backup format or dialect");
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
  for (const value of missing) {
    if (!value || typeof value !== "object") fail("manifest missing-reference metadata is invalid");
    const reference = value as Record<string, unknown>;
    if (typeof reference.sessionId !== "string" || reference.sessionId.length === 0 || reference.status !== "missing" || typeof reference.path !== "string") fail("manifest missing-reference metadata is invalid");
    const relative = relativePayloadPath(reference.path);
    const key = `${reference.sessionId}\u0000${relative}`;
    // Several sessions may legitimately share a missing JSONL path; the DB has
    // no uniqueness constraint on conversation_ref, and restore normalizes each
    // (sessionId, path) mapping independently.
    if (!isJsonlRelative(relative) || missingKeys.has(key) || seen.has(`payload/${relative}.age`)) fail("manifest missing-reference metadata conflicts with payloads");
    missingKeys.add(key);
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

/** Only this error class is eligible for invalid-as-empty degradation. */
export class InvalidSessionHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSessionHistoryError";
  }
}

function invalidSessionHistory(message: string): never {
  throw new InvalidSessionHistoryError(message);
}

/**
 * Structural validity verdict for one restored JSONL session history. Reading
 * failures remain operational failures; only InvalidSessionHistoryError means
 * authentic session bytes are semantically unusable and may degrade to empty.
 *
 * Restore accepts only the currently supported Pi session format (SDK v3):
 * the header must carry `version: 3` and every entry must satisfy the v3
 * id/parentId tree contract. v1/v2 headers (absent/older version fields) and
 * any other unsupported version are invalid-as-empty; restore never opens or
 * rewrites the SDK file and never migrates an older history in place. Backup
 * never calls this parser.
 */
export function parseJsonl(file: string): number {
  let bytes: Buffer;
  try { bytes = readFileSync(file); } catch { fail("staged file could not be read"); }
  const text = bytes.toString("utf8");
  if (text.length === 0 || text.includes("\uFFFD")) invalidSessionHistory("JSONL is not valid UTF-8");
  const lines = text.split("\n");
  const records: Array<Record<string, unknown>> = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (index === lines.length - 1 && line === "") continue;
    if (line.trim() === "") invalidSessionHistory("JSONL contains a blank line");
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { invalidSessionHistory("JSONL contains invalid JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidSessionHistory("JSONL record is not an object");
    records.push(parsed as Record<string, unknown>);
  }
  const header = records[0];
  if (!header || header.type !== "session" || typeof header.id !== "string" || header.id.length === 0) invalidSessionHistory("JSONL must begin with one session header");
  if (records.filter((record) => record.type === "session").length !== 1) invalidSessionHistory("JSONL must contain exactly one session header");
  const version = header.version;
  // Only the current SDK session format (version 3) is supported. Older v1/v2
  // histories are authentic Pi bytes but not the supported structure; restore
  // degrades them to empty instead of relying on a later SDK migration.
  if (typeof version !== "number" || !Number.isInteger(version) || version !== 3) invalidSessionHistory("JSONL session version is not the supported Pi SDK v3 format");
  const ids = new Set<string>();
  const parents = new Map<string, string | null>();
  for (const [index, record] of records.entries()) {
    if (typeof record.id !== "string" || record.id.length === 0 || ids.has(record.id)) invalidSessionHistory("JSONL record ids must be unique");
    ids.add(record.id);
    if (index === 0) continue;
    if (!(record.parentId === null || typeof record.parentId === "string")) invalidSessionHistory("JSONL parentId is malformed");
    if (record.parentId === record.id) invalidSessionHistory("JSONL record cannot be its own parent");
    parents.set(record.id, record.parentId as string | null);
  }
  for (const parent of parents.values()) if (parent !== null && !ids.has(parent)) invalidSessionHistory("JSONL parentId does not exist");
  for (const id of parents.keys()) {
    const seen = new Set<string>(); let current: string | null | undefined = id;
    while (current !== null && current !== undefined) {
      if (seen.has(current)) invalidSessionHistory("JSONL parent graph contains a cycle");
      seen.add(current); current = parents.get(current);
    }
  }
  return records.length;
}

export function deriveRelativeSessionPath(source: string): string {
  if (!path.isAbsolute(source)) fail("session conversation reference is not absolute");
  const parts = source.split(path.sep).filter(Boolean);
  const projects = parts.lastIndexOf("projects");
  if (projects >= 0 && parts.length === projects + 5 && parts[projects + 2] === "sessions" && parts.at(-1)?.endsWith(".jsonl")) return parts.slice(projects).join("/");
  const sessions = parts.lastIndexOf("sessions");
  if (sessions >= 0 && parts.length === sessions + 3 && parts.at(-1)?.endsWith(".jsonl")) return parts.slice(sessions).join("/");
  fail("session conversation reference is outside the restore data layout");
}

type RestoreMigrationContext = {
  readonly migrations: readonly MigrationDefinition[];
};

/**
 * Authenticate the package's migration ledger before any restored data is
 * trusted. Restore accepts ONLY the canonical single baseline: a package
 * without a ledger (legacy RC shape) or with any other ledger history is
 * rejected here, before any payload is decrypted or staged.
 */
function selectRestoreMigrationContext(ledger: MigrationLedgerSnapshot): RestoreMigrationContext {
  if (!ledger.present) {
    fail("backup carries no authenticated migration ledger; only packages with the exact canonical single baseline are recoverable");
  }
  try {
    const migrations = migrationPrefixForLedger(ledger);
    if (migrations.length !== 1 || migrations[0]!.version !== 0) fail("restore accepts only the canonical single-baseline migration ledger");
    return { migrations };
  } catch (error) {
    fail(error instanceof Error ? error.message.replace(/^schema migration ledger:\s*/, "") : "authenticated migration history is invalid");
  }
}

/**
 * Normalize every restored session reference to the final target location.
 * Missing references (manifest missing-as-empty) and present-but-invalid
 * histories are written as NULL per the confirmed semantics: the session
 * keeps all metadata but has no history. Package-level byte integrity (age /
 * manifest / hash / size) is enforced BEFORE this function, so a NULL here
 * always means "no history", never "corrupt package". The invalid set is the
 * structural verdict from the restore's own payload inspection (see
 * parseJsonl), computed without opening the SDK.
 */
function remapDatabase(dbPath: string, finalPath: string, manifest: BackupManifest, included: Set<string>, invalidHistories: ReadonlySet<string>): { missing: number } {
  const db = new DatabaseSync(dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
  try {
    const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='sessions'").get();
    if (!table) fail("restored database has no sessions table");
    const missingKeys = new Set(manifest.missingSessionReferences.map((reference) => `${reference.sessionId}\u0000${reference.path}`));
    const consumedMissing = new Set<string>();
    const rows = db.prepare("SELECT id, project_id, agent_kind, conversation_format, conversation_ref FROM sessions WHERE conversation_ref IS NOT NULL").all() as Array<{ id: unknown; project_id: unknown; agent_kind: unknown; conversation_format: unknown; conversation_ref: unknown }>;
    let missing = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (typeof row.id !== "string" || typeof row.project_id !== "string" || row.agent_kind !== "pi" || row.conversation_format !== "pi-jsonl-v3" || typeof row.conversation_ref !== "string") fail("restored session conversation reference is malformed");
        const relative = deriveRelativeSessionPath(row.conversation_ref);
        const payloadRelative = `payload/${relative}.age`;
        const restored = path.join(finalPath, relative);
        if (!within(finalPath, restored) || !isJsonlRelative(relative)) fail("restored session reference escapes target data directory");
        const classification = classifyPiJsonlReference(finalPath, {
          sessionId: row.id,
          projectId: row.project_id,
          agentKind: row.agent_kind,
          conversationFormat: row.conversation_format,
          conversationRef: restored,
        });
        if (classification.kind !== "valid" || !classification.idsMatch || classification.canonical !== relative) {
          fail("restored session conversation reference does not match its Pi session/project layout");
        }
        const missingKey = `${row.id}\u0000${relative}`;
        if (missingKeys.has(missingKey)) {
          // Missing-as-empty: the referenced history never existed at backup
          // time, so the restored session has no history.
          missing++;
          consumedMissing.add(missingKey);
          db.prepare("UPDATE sessions SET conversation_ref = NULL WHERE id = ?").run(row.id);
          continue;
        }
        if (invalidHistories.has(relative)) {
          // Invalid-as-empty degradation: the payload bytes are authentic
          // (package integrity already passed) but the history is not a valid
          // Pi session, so the history is discarded and the reference nulled.
          db.prepare("UPDATE sessions SET conversation_ref = NULL WHERE id = ?").run(row.id);
          continue;
        }
        if (!included.has(payloadRelative) || !existsSync(path.join(path.dirname(dbPath), relative))) {
          fail("restored session reference has no matching manifest payload");
        }
        db.prepare("UPDATE sessions SET conversation_ref = ? WHERE id = ?").run(restored, row.id);
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

    // Verify exactly the authenticated canonical single baseline. Restore
    // remains read-only and never applies migrations.
    const checked = await runSqliteMigrations(db, { mode: "verify" });
    const migration = { appliedVersion: checked.appliedVersion, pending: checked.pending };
    if (migration.pending.length !== 0 || migration.appliedVersion !== migrationContext.migrations.at(-1)!.version) {
      fail("restored database did not reach the authenticated migration head");
    }

    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length !== 0) fail("restored database has foreign-key violations");
    const ledgerRows = db.prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version").all() as Array<{ version: unknown; name: unknown; checksum: unknown; applied_at: unknown }>;
    if (ledgerRows.some((row) => !Number.isSafeInteger(row.version) || typeof row.name !== "string" || typeof row.checksum !== "string" || !Number.isSafeInteger(row.applied_at))) fail("restored migration ledger is malformed");
    const normalizedLedger = ledgerRows.map((row) => ({ version: Number(row.version), name: row.name as string, checksum: row.checksum as string, applied_at: Number(row.applied_at) }));
    const projects = db.prepare("SELECT id, name, cwd, owner_key FROM projects").all() as Array<Record<string, unknown>>;
    const sessions = db.prepare("SELECT id, owner_key, project_id, title, agent_kind, conversation_format, conversation_ref, capability_versions FROM sessions").all() as Array<Record<string, unknown>>;
    const idempotency = db.prepare("SELECT session_id, request_id, result FROM idempotency").all() as Array<Record<string, unknown>>;
    // The canonical single baseline always ships file_operations; restore
    // validates its rows but never executes any pending deletion task.
    const fileOperations = db.prepare("SELECT id, operation_key, kind, relative_path, session_id, project_id, state, attempt_count, available_at, lease_until, lease_token, last_error, created_at, updated_at FROM file_operations").all() as Array<Record<string, unknown>>;
    validateRestoredFileOperations(fileOperations);
    for (const row of projects) if (![row.id, row.name, row.cwd, row.owner_key].every((value) => typeof value === "string")) fail("restored project data is malformed");
    for (const row of sessions) {
      if (![row.id, row.owner_key, row.project_id, row.title, row.agent_kind, row.conversation_format].every((value) => typeof value === "string")) fail("restored session data is malformed");
      if (row.agent_kind !== "pi" || row.conversation_format !== "pi-jsonl-v3") fail("restored session uses an unsupported conversation kind or format");
      if (row.conversation_ref !== null && (typeof row.conversation_ref !== "string" || !path.isAbsolute(row.conversation_ref) || !within(finalPath, row.conversation_ref))) fail("restored session conversation reference was not safely remapped");
      if (row.capability_versions !== null) { try { JSON.parse(String(row.capability_versions)); } catch { fail("restored capability_versions is invalid JSON"); } }
    }
    for (const row of idempotency) {
      if (typeof row.session_id !== "string" || typeof row.request_id !== "string") fail("restored idempotency key is malformed");
      try { JSON.parse(String(row.result)); } catch { fail("restored idempotency result is invalid JSON"); }
    }
    return {
      version: migration.appliedVersion,
      pending: migration.pending.length,
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
    // Authenticate the canonical single-baseline migration ledger before any
    // payload is staged or decrypted.  Legacy packages (no ledger or any
    // non-canonical ledger) fail here.  Restore never applies a migration.
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
    // Invalid-as-empty detection: a JSONL history whose bytes passed the
    // package hash but is not a structurally valid Pi session is degraded —
    // the history is discarded (assembled copy removed), the DB reference is
    // normalized to NULL, and the restore continues with every other session.
    // The detection is a local structural parse of the assembled payload
    // only: no SDK SessionManager.open, no whole-data-dir scanner.
    const invalidHistories = new Set<string>();
    let sessionEntries = 0;
    for (const record of jsonlFiles) {
      const relative = record.path.slice("payload/".length, -4);
      const file = path.join(dataRoot, relative);
      try {
        sessionEntries += parseJsonl(file);
      } catch (error) {
        // Only confirmed semantic JSONL invalidity may degrade. I/O, assembly,
        // age/hash/manifest and every other operational failure remains
        // fail-closed for the whole restore.
        if (!(error instanceof InvalidSessionHistoryError)) throw error;
        invalidHistories.add(relative);
        rmSync(file, { force: true });
      }
    }

    const included = new Set(records.keys());
    const remap = remapDatabase(database, finalPath, manifest, included, invalidHistories);
    const dbCheck = await validateDatabase(database, finalPath, migrationContext);
    if (manifest.migrationLedger.appliedCount !== dbCheck.ledgerCount || manifest.migrationLedger.appliedVersion !== dbCheck.version ||
      manifest.migrationLedger.checksums.length !== dbCheck.ledgerChecksums.length || manifest.migrationLedger.checksums.some((checksum, index) => checksum !== dbCheck.ledgerChecksums[index]) ||
      stableSerialize(manifest.migrationLedger.rows) !== stableSerialize(dbCheck.ledgerRows)) fail("manifest migration ledger does not match the restored database");
    const report: RestoreDrillReport = {
      status: "success", dialect: "SQLite", format: "pi-agent-server.backup-manifest.v1",
      counts: {
        payloads: records.size, jsonlFiles: jsonlFiles.length, projects: dbCheck.projects, sessions: dbCheck.sessions,
        idempotencyRows: dbCheck.idempotencyRows, fileOperations: dbCheck.fileOperations, sessionEntries,
        sessionHeaders: jsonlFiles.length - invalidHistories.size,
        missingSessionReferences: remap.missing, invalidSessionHistories: invalidHistories.size,
        foreignKeyViolations: dbCheck.foreignKeyViolations,
      },
      migration: { version: dbCheck.version, pending: dbCheck.pending },
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