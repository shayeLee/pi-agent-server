import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import path from "node:path";
import { runSqliteMigrations } from "../storage/migration-engine.js";
import {
  migrationPrefixForLedger,
  stableSerialize,
  type MigrationLedgerSnapshot,
} from "../storage/migration-manifest.js";

const MAX_FILE_RETRIES = 3;
const READ_CHUNK_SIZE = 64 * 1024;
const AUTH_FILE_NAME = "auth.json";
/**
 * Bounded age child budget: a hung encryption never leaks a child or a temp
 * file. Sizing (measured by tests/backup/age-stream.test.ts): real age
 * encrypts tens of MiB per second while actual prebackup payloads are KB–MB,
 * so payload time is milliseconds. The default budget therefore bounds a hung
 * or never-scheduled child (spawn/scheduling latency under a fully parallel
 * test/CI load), not payload throughput, and is configurable per call via
 * `ageProcessTimeoutMs` on the backup options.
 */
export const AGE_PROCESS_TIMEOUT_MS = 60_000;

type FileKind = "jsonl" | "config";
/**
 * "pre-owner-transfer" is published only by the offline owner-transfer tool
 * (WP5D-4) and uses the full DB/WAL/SHM tree binding captured around the snapshot.
 */
export type BackupKind = "sqlite-online" | "pre-migration" | "pre-owner-transfer";

/** Per-call bound for one age child process. */
export interface AgeEncryptFileOptions {
  readonly timeoutMs?: number;
}

/** The production adapter deliberately uses spawn without a shell. */
export interface AgeAdapter {
  readonly ensureAvailable?: (recipientFile: string) => Promise<void> | void;
  /** Compatibility hook for small test adapters. Production uses encryptFile. */
  encrypt: (input: Buffer, recipientFile: string) => Promise<Buffer> | Buffer;
  /** Stream a plaintext file into age and its ciphertext into outputPath. */
  encryptFile?: (inputPath: string, outputPath: string, recipientFile: string, options?: AgeEncryptFileOptions) => Promise<void>;
}

export const ageAdapter: AgeAdapter = {
  async ensureAvailable(): Promise<void> {
    await spawnAge(["--version"], undefined, undefined, true);
  },
  async encryptFile(inputPath, outputPath, recipientFile, options): Promise<void> {
    await spawnAgeFile(["--encrypt", "--recipients-file", recipientFile], inputPath, outputPath, options?.timeoutMs ?? AGE_PROCESS_TIMEOUT_MS);
  },
  async encrypt(input, recipientFile): Promise<Buffer> {
    return spawnAge(["--encrypt", "--recipients-file", recipientFile], input, undefined, false);
  },
};

export interface SessionFileReference {
  readonly sessionId: string;
  readonly file: string;
}

export interface BackupFileRecord {
  readonly path: string;
  readonly kind: "sqlite-snapshot" | "postgres-dump" | "jsonl" | "config";
  readonly size: number;
  readonly sha256: string;
  readonly encryptedSize?: number;
  readonly encryptedSha256?: string;
}

export interface MissingSessionReference {
  readonly sessionId: string;
  readonly path: string;
  readonly status: "missing";
}

export interface BackupSourceRoots {
  readonly dataDir: string;
  readonly agentDir: string;
  readonly dbPath: string;
}

/**
 * Stat fingerprint of the exact source SQLite database file at backup time
 * (dev/ino/nlink/mode/size/mtime + full-content SHA-256). It binds the
 * published package to that one file, binding the package to the backed-up
 * database state without retaining any reset/cutover behavior.
 */
export interface SqliteSourceBinding {
  readonly dialect: "sqlite";
  readonly dev: string;
  readonly ino: string;
  readonly nlink: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: string;
  readonly sha256: string;
}

/**
 * Complete fingerprint of ONE file of the source SQLite set (main DB, WAL, or
 * SHM sidecar): existence plus dev/ino/nlink/mode/size/mtime and, when the
 * file exists, its full-content SHA-256. `sha256` is null only for a
 * non-existent file; an existing file that cannot be fingerprinted stably
 * fails the bound backup instead of being recorded with a null hash.
 */
export interface SqliteSourceFileBinding {
  readonly exists: boolean;
  readonly dev: string;
  readonly ino: string;
  readonly nlink: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: string;
  readonly sha256: string | null;
}

/**
 * Full DB/WAL/SHM binding for the owner-transfer recovery anchor. Captured at
 * snapshot-generation time (immediately around the VACUUM INTO, never at the
 * end of the backup), it detects WAL-only commits that a single-file binding
 * cannot see before the anchor is published.
 */
export interface SqliteSourceTreeBinding {
  readonly dialect: "sqlite";
  readonly db: SqliteSourceFileBinding;
  readonly wal: SqliteSourceFileBinding;
  readonly shm: SqliteSourceFileBinding;
}

/**
 * Creation-time identity of a published backup package. It is returned by the
 * create*Backup call and re-checked by verifyPublishedBackup against the
 * published bytes, so a manifest ciphertext or COMPLETE marker replaced after
 * creation can never be consumed (decryption is not required).
 */
export interface PublishedBackupIdentity {
  /** SHA-256 of the published encrypted manifest ciphertext (manifest.json.age). */
  readonly manifestSha256: string;
  /** Exact content of the published COMPLETE marker. */
  readonly completeMarker: string;
  /** Digest over the canonical source roots, as serialized into the manifest. */
  readonly sourceRootsSha256: string;
  /** Digest over the dialect source binding (SQLite tree/stat or PG identity). */
  readonly sourceBindingSha256: string;
}

export interface BackupManifest {
  readonly format: "pi-agent-server.backup-manifest.v1";
  readonly kind: BackupKind;
  readonly dialect: "SQLite";
  readonly createdAt: string;
  /** Canonical source roots are part of the authenticated manifest. */
  readonly sourceRoots: BackupSourceRoots;
  /** Stat fingerprint binding the manifest to the exact backed-up DB file. */
  readonly sourceBinding: SqliteSourceBinding;
  /**
   * Pre-owner-transfer only: full DB/WAL/SHM binding captured at
   * snapshot-generation time. Other backup kinds omit this field.
   */
  readonly sourceTreeBinding?: SqliteSourceTreeBinding;
  readonly sourceRootsSha256: string;
  /** Alias retained for consumers that call the binding a source-roots hash. */
  readonly sourceRootsHash: string;
  readonly timeWindow: { readonly startedAt: string; readonly finishedAt: string };
  readonly migrationLedger: {
    readonly present: boolean;
    readonly appliedCount: number;
    readonly appliedVersion: number | null;
    readonly checksums: readonly string[];
    readonly rows: readonly { readonly version: number; readonly name: string; readonly checksum: string; readonly applied_at: number }[];
    readonly pending: number;
  };
  readonly credentials: { readonly included: false; readonly policy: "whitelist-excludes-credentials" };
  /** Public age recipient metadata; no identity/private-key material is stored. */
  readonly encryption: { readonly format: "age-v1"; readonly recipients: readonly string[] };
  readonly files: readonly BackupFileRecord[];
  readonly missingSessionReferences: readonly MissingSessionReference[];
  readonly excludedFiles: readonly { readonly path: string; readonly reason: "auth-file" }[];
}

export interface PostgresBackupSourceRoots {
  readonly dataDir: string;
  readonly agentDir: string;
}

export interface PostgresSnapshotMetadata {
  /** Stable opaque identifiers; database/schema names are never stored. */
  readonly databaseIdentity: string;
  readonly schemaIdentity: string;
  /** pg_control_system().system_identifier; null only when the server could not be queried. */
  readonly systemIdentifier: string | null;
  readonly databaseOid: string | null;
  readonly schemaOid: string | null;
  readonly serverAddress: string | null;
  readonly serverPort: string | null;
  readonly clusterName: string | null;
  readonly pgDumpVersion: string;
  readonly pgRestoreVersion: string;
}

export interface PublishedBackupVerification {
  readonly id: string;
  readonly kind: BackupKind | "postgresql";
  readonly checksum: string;
  readonly version: number | null;
  /** Canonical source roots recorded in the authenticated manifest. */
  readonly sourceRoots: (BackupSourceRoots | PostgresBackupSourceRoots) | null;
  /** SQLite stat fingerprint binding (null for PostgreSQL backups). */
  readonly sqliteTarget: SqliteSourceBinding | null;
  /** Full SQLite DB/WAL/SHM binding (null for PostgreSQL or legacy manifests). */
  readonly sqliteTreeBinding: SqliteSourceTreeBinding | null;
  /** PostgreSQL cluster/database/schema identity binding (null for SQLite backups). */
  readonly postgres: PostgresSnapshotIdentity | null;
}

/** Cluster/server/database/schema identity binding for a PostgreSQL backup. */
export interface PostgresSnapshotIdentity {
  readonly databaseIdentity: string;
  readonly schemaIdentity: string;
  /** pg_control_system().system_identifier; null only when the server could not be queried. */
  readonly systemIdentifier: string | null;
  readonly databaseOid: string | null;
  readonly schemaOid: string | null;
  readonly serverAddress: string | null;
  readonly serverPort: string | null;
  readonly clusterName: string | null;
}

export interface PostgresBackupManifest {
  readonly format: "pi-agent-server.backup-manifest.v1";
  readonly kind: "postgresql" | "pre-migration" | "pre-owner-transfer";
  readonly dialect: "PostgreSQL";
  readonly createdAt: string;
  readonly sourceRoots: PostgresBackupSourceRoots;
  readonly sourceRootsSha256: string;
  readonly sourceRootsHash: string;
  readonly timeWindow: { readonly startedAt: string; readonly finishedAt: string };
  readonly postgres: PostgresSnapshotMetadata;
  readonly migrationLedger: BackupManifest["migrationLedger"];
  readonly credentials: { readonly included: false; readonly policy: "whitelist-excludes-credentials" };
  readonly encryption: { readonly format: "age-v1"; readonly recipients: readonly string[] };
  readonly files: readonly BackupFileRecord[];
  readonly missingSessionReferences: readonly MissingSessionReference[];
  readonly excludedFiles: readonly { readonly path: string; readonly reason: "auth-file" }[];
}

export type AnyBackupManifest = BackupManifest | PostgresBackupManifest;

export interface BackupPaths {
  readonly dataDir: string;
  readonly agentDir?: string;
  readonly dbPath: string;
  /**
   * The actual credential file location (e.g. PI_AUTH_PATH or its server
   * default). Optional so injected test paths stay valid, but when provided
   * (all CLI paths provide it) the whitelist hard-rejects any overlap between
   * the credential and the backed-up/reset surface — by resolved path, not by
   * the "auth.json" file name.
   */
  readonly authPath?: string;
  readonly backupRoot: string;
  readonly ageRecipientFile: string;
}

export interface BackupOptions {
  readonly paths: BackupPaths;
  /** The published manifest kind. Pre-migration is only selected by the offline migration CLI. */
  readonly backupKind?: BackupKind;
  readonly dryRun?: boolean;
  readonly age?: AgeAdapter;
  /** Hard per-child age budget; defaults to AGE_PROCESS_TIMEOUT_MS (see its sizing note). */
  readonly ageProcessTimeoutMs?: number;
  /**
   * Explicit root for the PRIVATE plaintext staging directory (SQLite
   * VACUUM INTO snapshot, JSONL copies, manifest plaintext). Must be an
   * absolute directory path; when blank/absent the OS temporary directory is
   * used. Plaintext staging never lives in (or contains) the backup root or
   * its parent, and the backup root's parent never needs to be writable.
   */
  readonly stagingRoot?: string;
  readonly now?: () => Date;
  readonly querySessionReferences?: (db: DatabaseSync) => readonly SessionFileReference[];
}

export interface BackupResult {
  readonly dryRun: boolean;
  readonly finalPath: string | null;
  readonly files: readonly BackupFileRecord[];
  readonly missingSessionReferences: readonly MissingSessionReference[];
  readonly manifest: BackupManifest | null;
  /** Creation-time identity of the published package (null for dry-run). */
  readonly publishedIdentity: PublishedBackupIdentity | null;
}

interface Fingerprint {
  readonly exists: boolean;
  readonly dev: string;
  readonly ino: string;
  readonly nlink: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeNs: string;
  readonly sha256: string | null;
}

export interface PlannedSourceFile {
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly kind: FileKind;
}

interface PreparedSource {
  readonly plan: PlannedSourceFile;
  readonly plaintextPath: string;
  readonly sourceFingerprint: Fingerprint;
}

interface EncryptedInfo {
  readonly size: number;
  readonly sha256: string;
}

function fail(message: string): never {
  throw new Error(`backup: ${message}`);
}

function statPart(value: number | bigint): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

function emptyFingerprint(): Fingerprint {
  return { exists: false, dev: "", ino: "", nlink: 0, mode: 0, size: 0, mtimeNs: "", sha256: null };
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.exists === b.exists && a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink &&
    a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.sha256 === b.sha256;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Resolve the existing ancestor while rejecting every symlink in the path. */
function securePath(input: string, label: string): string {
  const absolute = path.resolve(input);
  const root = path.parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    try {
      const entry = lstatSync(current);
      // macOS exposes the system temporary tree through /var -> /private/var;
      // this OS alias is canonicalized, while user/application symlink aliases
      // remain fail-fast. The same exception applies to Linux /tmp aliases.
      const trustedSystemAlias = (process.platform === "darwin" && (current === "/var" || current === "/tmp")) || (process.platform !== "darwin" && current === "/tmp");
      if (entry.isSymbolicLink() && !trustedSystemAlias) fail(`${label} contains a symbolic-link ancestor`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // The remaining suffix does not exist. Existing ancestors were checked.
      break;
    }
  }
  return absolute;
}

function validateDirectory(directory: string, label: string, mayNotExist = true): void {
  securePath(directory, label);
  if (!existsSync(directory)) {
    if (!mayNotExist) fail(`${label} does not exist`);
    return;
  }
  const st = lstatSync(directory);
  if (!st.isDirectory()) fail(`${label} must be a directory`);
  if ((st.mode & 0o022) !== 0) fail(`${label} must not be group/world writable`);
}

export function validateRegular(file: string, label: string, required = true): void {
  securePath(file, label);
  if (!existsSync(file)) {
    if (required) fail(`${label} does not exist`);
    return;
  }
  const st = lstatSync(file);
  if (st.isSymbolicLink()) fail(`${label} is a symbolic link`);
  if (!st.isFile()) fail(`${label} must be a regular file`);
  if (st.nlink > 1) fail(`${label} is a hardlink (nlink=${st.nlink})`);
}

function canonicalForComparison(input: string): string {
  const absolute = securePath(input, "path");
  let existing = absolute;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathNoSymlink(existing), ...suffix);
}

function realpathNoSymlink(existing: string): string {
  // securePath has checked all existing components. realpathSync now only
  // canonicalizes mount aliases and preserves the no-symlink policy.
  return realpathSync(existing);
}

function validateTarget(paths: BackupPaths): { dataDir: string; agentDir: string; dbPath: string; backupRoot: string; recipients: readonly string[] } {
  for (const [label, value] of [
    ["data directory", paths.dataDir], ["agent directory", paths.agentDir ?? path.join(paths.dataDir, ".pi-agent")],
    ["source database", paths.dbPath], ["backup root", paths.backupRoot], ["age recipient file", paths.ageRecipientFile],
  ] as const) if (!path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  if (path.resolve(paths.backupRoot) === path.parse(paths.backupRoot).root) fail("backup root must not be the filesystem root");

  const dataDir = canonicalForComparison(paths.dataDir);
  const agentDir = canonicalForComparison(paths.agentDir ?? path.join(paths.dataDir, ".pi-agent"));
  const backupRoot = canonicalForComparison(paths.backupRoot);
  const dbPath = canonicalForComparison(paths.dbPath);
  const modelsPath = path.join(agentDir, "models.json");
  const sessionsRoot = path.join(dataDir, "sessions");
  const projectsRoot = path.join(dataDir, "projects");
  // The actual credential location (PI_AUTH_PATH or the server default),
  // resolved like every other source path. Any overlap — in either direction,
  // including via realpath aliases and not-yet-existing suffixes — with the
  // whitelisted/reset surface rejects the backup outright. The whitelist must
  // never rely on the "auth.json" file name to keep credentials out.
  const configuredAuthPath = paths.authPath ?? (process.env.PI_AUTH_PATH?.trim() || undefined);
  const authPath = canonicalForComparison(configuredAuthPath ?? path.join(homedir(), ".pi", "agent", "auth.json"));

  validateDirectory(paths.dataDir, "data directory", false);
  validateDirectory(paths.agentDir ?? path.join(paths.dataDir, ".pi-agent"), "agent directory");
  validateDirectory(paths.backupRoot, "backup root");
  validateRegular(paths.dbPath, "source database");
  for (const sidecar of [`${paths.dbPath}-wal`, `${paths.dbPath}-shm`]) validateRegular(sidecar, "source SQLite DB/WAL/SHM sidecar", false);
  validateRegular(paths.ageRecipientFile, "age recipient file");
  const recipientStat = lstatSync(paths.ageRecipientFile);
  if ((recipientStat.mode & 0o022) !== 0) fail("age recipient file is not a safe regular file");

  // Backup must never be a source alias, including a not-yet-created path.
  if (isWithin(dataDir, backupRoot) || isWithin(backupRoot, dataDir) ||
      isWithin(agentDir, backupRoot) || isWithin(backupRoot, agentDir) ||
      isWithin(sessionsRoot, backupRoot) || isWithin(backupRoot, sessionsRoot) ||
      isWithin(projectsRoot, backupRoot) || isWithin(backupRoot, projectsRoot) ||
      isWithin(backupRoot, dbPath)) fail("backup root physically overlaps a source path");

  // The credential must never sit inside (or contain) any whitelisted source
  // root, the service config, or the SQLite DB sidecar surface.
  for (const [label, root] of [
    ["sessions whitelist root", sessionsRoot], ["projects whitelist root", projectsRoot],
    ["agentDir/models.json", modelsPath], ["source database", dbPath],
  ] as const) {
    if (isWithin(root, authPath) || isWithin(authPath, root)) {
      fail(`the resolved credential path overlaps the ${label}; credentials are never backed up and the reset surface must never cover them`);
    }
  }

  const recipient = readFileSync(paths.ageRecipientFile);
  const recipientText = recipient.toString("utf8");
  const recipientLines = recipientText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (recipient.length === 0 || recipient.includes(0) || recipientText.includes("\uFFFD") || recipientLines.length === 0 || recipientLines.some((line) => !/^age1[0-9a-z]+$/.test(line))) {
    fail("age recipient file is binary or contains no valid age recipient");
  }
  if (recipientText.includes("AGE-SECRET-KEY-")) fail("age recipient file contains a private key");
  validateRegular(modelsPath, "agentDir/models.json", false);
  return { dataDir, agentDir, dbPath, backupRoot, recipients: recipientLines };
}

function openNoFollow(file: string, flags: number, mode?: number): number {
  return openSync(file, flags | (constants.O_NOFOLLOW ?? 0), mode);
}

function fingerprintFromStats(st: ReturnType<typeof fstatSync>, sha256: string | null): Fingerprint {
  return {
    exists: true,
    dev: statPart(st.dev),
    ino: statPart(st.ino),
    nlink: Number(st.nlink),
    mode: Number(st.mode),
    size: Number(st.size),
    mtimeNs: String(st.mtimeMs),
    sha256,
  };
}

/** Hashes exactly the bytes read from one FD, bounded by fstat before/after. */
function fingerprint(file: string): Fingerprint {
  try {
    const link = lstatSync(file);
    if (!link.isFile()) return emptyFingerprint();
    if (link.isSymbolicLink()) fail("source changed to a symbolic link");
    if (link.nlink > 1) fail(`source file is a hardlink (nlink=${link.nlink})`);
    const fd = openNoFollow(file, constants.O_RDONLY);
    try {
      const before = fstatSync(fd);
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(READ_CHUNK_SIZE);
      let position = 0;
      while (position < before.size) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (count === 0) break;
        hash.update(buffer.subarray(0, count));
        position += count;
      }
      const after = fstatSync(fd);
      const result = fingerprintFromStats(after, position === before.size ? hash.digest("hex") : null);
      return sameFingerprint(fingerprintFromStats(before, result.sha256), result) ? result : { ...result, sha256: null };
    } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFingerprint();
    throw error;
  }
}

async function readStableSource(plan: PlannedSourceFile, tempRoot: string): Promise<PreparedSource> {
  let lastReason = "source changed";
  for (let attempt = 0; attempt < MAX_FILE_RETRIES; attempt++) {
    const temp = path.join(tempRoot, `.plain-${randomUUID()}`);
    let fd: number | undefined;
    let out: number | undefined;
    let keepTemp = false;
    try {
      fd = openNoFollow(plan.sourcePath, constants.O_RDONLY);
      const before = fstatSync(fd);
      if (!statIsRegularSingleLink(before)) throw new Error("source is not a single-link regular file");
      out = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      const hash = createHash("sha256");
      // JSONL session histories are OPAQUE bytes at backup time: no JSON.parse
      // and no line inspection here. Content validity is a restore-time concern
      // (invalid-as-empty degrades the session history to a NULL reference; it
      // never fails the backup). AgentDir config (models.json) is still
      // validated as JSON so a broken config cannot silently enter the package.
      let configText = "";
      const decoder = new StringDecoder("utf8");
      const buffer = Buffer.allocUnsafe(READ_CHUNK_SIZE);
      let total = 0;
      while (total < before.size) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - total), total);
        if (count === 0) break;
        const chunk = buffer.subarray(0, count);
        hash.update(chunk);
        writeAll(out, chunk);
        total += count;
        if (plan.kind === "config") configText += decoder.write(chunk);
      }
      if (plan.kind === "config") {
        configText += decoder.end();
        try { JSON.parse(configText); } catch { fail(`models.json is not valid JSON: ${path.basename(plan.sourcePath)}`); }
      }
      const after = fstatSync(fd);
      const actual = fingerprintFromStats(after, total === before.size ? hash.digest("hex") : null);
      const expected = fingerprintFromStats(before, actual.sha256);
      if (!sameFingerprint(expected, actual)) {
        throw new Error("source changed during fstat/read/fstat verification");
      }
      closeSync(out); out = undefined;
      closeSync(fd); fd = undefined;
      chmodSync(temp, 0o600);
      keepTemp = true;
      return { plan, plaintextPath: temp, sourceFingerprint: actual };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : "source read failed";
    } finally {
      if (out !== undefined) closeSync(out);
      if (fd !== undefined) closeSync(fd);
      if (!keepTemp && existsSync(temp)) rmSync(temp, { force: true });
    }
    if (attempt + 1 < MAX_FILE_RETRIES) await backoff(attempt);
  }
  fail(`${lastReason}; exceeded ${MAX_FILE_RETRIES} stability attempts`);
}

function statIsRegularSingleLink(st: ReturnType<typeof fstatSync>): boolean {
  return st.isFile() && st.nlink === 1;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5 * (2 ** attempt)));
}

function walkAllowedDirectory(root: string, dataDir: string, output: PlannedSourceFile[], excluded: { path: string; reason: "auth-file" }[]): void {
  let rootStat: ReturnType<typeof lstatSync>;
  try { rootStat = lstatSync(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (rootStat.isSymbolicLink()) fail("whitelisted source directory is a symbolic link");
  if (!rootStat.isDirectory()) fail("whitelisted source path is not a directory");
  if ((rootStat.mode & 0o022) !== 0) fail("whitelisted source directory must not be group/world writable");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) fail("symbolic links are not allowed in whitelisted data");
    if (entry.isDirectory()) walkAllowedDirectory(sourcePath, dataDir, output, excluded);
    else if (entry.isFile()) {
      const relativePath = path.relative(dataDir, sourcePath).split(path.sep).join("/");
      if (entry.name.toLowerCase() === AUTH_FILE_NAME) {
        excluded.push({ path: relativePath, reason: "auth-file" });
      } else if (!entry.name.endsWith(".jsonl")) {
        fail(`unknown/non-jsonl file in whitelist: ${relativePath}`);
      } else if (!isExpectedSessionLayout(relativePath)) {
        fail(`unexpected session layout in whitelist: ${relativePath}`);
      } else {
        const st = lstatSync(sourcePath);
        if (st.nlink > 1) fail(`whitelisted file is a hardlink: ${relativePath}`);
        output.push({ sourcePath, relativePath, kind: "jsonl" });
      }
    } else fail("special files are not allowed in whitelisted data");
  }
}

function isExpectedSessionLayout(relativePath: string): boolean {
  const parts = relativePath.split("/");
  return (parts[0] === "sessions" && parts.length === 3) ||
    (parts[0] === "projects" && parts[2] === "sessions" && parts.length === 5);
}

export function collectWhitelistedFiles(dataDir: string, agentDir: string): { files: PlannedSourceFile[]; excluded: { path: string; reason: "auth-file" }[] } {
  const files: PlannedSourceFile[] = [];
  const excluded: { path: string; reason: "auth-file" }[] = [];
  walkAllowedDirectory(path.join(dataDir, "sessions"), dataDir, files, excluded);
  walkAllowedDirectory(path.join(dataDir, "projects"), dataDir, files, excluded);
  const modelsPath = path.join(agentDir, "models.json");
  if (existsSync(modelsPath)) files.push({
    sourcePath: modelsPath,
    relativePath: agentDir === path.join(dataDir, ".pi-agent") ? ".pi-agent/models.json" : "agentDir/models.json",
    kind: "config",
  });
  return { files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)), excluded };
}

function defaultSessionReferences(db: DatabaseSync): readonly SessionFileReference[] {
  const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
  if (!table) return [];
  const rows = db.prepare("SELECT id, pi_session_file FROM sessions WHERE pi_session_file IS NOT NULL").all() as Array<{ id: unknown; pi_session_file: unknown }>;
  return rows.map((row) => {
    if (typeof row.id !== "string" || typeof row.pi_session_file !== "string") fail("sessions.pi_session_file contains a malformed value");
    return { sessionId: row.id, file: row.pi_session_file };
  });
}

/**
 * Official completed-live references must stay inside the whitelisted roots and
 * the payload collection. Missing references are recorded (missing-as-empty)
 * and never fail the backup; they are published in the manifest so the restore
 * can normalize the corresponding sessions.pi_session_file to NULL.
 */
/**
 * Bind a session-reference set to a payload plan without another directory walk.
 * References are read from the final DB snapshot; a file newly referenced between
 * the initial collection and that snapshot is added by its exact whitelisted
 * path. This closes the inspect→VACUUM reference gap without introducing a
 * whole-DATA_DIR scanner. Missing files remain explicit missing-as-empty rows.
 */
export function bindReferencesToPayload(references: readonly SessionFileReference[], dataDir: string, files: readonly PlannedSourceFile[]): { files: PlannedSourceFile[]; missing: MissingSessionReference[] } {
  const roots = [path.join(dataDir, "sessions"), path.join(dataDir, "projects")];
  const byPath = new Map(files.map((file) => [canonicalForComparison(file.sourcePath), file]));
  const missing: MissingSessionReference[] = [];
  const referenceKeys = new Set<string>();
  for (const reference of references) {
    if (typeof reference.sessionId !== "string" || reference.sessionId.length === 0 || !path.isAbsolute(reference.file)) fail("sessions.pi_session_file reference is malformed");
    const referenceKey = `${reference.sessionId}\u0000${reference.file}`;
    if (referenceKeys.has(referenceKey)) fail("sessions.pi_session_file references are not unique");
    referenceKeys.add(referenceKey);
    const resolved = canonicalForComparison(reference.file);
    if (!roots.some((root) => isWithin(root, resolved))) fail("sessions.pi_session_file points outside the whitelisted data roots");
    if (!resolved.endsWith(".jsonl")) fail("sessions.pi_session_file is not a .jsonl file");
    const relativePath = path.relative(dataDir, resolved).split(path.sep).join("/");
    if (!isExpectedSessionLayout(relativePath)) fail("sessions.pi_session_file has an unexpected session layout");
    if (!existsSync(resolved)) {
      missing.push({ sessionId: reference.sessionId, path: relativePath, status: "missing" });
      continue;
    }
    validateRegular(resolved, "referenced session file");
    if (!byPath.has(resolved)) byPath.set(resolved, { sourcePath: resolved, relativePath, kind: "jsonl" });
  }
  return { files: [...byPath.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)), missing };
}

export function validateReferences(references: readonly SessionFileReference[], dataDir: string, files: readonly PlannedSourceFile[]): MissingSessionReference[] {
  return bindReferencesToPayload(references, dataDir, files).missing;
}

function assertCanonicalSingleBaselineLedger(ledger: BackupManifest["migrationLedger"], label: string): void {
  if (!ledger.present) fail(`${label} has no authenticated migration ledger; refusing to create a backup`);
  try {
    const prefix = migrationPrefixForLedger(ledger as MigrationLedgerSnapshot);
    if (prefix.length !== 1 || prefix[0]!.version !== 0) {
      fail(`${label} is not the canonical single-baseline migration ledger; refusing to create a backup`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("backup:")) throw error;
    fail(`${label} is not the canonical single-baseline migration ledger; refusing to create a backup`);
  }
}

function migrationLedgerSummary(db: DatabaseSync): BackupManifest["migrationLedger"] {
  const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!table) fail("source SQLite migration ledger is missing; refusing to create a backup");
  const rows = db.prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version").all() as Array<{ version: unknown; name: unknown; checksum: unknown; applied_at: unknown }>;
  if (rows.some((row) => !Number.isSafeInteger(row.version) || Number(row.version) < 0 || typeof row.name !== "string" || typeof row.checksum !== "string" || row.checksum.length === 0 || !Number.isSafeInteger(row.applied_at) || Number(row.applied_at) < 0)) fail("migration ledger contains malformed rows");
  const normalized = rows.map((row) => ({ version: Number(row.version), name: row.name as string, checksum: row.checksum as string, applied_at: Number(row.applied_at) }));
  const ledger = { present: true, appliedCount: normalized.length, appliedVersion: normalized.length === 0 ? null : normalized.at(-1)!.version, checksums: normalized.map((row) => row.checksum), rows: normalized, pending: 0 };
  assertCanonicalSingleBaselineLedger(ledger, "source SQLite migration ledger");
  return ledger;
}

function sourceRootsSha256(sourceRoots: BackupSourceRoots): string {
  return createHash("sha256").update(stableSerialize(sourceRoots), "utf8").digest("hex");
}

/** Stat fingerprint (plus full-content SHA-256) of the exact source DB file. */
export function sqliteSourceBinding(dbPath: string): SqliteSourceBinding {
  const st = lstatSync(dbPath);
  if (st.isSymbolicLink() || !st.isFile()) fail("source SQLite database must be a regular non-link file for binding");
  if (st.nlink > 1) fail(`source SQLite database is a hardlink (nlink=${st.nlink})`);
  const fd = openNoFollow(dbPath, constants.O_RDONLY);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_SIZE);
    let size = 0;
    while (size < st.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, st.size - size), size);
      if (count === 0) fail("source SQLite database was truncated while fingerprinting");
      hash.update(buffer.subarray(0, count));
      size += count;
    }
    return {
      dialect: "sqlite",
      dev: statPart(st.dev), ino: statPart(st.ino), nlink: Number(st.nlink), mode: Number(st.mode),
      size: Number(st.size), mtimeMs: String(st.mtimeMs), sha256: hash.digest("hex"),
    };
  } finally { closeSync(fd); }
}

function fileBinding(file: string, label: string): SqliteSourceFileBinding {
  const fp = fingerprint(file);
  if (fp.exists && fp.sha256 === null) fail(`${label} could not be fingerprinted stably; refusing to bind a changing file`);
  return {
    exists: fp.exists,
    dev: fp.dev, ino: fp.ino, nlink: fp.nlink, mode: fp.mode, size: fp.size, mtimeMs: fp.mtimeNs,
    sha256: fp.sha256,
  };
}

/**
 * Full DB/WAL/SHM fingerprint for the owner-transfer recovery binding. Existence is part of
 * the binding; every existing file must hash stably (a concurrently growing
 * WAL fails the capture instead of being bound with an unstable hash).
 */
export function sqliteTreeBinding(dbPath: string): SqliteSourceTreeBinding {
  return {
    dialect: "sqlite",
    db: fileBinding(dbPath, "source SQLite database"),
    wal: fileBinding(`${dbPath}-wal`, "source SQLite WAL"),
    shm: fileBinding(`${dbPath}-shm`, "source SQLite SHM"),
  };
}

function assertFileBindingUnchanged(label: string, before: SqliteSourceFileBinding, after: SqliteSourceFileBinding): void {
  for (const key of ["exists", "dev", "ino", "nlink", "mode", "size", "mtimeMs", "sha256"] as const) {
    if (String(before[key]) !== String(after[key])) {
      fail(`the source SQLite ${label} changed after the backup was taken (${key} mismatch); refusing to reset a different/replaced database`);
    }
  }
}

/**
 * Post-snapshot stability gate (owner-transfer only): the main DB must be strictly
 * unchanged across the VACUUM INTO; a pre-existing WAL must remain
 * byte-identical (any concurrent commit fails); creation of an EMPTY (0-byte)
 * WAL by the snapshot's own read transaction is tolerated because it carries
 * no content; a pre-existing SHM keeps its identity (dev/ino/nlink/mode) while
 * its volatile wal-index content may legitimately be churned by the backup's
 * own read connection.
 */
function assertPreResetSnapshotStable(before: SqliteSourceTreeBinding, after: SqliteSourceTreeBinding): void {
  assertFileBindingUnchanged("database", before.db, after.db);
  if (before.wal.exists) {
    assertFileBindingUnchanged("WAL", before.wal, after.wal);
  } else if (after.wal.exists && after.wal.size !== 0) {
    fail("the source SQLite WAL gained content during the snapshot; refusing to publish an owner-transfer recovery backup over a concurrently written database");
  }
  if (before.shm.exists) {
    for (const key of ["exists", "dev", "ino", "nlink", "mode"] as const) {
      if (String(before.shm[key]) !== String(after.shm[key])) {
        fail(`the source SQLite SHM was replaced during the snapshot (${key} mismatch); refusing to publish an owner-transfer recovery backup`);
      }
    }
  }
}

/**
 * Re-validate a published SQLite tree binding against the current on-disk
 * state: any replacement (dev/ino), relink (nlink), permission change,
 * size/mtime change, content change, or appearance/disappearance of the main
 * DB or either sidecar fails — including WAL-only commits that the single-file
 * binding cannot see. Used by owner transfer before ownership mutation; a
 * mismatch must prevent the transfer.
 */
export function assertSqliteSourceTreeUnchanged(binding: SqliteSourceTreeBinding, dbPath: string): SqliteSourceTreeBinding {
  const current = sqliteTreeBinding(dbPath);
  assertFileBindingUnchanged("database", binding.db, current.db);
  assertFileBindingUnchanged("WAL", binding.wal, current.wal);
  assertFileBindingUnchanged("SHM", binding.shm, current.shm);
  return current;
}

/**
 * Re-validate a published SQLite binding against the current on-disk state:
 * any replacement (dev/ino), relink (nlink), permission change, size/mtime
 * change, or content change fails. Retained as a generic offline binding
 * verifier; it performs no reset or deletion.
 */
export function assertSqliteSourceBindingUnchanged(binding: SqliteSourceBinding, dbPath: string): SqliteSourceBinding {
  const current = sqliteSourceBinding(dbPath);
  for (const key of ["dev", "ino", "nlink", "mode", "size", "mtimeMs", "sha256"] as const) {
    if (String(binding[key]) !== String(current[key])) {
      fail(`the source SQLite database changed after the backup was taken (${key} mismatch); refusing to reset a different/replaced database`);
    }
  }
  return current;
}

export function writePrivate(file: string, bytes: Buffer | string): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeAll(fd, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)); fsyncSync(fd); }
  finally { closeSync(fd); }
  chmodSync(file, 0o600);
}

export function hashFile(file: string): { size: number; sha256: string } {
  const fd = openNoFollow(file, constants.O_RDONLY);
  try {
    const st = fstatSync(fd);
    if (!statIsRegularSingleLink(st)) fail("staged file is not a single-link regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_SIZE);
    let size = 0;
    while (size < st.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, st.size - size), size);
      if (count === 0) fail("staged file was truncated while hashing");
      hash.update(buffer.subarray(0, count)); size += count;
    }
    if (!sameFingerprint(fingerprintFromStats(st, null), fingerprintFromStats(fstatSync(fd), null))) fail("staged file changed while hashing");
    return { size, sha256: hash.digest("hex") };
  } finally { closeSync(fd); }
}

export function syncFileBestEffort(file: string): void {
  const fd = openNoFollow(file, constants.O_RDONLY);
  try { fsyncSync(fd); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") throw error;
  }
  finally { closeSync(fd); }
}

export function syncDirectoryBestEffort(directory: string): void {
  let fd: number | undefined;
  try { fd = openNoFollow(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)); fsyncSync(fd); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") throw error;
  }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Recursively fsync EVERY directory under `root`, deepest first
 * (payload leaves → payload root → publish root). Called on the ciphertext
 * publish staging tree BEFORE the COMPLETE marker is written, so that after a
 * crash no published package can reference a directory entry that is not
 * durable: every newly created ciphertext directory is synced before the
 * marker that makes the package consumable can exist.
 */
export function syncDirectoryTreeBestEffort(root: string): void {
  const directories: string[] = [root];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      // dirent.isDirectory() is false for symbolic links: never followed.
      if (entry.isDirectory()) {
        const child = path.join(directory, entry.name);
        directories.push(child);
        walk(child);
      }
    }
  };
  walk(root);
  for (const directory of directories.reverse()) syncDirectoryBestEffort(directory);
}

export async function encryptFileTo(outputRoot: string, relativePath: string, plaintextPath: string, plaintext: { size: number; sha256: string }, recipientFile: string, age: AgeAdapter, kind: BackupFileRecord["kind"], options?: AgeEncryptFileOptions): Promise<BackupFileRecord> {
  const output = path.join(outputRoot, relativePath);
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.tmp-${randomUUID()}`;
  try {
    if (age.encryptFile) await age.encryptFile(plaintextPath, temporary, recipientFile, options);
    else {
      if (!age.encrypt) fail("age adapter has no streaming encrypt operation");
      // Legacy injected adapters are test-only compatibility. The production
      // adapter above always uses the streaming path.
      const encrypted = Buffer.from(await age.encrypt(readFileSync(plaintextPath), recipientFile));
      if (encrypted.length === 0) fail("age returned an empty encrypted payload");
      writePrivate(temporary, encrypted);
    }
    validateRegular(temporary, "age output");
    const encrypted = hashFile(temporary);
    if (encrypted.size === 0) fail("age returned an empty encrypted payload");
    syncFileBestEffort(temporary);
    renameSync(temporary, output);
    syncDirectoryBestEffort(path.dirname(output));
    return { path: relativePath.split(path.sep).join("/"), kind, size: plaintext.size, sha256: plaintext.sha256, encryptedSize: encrypted.size, encryptedSha256: encrypted.sha256 };
  } finally { rmSync(temporary, { force: true }); }
}

/**
 * Read one whitelisted source stably into `plainRoot` (plaintext staging) and
 * publish its age ciphertext into `outputRoot` (ciphertext-only publish
 * staging inside the backup root). The plaintext copy is removed on every path.
 */
export async function encryptStableSource(plainRoot: string, outputRoot: string, item: PlannedSourceFile, recipient: string, age: AgeAdapter, options?: AgeEncryptFileOptions): Promise<BackupFileRecord> {
  let lastReason = "source changed during encryption";
  for (let attempt = 0; attempt < MAX_FILE_RETRIES; attempt++) {
    const prepared = await readStableSource(item, plainRoot);
    const plaintext = hashFile(prepared.plaintextPath);
    const candidate = `payload/${item.relativePath}.age`;
    try {
      const record = await encryptFileTo(outputRoot, candidate, prepared.plaintextPath, plaintext, recipient, age, item.kind, options);
      const after = fingerprint(item.sourcePath);
      if (!sameFingerprint(prepared.sourceFingerprint, after)) {
        lastReason = "source changed during encryption; encrypted candidate discarded";
        rmSync(path.join(outputRoot, candidate), { force: true });
        if (attempt + 1 < MAX_FILE_RETRIES) await backoff(attempt);
        continue;
      }
      return record;
    } finally { rmSync(prepared.plaintextPath, { force: true }); }
  }
  fail(`${lastReason}; exceeded ${MAX_FILE_RETRIES} stability attempts`);
}

/**
 * Create one private plaintext staging directory (0700). It is guaranteed to
 * stay outside the backup root and its parent (checked lexically before any
 * creation and canonically afterwards), so plaintext never touches the
 * published backup surface and the backup root's parent never needs to be
 * writable. Ciphertext-only publish staging lives inside the backup root
 * instead, keeping the final rename same-filesystem and atomic.
 */
function assertStagingOutsideBackupSurface(candidate: string, backupRoot: string): void {
  for (const [label, guarded] of [["backup root", backupRoot], ["backup root parent", path.dirname(backupRoot)]] as const) {
    if (isWithin(guarded, candidate)) {
      fail(`plaintext staging directory overlaps the ${label}; plaintext staging must stay outside the backup root and its parent`);
    }
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/**
 * Default root for the private plaintext staging directory.
 *
 * Deliberately NOT the OS temporary directory: shared temp roots are sticky
 * third-party surfaces by design, which is exactly the TOCTOU surface the
 * staging policy must exclude. The default is a per-user private directory
 * under the macOS Application Support directory
 * (`~/Library/Application Support/pi-agent-server-backup-staging`), created
 * 0700 on first use; its full ancestor chain is validated on every use
 * (see assertTrustedStagingAncestorChain). This staging directory is a
 * *temporary* plaintext working area — never the final encrypted backup
 * surface.
 */
export function defaultPlaintextStagingRoot(): string {
  return path.join(homedir(), "Library", "Application Support", "pi-agent-server-backup-staging");
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Single-component policy for the trusted staging ancestor chain. */
export function assertStagingAncestorStat(st: { isDirectory(): boolean; uid: number; mode: number }, label: string): void {
  if (!st.isDirectory()) fail(`plaintext staging ${label} is not a directory`);
  if ((Number(st.mode) & 0o1000) !== 0) fail(`plaintext staging ${label} must not be a sticky (shared) directory`);
  if ((Number(st.mode) & 0o022) !== 0) fail(`plaintext staging ${label} must not be group/world writable`);
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid && st.uid !== 0) {
    fail(`plaintext staging ${label} must be owned by the current user or root`);
  }
}

/**
 * Trust check for the COMPLETE ancestor chain of the staging root (evaluated
 * on the realpath canonicalization, which securePath has already guaranteed
 * to be symlink-free apart from the trusted system mount aliases): every
 * existing component from the filesystem root down to the root itself must
 * be a non-sticky, non-group/world-writable directory owned by the current
 * user or root. A shared sticky parent (classic 1777 /tmp) or a third-party
 * ancestor would let another user rename/replace staged paths — rejected.
 */
function assertTrustedStagingAncestorChain(canonicalRoot: string): void {
  let current = path.parse(canonicalRoot).root;
  const parts = canonicalRoot.slice(current.length).split(path.sep).filter(Boolean);
  // The filesystem root itself is always an existing component.
  assertStagingAncestorStat(lstatSync(current), "ancestor");
  for (const part of parts) {
    current = path.join(current, part);
    try {
      assertStagingAncestorStat(lstatSync(current), "ancestor");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

/**
 * Policy for the staging ROOT itself: current-user owned and fully private
 * (0700: no group/other bits at all, never sticky). This applies to the
 * default config root and to an explicitly configured root alike — an
 * explicit root must be a current-user 0700 directory.
 */
function assertStagingRootPolicy(root: string): void {
  const uid = currentUid();
  const check = (target: string): void => {
    const st = lstatSync(target);
    if (!st.isDirectory()) fail("plaintext staging root must be a directory");
    if ((Number(st.mode) & 0o1000) !== 0) fail("plaintext staging root must not be a sticky (shared) directory");
    if ((Number(st.mode) & 0o077) !== 0) fail("plaintext staging root must be private (0700: no group/other access)");
    if (uid !== undefined && st.uid !== uid) fail("plaintext staging root must be owned by the current user");
  };
  check(root);
  // The realpath canonicalization is the same inode (securePath has already
  // rejected symlink ancestors), but the reviewer-visible contract is on the
  // REALPATH root, so the policy is asserted against both spellings.
  check(realpathSync(root));
}

/** Stat policy re-check for the opened staging child directory. */
function assertStagingChildStat(st: ReturnType<typeof fstatSync>): void {
  if (!st.isDirectory()) fail("plaintext staging directory is not a directory");
  if ((Number(st.mode) & 0o777) !== 0o700) fail("plaintext staging directory must stay private (0700)");
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid) fail("plaintext staging directory must stay owned by the current user");
}

/** TOCTOU-safe handle over the freshly created private staging child. */
export interface PlaintextStagingHandle {
  readonly path: string;
  /**
   * Re-validate the staging directory before a sensitive operation: the held
   * directory FD must still describe a current-user 0700 directory, and a
   * fresh O_NOFOLLOW open of the path must resolve to the SAME inode
   * (dev+ino) — so a rename/substitution of the staging path between
   * operations is detected and fails closed.
   */
  revalidate(): void;
  close(): void;
}

/**
 * Create one private plaintext staging directory (0700) inside a trusted
 * private root and keep its directory FD open for the handle's lifetime.
 *
 * Root policy (default AND explicit): the root — and its full existing
 * ancestor chain — must be current-user/root owned, non-sticky, and without
 * group/world write bits; the root itself must be fully private (0700). The
 * default root is the per-user config staging root
 * (`~/Library/Application Support/pi-agent-server-backup-staging`, created
 * 0700 on first use); an explicit root must be an absolute current-user
 * 0700 directory. This is a temporary plaintext working area — the final
 * backup root holds only ciphertext. The staging root is
 * guaranteed to stay outside the backup root and its parent (checked lexically
 * before any creation and canonically afterwards), so plaintext never touches
 * the published backup surface. Ciphertext-only publish staging lives inside
 * the backup root instead, keeping the final rename same-filesystem and atomic.
 */
export function openPlaintextStaging(configured: string | undefined, backupRoot: string): PlaintextStagingHandle {
  // Strict validation of the ORIGINAL configured string, BEFORE any
  // path.resolve(): an explicitly configured root must be a non-blank
  // absolute path. A relative root would silently depend on the caller's cwd
  // and a blank value must never fall back to the default root — both are
  // rejected outright.
  if (configured !== undefined) {
    if (typeof configured !== "string" || configured.trim() === "") {
      fail("plaintext staging root must be a non-blank string when configured");
    }
    if (!path.isAbsolute(configured)) fail("plaintext staging root must be an absolute path");
  }
  // Resolution order: explicit option → PI_BACKUP_STAGING_ROOT (the same
  // variable the offline CLIs document; consulted here so library callers get
  // the same override) → the private per-user config staging root. A relative
  // env root is rejected instead of silently depending on the caller's cwd.
  const envRoot = configured === undefined ? nonBlank(process.env.PI_BACKUP_STAGING_ROOT) : undefined;
  if (envRoot !== undefined && !path.isAbsolute(envRoot)) {
    fail("PI_BACKUP_STAGING_ROOT must be an absolute path");
  }
  const root = configured !== undefined
    ? path.resolve(configured)
    : envRoot !== undefined ? path.resolve(envRoot) : defaultPlaintextStagingRoot();
  if (!path.isAbsolute(root)) fail("plaintext staging root must be an absolute path");
  securePath(root, "plaintext staging root");
  // Lexical pre-check: exact for a not-yet-existing root (a non-existent path
  // cannot contain symlinks), so a misconfigured root is usually rejected
  // without creating anything.
  assertStagingOutsideBackupSurface(root, backupRoot);
  const createdRoot = !existsSync(root);
  if (createdRoot) mkdirSync(root, { recursive: true, mode: 0o700 });
  let canonicalRoot: string;
  try {
    // Ownership/permission policy on the root BEFORE staging anything. A root
    // we just created is removed again; a pre-existing one is left untouched.
    assertStagingRootPolicy(root);
    canonicalRoot = realpathSync(root);
    // Full ancestor-chain trust check on the canonical spelling (covers the
    // home/.pi/agent config chain for the default root and the complete
    // explicit chain). Canonical check on the root BEFORE staging anything is
    // also authoritative against mount/symlink aliasing (e.g. macOS
    // /var -> /private/var) that the lexical pre-check cannot see.
    assertTrustedStagingAncestorChain(canonicalRoot);
    assertStagingOutsideBackupSurface(canonicalRoot, backupRoot);
  } catch (error) {
    if (createdRoot) rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const staging = mkdtempSync(path.join(canonicalRoot, ".pi-agent-backup-staging-"));
  chmodSync(staging, 0o700);
  try {
    // The verified object is exactly the inode this handle will use: the
    // directory FD is opened O_NOFOLLOW|O_DIRECTORY and kept for the whole
    // lifetime, so a symlink swap between mkdtemp and use cannot pass.
    const fd = openSync(staging, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      assertStagingChildStat(fstatSync(fd));
      // Belt-and-braces canonical overlap re-check.
      assertStagingOutsideBackupSurface(realpathSync(staging), backupRoot);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    return {
      path: staging,
      revalidate(): void {
        const held = fstatSync(fd);
        assertStagingChildStat(held);
        let probe: number;
        try {
          probe = openSync(staging, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
        } catch {
          fail("plaintext staging directory was removed or replaced before a sensitive operation");
        }
        try {
          const st = fstatSync(probe);
          if (st.dev !== held.dev || st.ino !== held.ino) {
            fail("plaintext staging directory was renamed/replaced before a sensitive operation (identity mismatch)");
          }
          assertStagingChildStat(st);
        } finally { closeSync(probe); }
      },
      close(): void { closeSync(fd); },
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Compatibility wrapper: create the private plaintext staging directory and
 * return only its path. Production callers use openPlaintextStaging so the
 * directory FD stays held and every sensitive operation can revalidate.
 */
export function createPlaintextStaging(configured: string | undefined, backupRoot: string): string {
  const handle = openPlaintextStaging(configured, backupRoot);
  handle.close();
  return handle.path;
}

function sourceTreeFingerprint(dbPath: string): Record<string, Fingerprint> {
  return Object.fromEntries([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((file) => [file, fingerprint(file)]));
}

function assertTreeUnchanged(before: Record<string, Fingerprint>, dbPath: string): void {
  const after = sourceTreeFingerprint(dbPath);
  for (const file of Object.keys(before)) if (!sameFingerprint(before[file]!, after[file]!)) fail("source SQLite DB/WAL/SHM changed during dry-run");
}

function openSource(dbPath: string): DatabaseSync {
  const stat = lstatSync(dbPath);
  if (!stat.isFile() || stat.nlink > 1) fail("source SQLite database must be a single-link regular file");
  try { return new DatabaseSync(dbPath, { readOnly: true, timeout: 5000, enableForeignKeyConstraints: true }); }
  catch { fail("source SQLite database could not be opened read-only"); }
}

/**
 * Read-only canonical-schema recoverability gate shared with restore's strict
 * verify. The source must be a canonical single-baseline database whose
 * complete current physical schema (tables / columns / PK / FK / indexes and
 * the ledger table's own physical contract) matches the immutable manifest.
 * A database that can be backed up but not restored fails here, before any
 * staging, encryption, or publication. The migration verify is strictly
 * read-only and never writes or checkpoints the source.
 */
async function assertSqliteSourceCanonical(db: DatabaseSync): Promise<void> {
  await runSqliteMigrations(db, { mode: "verify" });
}

async function inspectSource(options: BackupOptions, db: DatabaseSync, dataDir: string, agentDir: string): Promise<{ files: PlannedSourceFile[]; excluded: { path: string; reason: "auth-file" }[]; missing: MissingSessionReference[]; ledger: BackupManifest["migrationLedger"] }> {
  const collected = collectWhitelistedFiles(dataDir, agentDir);
  const query = options.querySessionReferences ?? defaultSessionReferences;
  const bound = bindReferencesToPayload(query(db), dataDir, collected.files);
  const ledger = migrationLedgerSummary(db);
  assertCanonicalSingleBaselineLedger(ledger, "source SQLite migration ledger");
  await assertSqliteSourceCanonical(db);
  return { files: bound.files, excluded: collected.excluded, missing: bound.missing, ledger };
}

/** Read the final SQLite snapshot only; exact referenced files can be appended without a second directory scan. */
async function inspectSqliteSnapshot(options: BackupOptions, snapshotPath: string, dataDir: string, initial: { readonly files: PlannedSourceFile[]; readonly excluded: { path: string; reason: "auth-file" }[] }): Promise<{ files: PlannedSourceFile[]; excluded: { path: string; reason: "auth-file" }[]; missing: MissingSessionReference[]; ledger: BackupManifest["migrationLedger"] }> {
  const snapshot = openSource(snapshotPath);
  try {
    const query = options.querySessionReferences ?? defaultSessionReferences;
    const bound = bindReferencesToPayload(query(snapshot), dataDir, initial.files);
    const ledger = migrationLedgerSummary(snapshot);
    assertCanonicalSingleBaselineLedger(ledger, "snapshot SQLite migration ledger");
    // The published snapshot is the database restore reads; it must satisfy the
    // same canonical physical-schema contract as the live source.
    await assertSqliteSourceCanonical(snapshot);
    return { files: bound.files, excluded: initial.excluded, missing: bound.missing, ledger };
  } finally { snapshot.close(); }
}

/** Create an encrypted, atomic SQLite backup. Offline explicit tool only. */
export async function createSqliteBackup(options: BackupOptions): Promise<BackupResult> {
  const dryRun = options.dryRun === true;
  const backupKind = options.backupKind ?? "sqlite-online";
  const age = options.age ?? ageAdapter;
  const now = options.now ?? (() => new Date());
  const resolved = validateTarget(options.paths);
  const sourceBefore = sourceTreeFingerprint(options.paths.dbPath);
  if (!sourceBefore[options.paths.dbPath]!.exists) fail("source SQLite database does not exist");
  const startedAt = now().toISOString();
  let source: DatabaseSync | undefined = openSource(options.paths.dbPath);
  let plainStaging: PlaintextStagingHandle | undefined;
  let publishStaging: string | undefined;
  let finalPath: string | undefined;
  // Original error of the failed backup; cleanup must never replace it.
  let backupError: unknown;
  const closeSource = (): void => {
    if (!source) return;
    const open = source;
    source = undefined;
    try { open.close(); } catch { /* preserve the original backup error */ }
  };
  try {
    const inspection = await inspectSource(options, source, resolved.dataDir, resolved.agentDir);
    // Missing session references are missing-as-empty: they are recorded in
    // the encrypted manifest and the backup still publishes (never fail).
    if (dryRun) {
      // Dry-run reads plaintext only, so it stages in the private plaintext
      // root too; the backup root is never created or written by a dry-run.
      plainStaging = openPlaintextStaging(options.stagingRoot, resolved.backupRoot);
      try {
        const files: BackupFileRecord[] = [];
        for (const item of inspection.files) {
          plainStaging.revalidate();
          const prepared = await readStableSource(item, plainStaging.path);
          const stat = hashFile(prepared.plaintextPath);
          rmSync(prepared.plaintextPath, { force: true });
          files.push({ path: `payload/${item.relativePath}.age`, kind: item.kind, size: stat.size, sha256: stat.sha256 });
        }
        assertTreeUnchanged(sourceBefore, options.paths.dbPath);
        files.unshift({ path: "payload/database.sqlite.age", kind: "sqlite-snapshot", size: 0, sha256: "(VACUUM INTO at create time)" });
        return { dryRun: true, finalPath: null, files, missingSessionReferences: inspection.missing, manifest: null, publishedIdentity: null };
      } finally { rmSync(plainStaging.path, { recursive: true, force: true }); plainStaging.close(); plainStaging = undefined; }
    }

    await age.ensureAvailable?.(options.paths.ageRecipientFile);
    // Plaintext staging is validated/created before the backup root or its
    // publish staging exist, so a misconfigured staging root is rejected
    // without materializing anything.
    plainStaging = openPlaintextStaging(options.stagingRoot, resolved.backupRoot);
    if (!existsSync(options.paths.backupRoot)) mkdirSync(options.paths.backupRoot, { recursive: true, mode: 0o700 });
    chmodSync(options.paths.backupRoot, 0o700);
    // Two staging surfaces:
    // 1. Publish staging lives INSIDE backupRoot and holds only ciphertext
    //    (payload/*.age, manifest.json.age, COMPLETE), so the final publish is
    //    one same-filesystem atomic rename. The backup root's parent is never
    //    touched and never needs to be writable.
    publishStaging = mkdtempSync(path.join(options.paths.backupRoot, ".pi-agent-backup-publish-"));
    chmodSync(publishStaging, 0o700);
    // 2. Plaintext staging (SQLite snapshot, JSONL copies, manifest plaintext)
    //    lives in a private per-user config staging root (default
    //    ~/Library/Application Support/pi-agent-server-backup-staging; full
    //    trusted ancestor chain), never in the backup root or its parent.
    //    This is a temporary plaintext working area; the final backup root
    //    holds only ciphertext. The staging directory FD stays
    //    held for the whole backup and is revalidated before every sensitive
    //    operation, so a path rename/substitution is detected and fails
    //    closed.
    const plainSnapshot = path.join(plainStaging.path, "database.sqlite");
    // Pre-reset binding: the DB/WAL/SHM state is fingerprinted immediately
    // before the snapshot is generated, re-checked right after the VACUUM
    // INTO completes, and then FIXED. The verified post-snapshot state becomes
    // the single immutable binding before any JSONL/age work runs; later
    // publish/reset steps only COMPARE against it (they may re-collect for
    // comparison, but never re-collect to replace the baseline). A WAL-only
    // write that slips in between the snapshot and the manifest therefore
    // fails the backup (and any later cutover) with zero deletion instead of
    // silently becoming the new baseline.
    // Pre-reset/pre-owner-transfer binding: the DB/WAL/SHM state is fingerprinted
    // immediately before the snapshot is generated, re-checked right after the
    // VACUUM INTO completes, and then FIXED. The verified post-snapshot state
    // becomes the single immutable binding before any JSONL/age work runs.
    const usesTreeBinding = backupKind === "pre-owner-transfer";
    const preSnapshot = usesTreeBinding ? sqliteTreeBinding(options.paths.dbPath) : null;
    plainStaging.revalidate();
    source.prepare("VACUUM INTO ?").run(plainSnapshot);
    let treeBinding: SqliteSourceTreeBinding | null = null;
    if (preSnapshot) {
      const postSnapshot = sqliteTreeBinding(options.paths.dbPath);
      assertPreResetSnapshotStable(preSnapshot, postSnapshot);
      treeBinding = postSnapshot;
    }
    validateRegular(plainSnapshot, "SQLite snapshot");
    // The DB snapshot, not the earlier live inspection, is authoritative for
    // session metadata. Add only exact newly referenced paths; do not run a
    // second directory scan. Every snapshot reference is therefore either a
    // payload or an explicit missing-as-empty manifest entry.
    const snapshotInspection = await inspectSqliteSnapshot(options, plainSnapshot, resolved.dataDir, inspection);
    const snapshot = hashFile(plainSnapshot);
    // Pre-reset closes its inspection connection before any payload work: the
    // binding is already fixed above, the source stays untouched from here on,
    // and a read-only close never checkpoints (verified: DB/WAL/SHM remain
    // byte-identical), so the publish-time comparison below sees the same
    // tree the binding pinned.
    if (preSnapshot) closeSource();
    const ageBudget = { timeoutMs: options.ageProcessTimeoutMs };
    const files: BackupFileRecord[] = [await encryptFileTo(publishStaging, "payload/database.sqlite.age", plainSnapshot, snapshot, options.paths.ageRecipientFile, age, "sqlite-snapshot", ageBudget)];
    rmSync(plainSnapshot, { force: true });
    for (const item of snapshotInspection.files) {
      plainStaging.revalidate();
      files.push(await encryptStableSource(plainStaging.path, publishStaging, item, options.paths.ageRecipientFile, age, ageBudget));
    }

    const finishedAt = now().toISOString();
    const roots = { dataDir: resolved.dataDir, agentDir: resolved.agentDir, dbPath: resolved.dbPath };
    const rootsHash = sourceRootsSha256(roots);
    // Snapshot-generation-time binding. For pre-owner-transfer this is the
    // immutable full DB/WAL/SHM tree fixed directly after VACUUM INTO; other
    // kinds keep the DB-only stat binding without a no-write requirement.
    const sourceBinding: SqliteSourceBinding = treeBinding
      ? { dialect: "sqlite", dev: treeBinding.db.dev, ino: treeBinding.db.ino, nlink: treeBinding.db.nlink, mode: treeBinding.db.mode, size: treeBinding.db.size, mtimeMs: treeBinding.db.mtimeMs, sha256: treeBinding.db.sha256! }
      : sqliteSourceBinding(options.paths.dbPath);
    const manifest: BackupManifest = {
      format: "pi-agent-server.backup-manifest.v1", kind: backupKind, dialect: "SQLite", createdAt: finishedAt,
      sourceRoots: roots,
      sourceBinding,
      ...(treeBinding ? { sourceTreeBinding: treeBinding } : {}),
      sourceRootsSha256: rootsHash,
      sourceRootsHash: rootsHash,
      timeWindow: { startedAt, finishedAt }, migrationLedger: snapshotInspection.ledger,
      credentials: { included: false, policy: "whitelist-excludes-credentials" },
      encryption: { format: "age-v1", recipients: resolved.recipients }, files,
      missingSessionReferences: snapshotInspection.missing, excludedFiles: snapshotInspection.excluded,
    };
    const manifestPath = path.join(plainStaging.path, ".manifest.json");
    plainStaging.revalidate();
    writePrivate(manifestPath, `${stableSerialize(manifest)}\n`);
    const manifestInfo = hashFile(manifestPath);
    plainStaging.revalidate();
    const encryptedManifest = await encryptFileTo(publishStaging, "manifest.json.age", manifestPath, manifestInfo, options.paths.ageRecipientFile, age, "config", ageBudget);
    rmSync(manifestPath, { force: true });
    // Crash durability gate: fsync every new ciphertext directory deepest
    // first (payload leaves → payload root → publish root) BEFORE the COMPLETE
    // marker is written, so a published package can never reference a
    // non-durable directory entry after a crash.
    syncDirectoryTreeBestEffort(publishStaging);

    const complete = path.join(publishStaging, "COMPLETE");
    // The marker remains the final write. New packages bind it to the manifest
    // ciphertext; empty markers remain accepted by restore for older WP3A sets.
    writePrivate(complete, `${encryptedManifest.encryptedSha256}\n`);
    syncDirectoryBestEffort(publishStaging);
    // Publish-time re-check against the immutable snapshot-time binding: any
    // DB/WAL/SHM change since the VACUUM INTO (including WAL-only commits that
    // happen after the snapshot but before this manifest/publish step) fails
    // the backup before the package is published, and would equally fail the
    // reset-time revalidation with zero deletion.
    if (treeBinding) assertSqliteSourceTreeUnchanged(treeBinding, options.paths.dbPath);
    finalPath = path.join(options.paths.backupRoot, `backup-${Date.now()}-${randomUUID()}`);
    renameSync(publishStaging, finalPath);
    publishStaging = undefined;
    syncDirectoryBestEffort(options.paths.backupRoot);
    const publishedIdentity: PublishedBackupIdentity = {
      manifestSha256: encryptedManifest.encryptedSha256 ?? fail("the encrypted manifest has no recorded ciphertext hash"),
      completeMarker: encryptedManifest.encryptedSha256!,
      sourceRootsSha256: rootsHash,
      sourceBindingSha256: sourceBindingSha256(manifest),
    };
    return { dryRun: false, finalPath, files, missingSessionReferences: snapshotInspection.missing, manifest, publishedIdentity };
  } catch (error) {
    backupError = error;
    if (finalPath) {
      // Best-effort removal of a partially published package: a removal
      // failure must not mask the original backup error.
      try { rmSync(finalPath, { recursive: true, force: true }); }
      catch { /* the original error is reported below */ }
    }
    throw error;
  } finally {
    // Independent per-item cleanup (plaintext staging, publish staging,
    // source connection): every item runs in its own try/catch so one
    // failure (e.g. rm EPERM) can neither skip the remaining items nor
    // replace the original backup error. On the SUCCESS path a cleanup
    // failure fails closed instead of leaving plaintext/publish leftovers.
    const cleanupErrors: unknown[] = [];
    if (plainStaging) {
      const target = plainStaging;
      plainStaging = undefined;
      try { rmSync(target.path, { recursive: true, force: true }); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
      try { target.close(); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (publishStaging) {
      const target = publishStaging;
      publishStaging = undefined;
      try { rmSync(target, { recursive: true, force: true }); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    closeSource();
    if (backupError !== undefined) throw backupError;
    if (cleanupErrors.length > 0) {
      fail(`cleanup failed after the backup: ${cleanupErrors.map((cleanupError) => cleanupError instanceof Error ? cleanupError.message : String(cleanupError)).join("; ")}`);
    }
  }
}

/**
 * Spawn exactly one age child. Test-only injectable spawn keeps production on
 * the real `child_process.spawn`; `tests/backup/age-stream.test.ts` uses it to
 * deterministically replay stream/child event orderings that are racy with a
 * real binary (notably child `close` winning over output `finish`).
 */
export type AgeSpawn = typeof spawn;

/** Best-effort SIGKILL of the running age child, used by stage-timeout aborts. */
let activeAgeChild: ReturnType<typeof spawn> | undefined;
export function abortActiveAgeChild(): void {
  const child = activeAgeChild;
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

function spawnAge(args: readonly string[], input: Buffer | undefined, _outputPath: string | undefined, versionOnly: boolean, timeoutMs: number = AGE_PROCESS_TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("age", [...args], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let settled = false;
    // Confirmed-close flags: the close handler and the spawn-error handler set
    // these BEFORE failOnce runs, so the deferred teardown below never waits on
    // a close event that already fired (or a child that never spawned).
    let childClosed = false;
    let spawnFailed = false;
    const failOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeAgeChild === child) activeAgeChild = undefined;
      try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch { /* already gone */ }
      // Detach instead of destroy: buffered stdout must not emit post-settle errors.
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.stdin.removeAllListeners();
      // Defer the rejection until the CONFIRMED child close (process reaped
      // plus stdio streams closed): reaching this path means a timeout/failure
      // fired a kill, and returning earlier would hand the caller an error
      // while the killed child may still be alive. A child that never spawned
      // or already closed counts as confirmed immediately.
      if (spawnFailed || childClosed) {
        reject(error);
        return;
      }
      child.once("close", () => reject(error));
    };
    const timer = setTimeout(() => {
      failOnce(new Error(versionOnly ? "age binary is unavailable" : `age encryption exceeded the ${timeoutMs}ms safety budget`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.resume();
    // age exits before stdin EOF on every failure path; without this handler
    // the EPIPE on child.stdin would surface as an uncaught 'error' event.
    child.stdin.on("error", () => failOnce(new Error(versionOnly ? "age binary is unavailable" : "age encryption failed")));
    child.once("error", () => {
      spawnFailed = true;
      failOnce(new Error(versionOnly ? "age binary is unavailable" : "age encryption failed"));
    });
    child.once("close", (code) => {
      childClosed = true;
      if (code === 0) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (activeAgeChild === child) activeAgeChild = undefined;
        resolve(Buffer.concat(stdout));
        return;
      }
      failOnce(new Error(versionOnly ? "age binary is unavailable" : "age encryption failed"));
    });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

export function spawnAgeFile(
  args: readonly string[],
  inputPath: string,
  outputPath: string,
  timeoutMs: number = AGE_PROCESS_TIMEOUT_MS,
  spawnImpl: AgeSpawn = spawn,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl("age", [...args], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      reject(new Error("age encryption failed"));
      return;
    }
    activeAgeChild = child;
    const input = createReadStream(inputPath, { mode: 0o600 });
    const output = createWriteStream(outputPath, { mode: 0o600 });
    let settled = false;
    // Success requires ALL THREE edges, in any order: the plaintext was fully
    // consumed (input 'end'), the age child exited cleanly ('close' code 0),
    // and the ciphertext is fully flushed to the output file ('finish').
    // The child's 'close' event can legitimately fire before the output
    // stream's 'finish' (disk flush latency under load), so both events are
    // awaited independently. The previous finish→close nesting missed 'close'
    // when it won that race and then hung until the safety budget fired —
    // reporting a timeout for an encryption that had actually succeeded.
    let inputEnded = false;
    let childClosed = false;
    let exitCode: number | null | undefined;
    let outputFinished = false;
    // Confirmed-close flags for the failure/teardown path: the close/error
    // handlers below set them so a delayed rejection never waits on an event
    // that already fired (or on a child that never spawned).
    let inputClosed = false;
    let outputClosed = false;
    let spawnFailed = false;
    const timer = setTimeout(() => {
      failOnce(new Error(`age encryption exceeded the ${timeoutMs}ms safety budget`));
    }, timeoutMs);
    const failOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeAgeChild === child) activeAgeChild = undefined;
      try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch { /* already gone */ }
      // Destroy every open handle so a timeout/failure leaks neither streams
      // nor file descriptors; the partial ciphertext is never publishable.
      input.destroy();
      output.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      rmSync(outputPath, { force: true });
      // Confirmed teardown before the error surfaces: SIGKILL is delivered
      // asynchronously and the child's 'close' (process reaped + stdio streams
      // closed) plus the destroyed input/output 'close' (file descriptors
      // released) can each trail the kill by a macrotask or more. Rejecting
      // earlier would hand the caller an error while the child or a stream may
      // still be alive, so the rejection is deferred until all three edges are
      // confirmed closed. Edges that already closed (or a child that never
      // spawned) are counted immediately.
      let teardownPending = 3;
      const teardown = (): void => {
        teardownPending -= 1;
        if (teardownPending > 0) return;
        reject(error);
        // A createWriteStream open can still complete on the threadpool after
        // the destroy above (the open syscall already ran) and re-create the
        // file; sweep it once more on the next macrotask.
        setTimeout(() => rmSync(outputPath, { force: true }), 0);
      };
      const expectClose = (emitter: NodeJS.EventEmitter, alreadyClosed: () => boolean): void => {
        if (alreadyClosed()) {
          teardown();
          return;
        }
        emitter.once("close", teardown);
      };
      expectClose(child, () => spawnFailed || childClosed);
      expectClose(input, () => inputClosed);
      expectClose(output, () => outputClosed);
    };
    const settle = () => {
      if (settled) return;
      if (!(inputEnded && childClosed && outputFinished)) return;
      settled = true;
      clearTimeout(timer);
      if (activeAgeChild === child) activeAgeChild = undefined;
      if (exitCode === 0) {
        resolve();
        return;
      }
      rmSync(outputPath, { force: true });
      reject(new Error("age encryption failed"));
    };
    input.once("end", () => { inputEnded = true; settle(); });
    input.once("close", () => { inputClosed = true; });
    input.once("error", () => failOnce(new Error("age input read failed")));
    output.once("finish", () => { outputFinished = true; settle(); });
    output.once("close", () => { outputClosed = true; });
    output.once("error", () => failOnce(new Error("age output write failed")));
    // age exits before stdin EOF on every failure path; without this handler
    // the EPIPE on child.stdin would surface as an uncaught 'error' event.
    child.stdin?.on("error", () => failOnce(new Error("age encryption failed")));
    child.stdout?.pipe(output);
    child.stderr?.resume();
    child.once("error", () => {
      spawnFailed = true;
      failOnce(new Error("age encryption failed"));
    });
    child.once("close", (code) => {
      childClosed = true;
      exitCode = code;
      settle();
    });
    if (child.stdin) input.pipe(child.stdin); else failOnce(new Error("age encryption failed"));
  });
}

/**
 * Digest over the manifest's authenticated source binding: the full SQLite
 * DB/WAL/SHM tree when present, otherwise the single-file stat binding
 * (PostgreSQL manifests bind their cluster/database/schema identity).
 */
export function sourceBindingSha256(manifest: AnyBackupManifest): string {
  const binding = manifest.dialect === "SQLite"
    ? ((manifest.sourceTreeBinding ?? manifest.sourceBinding) as unknown)
    : (manifest.postgres as unknown);
  return createHash("sha256").update(stableSerialize(binding), "utf8").digest("hex");
}

/** Recomputed digest over a manifest's canonical source roots. */
function recomputedRootsSha256(sourceRoots: unknown): string {
  return createHash("sha256").update(stableSerialize(sourceRoots), "utf8").digest("hex");
}

/**
 * Verify the published package after creation and before a destructive caller
 * proceeds. This checks the atomic marker, manifest ciphertext, and every
 * encrypted payload's size/hash, and re-binds all of it to the creation-time
 * identity returned by create*Backup: a manifest ciphertext or COMPLETE marker
 * replaced after creation, or a manifest whose roots/binding digest no longer
 * matches what was created, fails here — without ever decrypting the manifest
 * with a private identity.
 */
export function verifyPublishedBackup(result: {
  readonly dryRun: boolean;
  readonly finalPath: string | null;
  readonly manifest: AnyBackupManifest | null;
  readonly publishedIdentity?: PublishedBackupIdentity | null;
}): PublishedBackupVerification {
  if (result.dryRun || !result.finalPath || !result.manifest) fail("pre-migration/pre-owner-transfer backup is not a published package");
  if (!result.publishedIdentity) fail("the backup result carries no creation-time published identity; refusing to verify a package that cannot be bound to its creation");
  const finalPath = result.finalPath;
  const manifestPath = path.join(finalPath, "manifest.json.age");
  const completePath = path.join(finalPath, "COMPLETE");
  validateRegular(manifestPath, "published encrypted manifest");
  validateRegular(completePath, "published COMPLETE marker");
  const manifestInfo = hashFile(manifestPath);
  const marker = readFileSync(completePath, "utf8").trim();
  // Creation-time binding first: a replaced manifest ciphertext or COMPLETE
  // marker is reported as a post-creation replacement, not a generic mismatch.
  if (manifestInfo.sha256 !== result.publishedIdentity.manifestSha256) {
    fail("published manifest ciphertext was replaced after creation; refusing to consume the package");
  }
  if (marker !== result.publishedIdentity.completeMarker) {
    fail("published COMPLETE marker was replaced after creation; refusing to consume the package");
  }
  if (marker !== manifestInfo.sha256) fail("published COMPLETE marker does not match the manifest");
  if (result.manifest.kind !== "pre-migration" && result.manifest.kind !== "pre-owner-transfer") fail("pre-owner-transfer/migration pre-backup has the wrong kind");
  if (result.manifest.format !== "pi-agent-server.backup-manifest.v1" || result.manifest.files.length === 0) fail("published backup manifest is incomplete");
  if (!result.manifest.sourceRoots || typeof result.manifest.sourceRoots !== "object") fail("published backup manifest has no authenticated source roots");
  const rootsDigest = recomputedRootsSha256(result.manifest.sourceRoots);
  if (rootsDigest !== result.manifest.sourceRootsSha256 || rootsDigest !== result.manifest.sourceRootsHash || rootsDigest !== result.publishedIdentity.sourceRootsSha256) {
    fail("published backup source roots do not match the creation-time digest");
  }
  if (sourceBindingSha256(result.manifest) !== result.publishedIdentity.sourceBindingSha256) {
    fail("published backup source binding does not match the creation-time digest");
  }
  for (const record of result.manifest.files) {
    if (!record.path.startsWith("payload/") || record.path.includes("..")) fail("published backup manifest contains an unsafe payload path");
    const payload = path.join(finalPath, record.path);
    validateRegular(payload, "published encrypted payload");
    const info = hashFile(payload);
    if (info.size !== record.encryptedSize || info.sha256 !== record.encryptedSha256 || info.size === 0) fail("published encrypted payload hash or size mismatch");
  }
  if (result.manifest.dialect === "SQLite") {
    return {
      id: path.basename(finalPath),
      kind: result.manifest.kind,
      checksum: manifestInfo.sha256,
      version: result.manifest.migrationLedger.appliedVersion,
      sourceRoots: result.manifest.sourceRoots,
      sqliteTarget: result.manifest.sourceBinding,
      sqliteTreeBinding: result.manifest.sourceTreeBinding ?? null,
      postgres: null,
    };
  }
  return {
    id: path.basename(finalPath),
    kind: result.manifest.kind,
    checksum: manifestInfo.sha256,
    version: result.manifest.migrationLedger.appliedVersion,
    sourceRoots: result.manifest.sourceRoots,
    sqliteTarget: null,
    sqliteTreeBinding: null,
    postgres: result.manifest.postgres,
  };
}

export const BACKUP_MAX_FILE_RETRIES = MAX_FILE_RETRIES;
export { isWithin };
export {
  assertPostgresClientServerMajor,
  assertPostgresToolMajorMatch,
  createPgProcessAdapter,
  createPostgresBackup,
  parseClientMajor,
  parseServerVersionNumMajor,
  parseVersion,
  queryPostgresServerMajor,
} from "./postgres-backup-core.js";
export type { PostgresBackupOptions, PostgresBackupPaths, PostgresBackupResult, PgBackupClient, PgBackupPool, PgBackupPoolClient, PgProcessAdapter, PgProcessRequest, PgProcessResult } from "./postgres-backup-core.js";
