import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir, homedir } from "node:os";
import { createPostgresPool } from "../storage/postgres-bootstrap.js";
import type { Pool } from "pg";
import {
  abortActiveAgeChild,
  ageAdapter,
  assertStrictCompleteness,
  collectWhitelistedFiles,
  encryptFileTo,
  encryptStableSource,
  hashFile,
  openPlaintextStaging,
  syncDirectoryBestEffort,
  syncDirectoryTreeBestEffort,
  validateReferences,
  validateRegular,
  writePrivate,
  type AgeAdapter,
  type AgeEncryptFileOptions,
  type BackupFileRecord,
  type MissingSessionReference,
  type PlaintextStagingHandle,
  type PlannedSourceFile,
  type PostgresBackupManifest,
  type PostgresBackupSourceRoots,
  type PublishedBackupIdentity,
} from "./backup-core.js";
import { stableSerialize } from "../storage/migration-manifest.js";
import {
  BACKUP_STAGE_BUDGET_MS,
  withStageTimeout,
  type StageReporter,
} from "./stage-guard.js";

const PG_PROCESS_TIMEOUT_MS = 120_000;
const PG_STDERR_MAX_BYTES = 4 * 1024;
const VERSION_PATTERN = /^(pg_dump|pg_restore) \(PostgreSQL\) (\S+)/m;
const CLIENT_VERSION_PATTERN = /^(\d+)(?:\.(\d+))+(?:[-+._A-Za-z0-9]*)?$/;
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_SHA256 = /^[0-9a-f]{64}$/;

export interface PgBackupClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>;
  end?: () => Promise<void>;
}

/** One dedicated connection leased from a pool; release() returns it. */
export interface PgBackupPoolClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>;
  release?(err?: Error): void;
}

/** Minimal pool face: the backup leases exactly one dedicated client. */
export interface PgBackupPool {
  connect(): Promise<PgBackupPoolClient>;
}

export interface PgProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  /** Sanitized libpq environment. It deliberately has no PI_DATABASE_URL/PGPASSWORD. */
  readonly env: NodeJS.ProcessEnv;
  readonly stdoutPath?: string;
  readonly stdinPath?: string;
  readonly timeoutMs: number;
}

export interface PgProcessResult {
  readonly code: number | null;
  readonly signal?: string;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

/** Injectable process boundary: tests can emulate pg_dump/pg_restore without system binaries. */
export interface PgProcessAdapter {
  run(request: PgProcessRequest): Promise<PgProcessResult>;
  /** Best-effort SIGKILL of the currently running child (used by stage timeout cleanup). */
  abort?: () => void | Promise<void>;
}

function fail(message: string): never {
  throw new Error(`backup: ${message}`);
}

function genericProcessError(command: string): Error {
  return new Error(`backup: ${command} failed`);
}

function tailBuffer(chunks: readonly Buffer[], incoming: Buffer, limit: number): Buffer {
  const chunk = incoming.length > limit ? incoming.subarray(incoming.length - limit) : incoming;
  const combined = Buffer.concat([...chunks, chunk]);
  return combined.length > limit ? combined.subarray(combined.length - limit) : combined;
}

/**
 * Redact process diagnostics before they become an Error. PostgreSQL tools can
 * echo libpq connection details and local paths, and their stderr is not a
 * trusted logging channel. Keep only the tail because the beginning is often
 * an unbounded server/banner dump.
 */
export function redactPgDiagnostic(stderr: Buffer | string, sensitiveValues: readonly string[] = []): string {
  const bytes = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr, "utf8");
  let message = bytes.length > PG_STDERR_MAX_BYTES
    ? bytes.subarray(bytes.length - PG_STDERR_MAX_BYTES).toString("utf8")
    : bytes.toString("utf8");
  // Do not let control characters from a child process become terminal output.
  message = message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");

  const environmentSecretNames = [
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "AZURE_OPENAI_API_KEY",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GITHUB_TOKEN",
    "PI_AUTH_TOKEN", "PGPASSWORD",
  ];
  const values = [...new Set([
    ...sensitiveValues,
    ...environmentSecretNames.map((name) => process.env[name]),
  ].filter((value): value is string => typeof value === "string" && value.length > 0))]
    .sort((left, right) => right.length - left.length);
  for (const value of values) message = message.split(value).join("[redacted]");

  // A URL is sensitive even when its credentials are not present in the
  // caller's environment (for example, a server error echoed the target URL).
  message = message.replace(/postgres(?:ql)?:\/\/[^\s"'`<>]+/gi, "[redacted database URL]");
  // Cover libpq-style diagnostics and env dumps not caught by a known value.
  // Match the complete variable name: matching only PASSWORD/API_KEY would
  // miss PGPASSWORD/OPENAI_API_KEY because the preceding underscore is a word
  // character. This is intentionally shared with the outbox error boundary.
  message = message.replace(/(\b(?:OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|PGPASSWORD|PGPASSFILE|[A-Z][A-Z0-9]*(?:_(?:API_KEY|SECRET(?:_ACCESS_KEY)?|PASSWORD|PASSWD|TOKEN|ACCESS_KEY_ID|PRIVATE_KEY)))\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]");
  message = message.replace(/(\b(?:password|passwd|pwd)\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted password]");
  message = message.replace(/(\b(?:password|passwd|pwd)\s+(?!authentication\b))(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted password]");
  message = message.replace(/(\bpassword authentication failed for user\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted user]");
  message = message.replace(/(\b(?:user|username|role|login)\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted user]");
  message = message.replace(/(\b(?:user|username|role)\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted user]");
  // Absolute paths can contain usernames, database names, and PGPASSFILE
  // locations. Handle quoted paths first so spaces cannot expose a suffix;
  // URL redaction runs first so its slash is not mistaken for one.
  message = message.replace(/(["'])(\/[^"']+|[A-Za-z]:\\[^"']+)\1/g, "$1[redacted path]$1");
  message = message.replace(/(?:\/[^\s"'`<>]+|[A-Za-z]:\\[^\s"'`<>]+)/g, "[redacted path]");
  const redacted = Buffer.from(message.trim(), "utf8");
  return redacted.length > PG_STDERR_MAX_BYTES
    ? redacted.subarray(redacted.length - PG_STDERR_MAX_BYTES).toString("utf8")
    : redacted.toString("utf8");
}

function processStatus(result: PgProcessResult): string {
  return `exit=${result.code === null ? "null" : result.code}, signal=${result.signal ?? "none"}`;
}

function processFailure(command: string, result: PgProcessResult, sensitiveValues: readonly string[]): Error {
  const diagnostic = redactPgDiagnostic(result.stderr, sensitiveValues);
  return new Error(`backup: ${command} failed (${processStatus(result)})${diagnostic ? `: ${diagnostic}` : ""}`);
}

/** Production process runner. No shell is involved and dump bytes are streamed to a private file. */
/**
 * Create the production PG process runner. `spawnImpl` is injectable so tests
 * can replay real child lifecycle orderings (notably a `close` event that
 * trails the timeout `kill` — the delayed-close contract). The shared
 * `activePgChild` abort handle is per-adapter.
 */
export function createPgProcessAdapter(spawnImpl: typeof spawn = spawn): PgProcessAdapter {
  let activePgChild: ReturnType<typeof spawn> | undefined;
  // Per-run kill state, reachable from abort(): an OUTER abort() (backup-stage
  // timeout) is a SIGKILL exactly like the internal budget. After either fires,
  // a later 'error' event from the child is a kill/runtime error and must NOT
  // settle the run — only the CONFIRMED 'close' may hand the killed result back.
  let activeRun: { killInitiated: boolean } | undefined;
  return {
    run(request): Promise<PgProcessResult> {
      return new Promise((resolve, reject) => {
        let stdoutFd: number | undefined;
        let stdinFd: number | undefined;
        try {
          if (request.stdoutPath) stdoutFd = openSync(request.stdoutPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
          if (request.stdinPath) stdinFd = openSync(request.stdinPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        } catch {
          if (stdoutFd !== undefined) closeSync(stdoutFd);
          if (stdinFd !== undefined) closeSync(stdinFd);
          reject(genericProcessError(request.command));
          return;
        }

        // The opened descriptor must be the child's stdout. Using "ignore" here
        // silently discarded the archive while still returning success.
        const stdout = stdoutFd ?? "pipe";
        const stdin = request.stdinPath ? stdinFd! : "ignore";
        let child: ReturnType<typeof spawn>;
        try {
          child = spawnImpl(request.command, [...request.args], {
            shell: false,
            env: request.env,
            stdio: [stdin, stdout, "pipe"],
          });
        } catch {
          if (stdoutFd !== undefined) closeSync(stdoutFd);
          if (stdinFd !== undefined) closeSync(stdinFd);
          reject(genericProcessError(request.command));
          return;
        }
        if (stdoutFd !== undefined) closeSync(stdoutFd);
        if (stdinFd !== undefined) closeSync(stdinFd);
        activePgChild = child;
        const runState: { killInitiated: boolean } = { killInitiated: false };
        activeRun = runState;
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => {
          // Keep the useful tail, not an unbounded server/banner prefix. The
          // bytes are redacted before they are placed in an Error.
          const tail = tailBuffer(stderrChunks, chunk, PG_STDERR_MAX_BYTES);
          stderrChunks.length = 0;
          if (tail.length > 0) stderrChunks.push(tail);
        });
        let settled = false;
        // Set when a SIGKILL fires (internal budget OR outer abort()): a later
        // 'error' event is then a runtime/kill error and must NOT settle the
        // promise early — only the CONFIRMED 'close' may hand the killed result
        // back.
        const timer = setTimeout(() => {
          if (settled) return;
          // Internal budget exhausted: SIGKILL the hung child, but do NOT
          // report yet. The result (code null / signal SIGKILL) is handed to
          // the caller only after the CONFIRMED 'close' proves the process was
          // reaped AND its stdio streams are closed — the close handler below
          // resolves with exactly that result. Rejecting/resolving earlier
          // would let the caller act while the killed child may still run.
          runState.killInitiated = true;
          try { child.kill("SIGKILL"); } catch { /* already gone; close follows */ }
        }, request.timeoutMs);
        const close = (code: number | null, signal?: NodeJS.Signals | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (activePgChild === child) { activePgChild = undefined; activeRun = undefined; }
          resolve({ code, signal: signal ?? undefined, stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks) });
        };
        // A spawn error (e.g. ENOENT) means the process never started: there
        // is nothing to reap or wait for, so the rejection is immediate. An
        // 'error' that surfaces AFTER a kill fired (internal budget OR outer
        // abort) is a runtime/kill error: it may only settle via the confirmed
        // 'close' below (never while the killed child may still be running), so
        // it is deliberately not settled here.
        child.once("error", () => {
          if (settled) return;
          if (runState.killInitiated) return;
          settled = true;
          clearTimeout(timer);
          if (activePgChild === child) { activePgChild = undefined; activeRun = undefined; }
          reject(genericProcessError(request.command));
        });
        child.once("close", close);
      });
    },
    abort(): void {
      const child = activePgChild;
      const runState = activeRun;
      if (child && runState && child.exitCode === null && child.signalCode === null) {
        // Mark the kill state BEFORE killing: a kill that trails an outer
        // timeout must leave the run settling ONLY via the confirmed 'close'.
        // A later 'error' (kill/runtime error) must not hand the caller
        // anything while the killed child may still be running.
        runState.killInitiated = true;
        try { child.kill("SIGKILL"); } catch { /* already gone; close follows */ }
      }
    },
  };
}

export const pgProcessAdapter = createPgProcessAdapter();

export interface PostgresBackupPaths {
  readonly dataDir: string;
  readonly agentDir?: string;
  /** Actual credential file location (PI_AUTH_PATH or server default); see BackupPaths.authPath. */
  readonly authPath?: string;
  readonly backupRoot: string;
  readonly ageRecipientFile: string;
}

export interface PostgresBackupOptions {
  /** The published manifest kind. Pre-migration is only selected by the offline migration CLI; pre-reset only by the offline cutover CLI. */
  readonly backupKind?: "postgresql" | "pre-migration" | "pre-reset";
  /** Must be the literal explicit dialect selection, never an implicit default. */
  readonly storageDialect: string;
  /** Explicit PI_DATABASE_URL value. It is used only to construct the client. */
  readonly databaseUrl: string;
  readonly paths: PostgresBackupPaths;
  readonly dryRun?: boolean;
  /**
   * Opt-in strict completeness gate (CLI: `--require-complete-session-references`).
   * When true, ANY missing whitelisted session reference fails the backup
   * fail-closed BEFORE any publish/COMPLETE (dry-run included), with a stable
   * desensitized error (count only). The gate is bound to the FINAL snapshot:
   * PostgreSQL reads references inside the same dedicated REPEATABLE READ
   * transaction that exports the pg_dump snapshot, so there is no
   * inspect→snapshot online-write window (SQLite re-reads the reference set
   * from the finished VACUUM INTO snapshot instead). Default (absent/false)
   * keeps the legacy compatible behavior: missing references are recorded in
   * the encrypted manifest and the backup still publishes.
   */
  readonly requireCompleteSessionReferences?: boolean;
  readonly age?: AgeAdapter;
  /** Hard per-child age budget; defaults to AGE_PROCESS_TIMEOUT_MS (see its sizing note in backup-core). */
  readonly ageProcessTimeoutMs?: number;
  readonly pgClient?: PgBackupClient;
  /**
   * Pool face for leasing the dedicated transaction client. When absent, an
   * internal bounded pool is created (or an injected `pgClient` is wrapped as
   * a one-client pool, which is same-connection by construction).
   */
  readonly pgPool?: PgBackupPool;
  readonly pgProcess?: PgProcessAdapter;
  readonly pgDumpBinary?: string;
  /** Matching pg_restore binary used for archive preflight; defaults to PATH. */
  readonly pgRestoreBinary?: string;
  readonly now?: () => Date;
  /**
   * Explicit root for the PRIVATE plaintext staging directory (pg_dump
   * output, JSONL copies, manifest plaintext). Must be an absolute directory
   * path; when blank/absent the OS temporary directory is used. Plaintext
   * staging never lives in (or contains) the backup root or its parent, and
   * the backup root's parent never needs to be writable.
   */
  readonly stagingRoot?: string;
  readonly querySessionReferences?: (client: PgBackupClient, schema: string) => Promise<readonly { readonly sessionId: string; readonly file: string }[]>;
  /** Stage progress reporter: the gate CLI prints which external step is running. */
  readonly onStage?: StageReporter;
  /** Per-stage bounded budgets; defaults to BACKUP_STAGE_BUDGET_MS. */
  readonly stageTimeoutMs?: Partial<Record<keyof typeof BACKUP_STAGE_BUDGET_MS, number>>;
}

export interface PostgresBackupResult {
  readonly dryRun: boolean;
  readonly finalPath: string | null;
  readonly files: readonly BackupFileRecord[];
  readonly missingSessionReferences: readonly MissingSessionReference[];
  readonly manifest: PostgresBackupManifest | null;
  /** Creation-time identity of the published package (null for dry-run). */
  readonly publishedIdentity: PublishedBackupIdentity | null;
}

type PgIdentity = { readonly database: string; readonly schema: string; readonly user: string };
type PgLedgerRow = { version: number; name: string; checksum: string; applied_at: number };

export type ParsedPgUrl = {
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly username: string | undefined;
  readonly password: string | undefined;
  readonly sslmode: string | undefined;
};

function decodePart(value: string, label: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.includes("\0") || /[\r\n]/.test(decoded)) fail(`PostgreSQL ${label} is invalid`);
    return decoded;
  } catch {
    fail(`PostgreSQL ${label} is invalid`);
  }
}

/** Parse only the libpq URL fields that can be represented safely as env values. */
export function parsePostgresConnectionUrl(value: string): ParsedPgUrl {
  if (typeof value !== "string" || value.trim() === "") fail("PostgreSQL database URL is required");
  let url: URL;
  try { url = new URL(value); } catch { fail("PostgreSQL database URL is invalid"); }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") fail("PostgreSQL database URL has an unsupported protocol");
  if (url.hash || url.pathname === "/" || !url.pathname.startsWith("/")) fail("PostgreSQL database URL must name a database");
  const host = decodePart(url.hostname.replace(/^\[|\]$/g, ""), "host");
  if (!host || host === "localhost" && url.hostname === "") fail("PostgreSQL database URL host is invalid");
  const portNumber = url.port === "" ? 5432 : Number(url.port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) fail("PostgreSQL database URL port is invalid");
  const database = decodePart(url.pathname.slice(1), "database");
  if (database.includes("/")) fail("PostgreSQL database URL database is invalid");
  const username = url.username ? decodePart(url.username, "username") : undefined;
  const password = url.password ? decodePart(url.password, "password") : undefined;
  const sslmode = url.searchParams.get("sslmode") ?? undefined;
  if (sslmode !== undefined && !["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(sslmode)) fail("PostgreSQL database URL sslmode is invalid");
  return { host, port: String(portNumber), database, username, password, sslmode };
}

function securePath(input: string, label: string): string {
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
  const absolute = securePath(input, label);
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

function validatePaths(paths: PostgresBackupPaths): { dataDir: string; agentDir: string; backupRoot: string; recipients: readonly string[] } {
  const agentDirInput = paths.agentDir ?? path.join(paths.dataDir, ".pi-agent");
  const values = [["data directory", paths.dataDir], ["agent directory", agentDirInput], ["backup root", paths.backupRoot], ["age recipient file", paths.ageRecipientFile]] as const;
  for (const [label, value] of values) if (!path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  const dataDir = canonicalPath(paths.dataDir, "data directory");
  const agentDir = canonicalPath(agentDirInput, "agent directory");
  const backupRoot = canonicalPath(paths.backupRoot, "backup root");
  if (path.resolve(backupRoot) === path.parse(backupRoot).root) fail("backup root must not be the filesystem root");
  if (!existsSync(paths.dataDir) || !lstatSync(paths.dataDir).isDirectory()) fail("data directory does not exist");
  if ((lstatSync(paths.dataDir).mode & 0o022) !== 0) fail("data directory must not be group/world writable");
  if (existsSync(agentDirInput) && (!lstatSync(agentDirInput).isDirectory() || (lstatSync(agentDirInput).mode & 0o022) !== 0)) fail("agent directory is unsafe");
  if (existsSync(paths.backupRoot) && (!lstatSync(paths.backupRoot).isDirectory() || (lstatSync(paths.backupRoot).mode & 0o022) !== 0)) fail("backup root is unsafe");
  validateRegular(paths.ageRecipientFile, "age recipient file");
  const recipientStat = lstatSync(paths.ageRecipientFile);
  if ((recipientStat.mode & 0o022) !== 0) fail("age recipient file is not a safe regular file");
  const text = readFileSync(paths.ageRecipientFile, "utf8");
  const recipients = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (text.includes("\0") || text.includes("\uFFFD") || recipients.length === 0 || recipients.some((line) => !/^age1[0-9a-z]+$/.test(line)) || text.includes("AGE-SECRET-KEY-")) fail("age recipient file is invalid or contains a private key");
  const sessionsRoot = path.join(dataDir, "sessions");
  const projectsRoot = path.join(dataDir, "projects");
  if (within(dataDir, backupRoot) || within(backupRoot, dataDir) || within(agentDir, backupRoot) || within(backupRoot, agentDir) ||
      within(sessionsRoot, backupRoot) || within(backupRoot, sessionsRoot) || within(projectsRoot, backupRoot) || within(backupRoot, projectsRoot)) {
    fail("backup root physically overlaps a source path");
  }
  // The actual credential location must never overlap the whitelisted source
  // surface (resolved path + realpath, not the "auth.json" file name).
  const configuredAuthPath = paths.authPath ?? (process.env.PI_AUTH_PATH?.trim() || undefined);
  const authPath = canonicalPath(configuredAuthPath ?? path.join(homedir(), ".pi", "agent", "auth.json"), "credential path");
  const modelsPath = path.join(agentDir, "models.json");
  for (const [label, root] of [
    ["sessions whitelist root", sessionsRoot], ["projects whitelist root", projectsRoot], ["agentDir/models.json", modelsPath],
  ] as const) {
    if (within(root, authPath) || within(authPath, root)) {
      fail(`the resolved credential path overlaps the ${label}; credentials are never backed up`);
    }
  }
  return { dataDir, agentDir, backupRoot, recipients };
}

function quoteIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) fail("PostgreSQL effective schema is not a safe identifier");
  return `"${name}"`;
}

function identity(value: string, kind: "database" | "schema"): string {
  return createHash("sha256").update(`pi-agent-server.pg-${kind}-identity.v1\0${value}`, "utf8").digest("hex");
}

function sourceRootsSha256(roots: PostgresBackupSourceRoots): string {
  return createHash("sha256").update(stableSerialize(roots), "utf8").digest("hex");
}

/**
 * Cluster/server/database/schema identity binding, captured under the premise
 * that the server can be safely queried. Every field degrades independently to
 * null when the server refuses (e.g. pg_control_system() permission); a cutover
 * revalidation must then fail closed instead of relying on same-name hashes.
 */
interface PgClusterIdentity {
  readonly systemIdentifier: string | null;
  readonly databaseOid: string | null;
  readonly schemaOid: string | null;
  readonly serverAddress: string | null;
  readonly serverPort: string | null;
  readonly clusterName: string | null;
}

const PG_CONTROL_SYSTEM_QUERY = "SELECT system_identifier::text AS system_identifier FROM pg_control_system()";
const PG_IDENTITY_QUERY =
  "SELECT (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid, " +
  "(SELECT oid::text FROM pg_namespace WHERE nspname = current_schema()) AS schema_oid, " +
  "inet_server_addr()::text AS server_address, inet_server_port()::text AS server_port, " +
  "current_setting('cluster_name') AS cluster_name";

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
async function queryClusterIdentity(client: PgBackupClient): Promise<PgClusterIdentity> {
  const result: {
    systemIdentifier: string | null; databaseOid: string | null; schemaOid: string | null;
    serverAddress: string | null; serverPort: string | null; clusterName: string | null;
  } = { systemIdentifier: null, databaseOid: null, schemaOid: null, serverAddress: null, serverPort: null, clusterName: null };
  try {
    const control = await client.query<{ system_identifier: unknown }>(PG_CONTROL_SYSTEM_QUERY);
    result.systemIdentifier = optionalText(control.rows[0]?.system_identifier);
  } catch { /* permission/availability: bound as absent; cutover revalidation fails closed on it */ }
  try {
    const row = (await client.query(PG_IDENTITY_QUERY)).rows[0] as Record<string, unknown> | undefined;
    result.databaseOid = optionalText(row?.database_oid);
    result.schemaOid = optionalText(row?.schema_oid);
    result.serverAddress = optionalText(row?.server_address);
    result.serverPort = optionalText(row?.server_port);
    result.clusterName = optionalText(row?.cluster_name);
  } catch { /* same degradation as above */ }
  return result;
}

export { PG_CONTROL_SYSTEM_QUERY, PG_IDENTITY_QUERY };

function asSafeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
}

async function queryIdentity(client: PgBackupClient): Promise<PgIdentity> {
  try {
    const result = await client.query<{ database: string; schema: string | null; user: string }>(
      "SELECT current_database() AS database, current_schema() AS schema, current_user AS user",
    );
    const row = result.rows[0];
    if (!row || typeof row.database !== "string" || typeof row.schema !== "string" || typeof row.user !== "string" || !row.database || !row.schema || !row.user) {
      fail("PostgreSQL connection returned no safe target identity");
    }
    quoteIdentifier(row.schema);
    return { database: row.database, schema: row.schema, user: row.user };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("backup:")) throw error;
    fail("PostgreSQL connection or identity inspection failed");
  }
}

async function hasTable(client: PgBackupClient, schema: string, table: string): Promise<boolean> {
  try {
    const result = await client.query<{ present: boolean | string }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE') AS present",
      [schema, table],
    );
    return result.rows[0]?.present === true || result.rows[0]?.present === "t";
  } catch {
    fail("PostgreSQL catalog inspection failed");
  }
}

async function readLedger(client: PgBackupClient, schema: string): Promise<PostgresBackupManifest["migrationLedger"]> {
  if (!(await hasTable(client, schema, "schema_migrations"))) {
    return { present: false, appliedCount: 0, appliedVersion: null, checksums: [], rows: [], pending: 0 };
  }
  try {
    const result = await client.query<{ version: unknown; name: unknown; checksum: unknown; applied_at: unknown }>(
      `SELECT version, name, checksum, applied_at FROM ${quoteIdentifier(schema)}."schema_migrations" ORDER BY version`,
    );
    const rows: PgLedgerRow[] = [];
    for (const row of result.rows) {
      const version = asSafeInteger(row.version);
      const appliedAt = asSafeInteger(row.applied_at);
      if (version === null || version < 0 || typeof row.name !== "string" || typeof row.checksum !== "string" || !SAFE_SHA256.test(row.checksum) || appliedAt === null || appliedAt < 0) {
        fail("PostgreSQL migration ledger is malformed");
      }
      rows.push({ version, name: row.name, checksum: row.checksum, applied_at: appliedAt });
    }
    if (rows.some((row, index) => row.version !== index)) fail("PostgreSQL migration ledger is not contiguous");
    return { present: true, appliedCount: rows.length, appliedVersion: rows.length ? rows.at(-1)!.version : null, checksums: rows.map((row) => row.checksum), rows, pending: 0 };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("backup:")) throw error;
    fail("PostgreSQL migration ledger inspection failed");
  }
}

async function defaultSessionReferences(client: PgBackupClient, schema: string): Promise<readonly { sessionId: string; file: string }[]> {
  if (!(await hasTable(client, schema, "sessions"))) return [];
  try {
    const result = await client.query<{ id: unknown; pi_session_file: unknown }>(
      `SELECT id, pi_session_file FROM ${quoteIdentifier(schema)}."sessions" WHERE pi_session_file IS NOT NULL`,
    );
    return result.rows.map((row) => {
      if (typeof row.id !== "string" || typeof row.pi_session_file !== "string") fail("PostgreSQL session reference is malformed");
      return { sessionId: row.id, file: row.pi_session_file };
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("backup:")) throw error;
    fail("PostgreSQL session reference inspection failed");
  }
}

export function sanitizedLibpqEnvironment(parsed: ParsedPgUrl, database: string, username: string, passFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "PI_DATABASE_URL", "DATABASE_URL", "PGPASSWORD", "PGPASSFILE", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS",
    "PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGSSLMODE", "PGSSLCERT", "PGSSLKEY", "PGSSLROOTCERT",
  ]) delete env[key];
  env.PGHOST = parsed.host;
  env.PGPORT = parsed.port;
  env.PGDATABASE = database;
  env.PGUSER = username;
  env.PGPASSFILE = passFile;
  if (parsed.sslmode) env.PGSSLMODE = parsed.sslmode;
  // pg_dump must use its explicit --schema argument; no inherited search_path
  // or PGOPTIONS is allowed to influence the object selection.
  return env;
}

function passfilePart(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
}

export function createPgPassfile(parsed: ParsedPgUrl, database: string, username: string): { directory: string; file: string } {
  const directory = mkdtempSync(path.join(tmpdir(), ".pi-agent-pgpass-"));
  chmodSync(directory, 0o700);
  const file = path.join(directory, "pgpass");
  try {
    const password = parsed.password ?? process.env.PGPASSWORD ?? "";
    const host = parsed.host.includes(":") ? `[${parsed.host}]` : parsed.host;
    writeFileSync(file, `${passfilePart(host)}:${parsed.port}:${passfilePart(database)}:${passfilePart(username)}:${passfilePart(password)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600);
    return { directory, file };
  } catch {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* fail below without exposing a path */ }
    fail("temporary PGPASSFILE could not be created");
  }
}

export async function withPgEnv<T>(parsed: ParsedPgUrl, database: string, username: string, action: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  let passfile: { directory: string; file: string } | undefined;
  let result: T | undefined;
  let original: unknown;
  try {
    passfile = createPgPassfile(parsed, database, username);
    result = await action(sanitizedLibpqEnvironment(parsed, database, username, passfile.file));
  } catch (error) {
    original = error;
  }
  try {
    if (passfile) rmSync(passfile.directory, { recursive: true, force: true });
  } catch (cleanup) {
    if (original) fail("temporary PGPASSFILE cleanup failed");
    fail(`temporary PGPASSFILE cleanup failed: ${cleanup instanceof Error ? "cleanup error" : "unknown error"}`);
  }
  if (original) throw original;
  return result as T;
}

export function parseVersion(command: "pg_dump" | "pg_restore", output: Buffer): string {
  const text = output.toString("utf8").replace(/[\u0000-\u001f\u007f]/g, " ");
  const match = text.match(VERSION_PATTERN);
  if (!match?.[1] || !match[2] || match[1] !== command || !CLIENT_VERSION_PATTERN.test(match[2])) {
    fail(`${command} version could not be verified`);
  }
  return match[2];
}

/** Parse the major component of a pg_dump/pg_restore version without invoking a tool. */
export function parseClientMajor(version: string): number {
  if (typeof version !== "string" || !CLIENT_VERSION_PATTERN.test(version)) fail("PostgreSQL client version is malformed");
  const major = Number(version.split(".")[0]);
  if (!Number.isSafeInteger(major) || major < 1) fail("PostgreSQL client version is malformed");
  return major;
}

/** Parse SHOW server_version_num (for example 160006) into PostgreSQL major 16. */
export function parseServerVersionNumMajor(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 10000) fail("PostgreSQL server version is malformed");
  const major = Math.floor(number / 10000);
  if (!Number.isSafeInteger(major) || major < 1) fail("PostgreSQL server version is malformed");
  return major;
}

export async function queryPostgresServerMajor(client: PgBackupClient): Promise<number> {
  try {
    const result = await client.query<{ server_version_num: unknown }>("SHOW server_version_num");
    return parseServerVersionNumMajor(result.rows[0]?.server_version_num);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("backup:")) throw error;
    fail("PostgreSQL server version inspection failed");
  }
}

export function assertPostgresClientServerMajor(command: "pg_dump" | "pg_restore", clientMajor: number, serverMajor: number): void {
  if (clientMajor !== serverMajor) {
    fail(`PostgreSQL client/server major mismatch: ${command} client major ${clientMajor}, server major ${serverMajor}; install matching client`);
  }
}

export function assertPostgresToolMajorMatch(pgDumpMajor: number, pgRestoreMajor: number): void {
  if (pgDumpMajor !== pgRestoreMajor) {
    fail(`PostgreSQL pg_dump/pg_restore major mismatch: pg_dump client major ${pgDumpMajor}, pg_restore client major ${pgRestoreMajor}; install matching client`);
  }
}

function diagnosticValues(env: NodeJS.ProcessEnv, io: Pick<PgProcessRequest, "stdoutPath" | "stdinPath"> | undefined, sensitiveValues: readonly string[]): string[] {
  return [
    ...sensitiveValues,
    env.PGPASSFILE,
    env.PGUSER,
    io?.stdoutPath,
    io?.stdinPath,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

export async function verifyBinary(
  processAdapter: PgProcessAdapter,
  command: "pg_dump" | "pg_restore",
  binary: string,
  env: NodeJS.ProcessEnv,
  sensitiveValues: readonly string[] = [],
): Promise<string> {
  let result: PgProcessResult;
  try {
    result = await processAdapter.run({ command: binary, args: ["--version"], env, timeoutMs: PG_PROCESS_TIMEOUT_MS });
  } catch {
    fail(`${command} binary is unavailable`);
  }
  if (result.code !== 0) {
    const diagnostic = redactPgDiagnostic(result.stderr, diagnosticValues(env, undefined, sensitiveValues));
    fail(`${command} binary is unavailable (${processStatus(result)})${diagnostic ? `: ${diagnostic}` : ""}`);
  }
  return parseVersion(command, result.stdout);
}

export async function runPgProcess(
  processAdapter: PgProcessAdapter,
  command: "pg_dump" | "pg_restore",
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: Pick<PgProcessRequest, "stdoutPath" | "stdinPath">,
  sensitiveValues: readonly string[] = [],
): Promise<void> {
  let result: PgProcessResult;
  try {
    result = await processAdapter.run({ command: binary, args, env, ...io, timeoutMs: PG_PROCESS_TIMEOUT_MS });
  } catch {
    fail(`${command} failed`);
  }
  if (result.code !== 0) throw processFailure(command, result, diagnosticValues(env, io, sensitiveValues));
}

function checkStorageSelection(options: PostgresBackupOptions): void {
  if (options.storageDialect !== "postgres") fail("PostgreSQL backup requires explicit PI_STORAGE_DIALECT=postgres");
  if (typeof options.databaseUrl !== "string" || options.databaseUrl.trim() === "") fail("PostgreSQL backup requires explicit PI_DATABASE_URL");
}

/**
 * Test seam: a single injected PgBackupClient is same-connection by
 * construction, so it is wrapped as a one-client pool. The injected client
 * stays caller-owned: release() never ends it.
 */
function injectedClientPool(injected: PgBackupClient): PgBackupPool {
  return {
    async connect(): Promise<PgBackupPoolClient> {
      return {
        query: <T extends Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
          injected.query<T>(text, values),
        release: () => undefined,
      };
    },
  };
}

/** Create an encrypted, atomic PostgreSQL pg_dump backup. Offline explicit tool only. */
export async function createPostgresBackup(options: PostgresBackupOptions): Promise<PostgresBackupResult> {
  checkStorageSelection(options);
  const parsed = parsePostgresConnectionUrl(options.databaseUrl);
  const age = options.age ?? ageAdapter;
  const processAdapter = options.pgProcess ?? pgProcessAdapter;
  const now = options.now ?? (() => new Date());
  const resolved = validatePaths(options.paths);
  const sourceRoots: PostgresBackupSourceRoots = { dataDir: resolved.dataDir, agentDir: resolved.agentDir };
  const startedAt = now().toISOString();
  // Same-connection binding: every identity/catalog query, the
  // pg_export_snapshot() call, and the pg_dump child bind to ONE dedicated
  // PoolClient held open for the whole backup. A pool.query() shortcut could
  // round-robin different connections (BEGIN on one, identity on another),
  // which would make the exported snapshot meaningless, so the pool face is
  // strictly acquire → use → release.
  let ownPool: Pool | undefined;
  const resolvePoolFace = (): PgBackupPool => {
    if (options.pgPool) return options.pgPool;
    if (options.pgClient) return injectedClientPool(options.pgClient);
    // The backup's own pool is bounded so a hung or stuck query cannot leak a
    // connection or hang the gate; the server path never passes timeouts.
    ownPool = createPostgresPool(options.databaseUrl, {
      connectionTimeoutMillis: 5_000,
      statementTimeoutMs: BACKUP_STAGE_BUDGET_MS.targetResolve,
      queryTimeoutMs: BACKUP_STAGE_BUDGET_MS.targetResolve,
    });
    return { connect: () => ownPool!.connect() };
  };
  const poolFace = resolvePoolFace();
  let dedicated: PgBackupPoolClient | undefined;
  let transactionOpen = false;
  const rollbackDedicated = async (): Promise<void> => {
    if (!transactionOpen || !dedicated) { transactionOpen = false; return; }
    transactionOpen = false;
    try { await dedicated.query("ROLLBACK"); }
    catch { /* release below; the backup already failed on the original error */ }
  };
  const releaseDedicated = async (): Promise<void> => {
    const current = dedicated;
    dedicated = undefined;
    if (!current) return;
    try { current.release?.(); }
    catch { /* the dedicated client is already gone */ }
  };
  let plainStaging: PlaintextStagingHandle | undefined;
  let publishStaging: string | undefined;
  let finalPath: string | undefined;
  // Original error of the failed backup; cleanup must never replace it.
  let backupError: unknown;
  // Cleanup failures collected in the finally block (reported only when the
  // backup itself succeeded, so an original error always wins).
  const cleanupErrors: unknown[] = [];
  const report = options.onStage;
  const budgets = { ...BACKUP_STAGE_BUDGET_MS, ...options.stageTimeoutMs };
  let target!: PgIdentity;
  let serverMajor!: number;
  let clusterIdentity!: PgClusterIdentity;
  let references!: readonly { sessionId: string; file: string }[];
  let collected!: ReturnType<typeof collectWhitelistedFiles>;
  let missing!: MissingSessionReference[];
  let ledger!: PostgresBackupManifest["migrationLedger"];
  let snapshotId: string | undefined;
  try {
    await withStageTimeout("target-resolve", budgets.targetResolve, async () => {
      dedicated = await poolFace.connect();
      try {
        // pg_export_snapshot() requires REPEATABLE READ or higher; READ ONLY
        // keeps the backup connection write-incapable by construction.
        await dedicated.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      } catch (error) {
        await releaseDedicated();
        fail(`PostgreSQL snapshot transaction could not be started; refusing a backup without a same-connection binding${error instanceof Error && error.message ? `: ${error.message}` : ""}`);
      }
      transactionOpen = true;
      const tx = dedicated;
      if (!tx) fail("PostgreSQL dedicated client disappeared before identity verification");
      target = await queryIdentity(tx);
      // The dump (and every later reset connection) is built from the URL; the
      // authenticated identity must therefore describe exactly that database.
      if (target.database !== parsed.database) {
        fail(`PostgreSQL connection current_database (${target.database}) does not match the URL database; refusing to bind a dump identity to a different database`);
      }
      serverMajor = await queryPostgresServerMajor(tx);
      clusterIdentity = await queryClusterIdentity(tx);
      if (target.schema === "public" || target.schema === "information_schema" || target.schema.startsWith("pg_")) fail("PostgreSQL backup source schema is not an allowed non-public application schema");
      references = options.querySessionReferences
        ? await options.querySessionReferences(tx, target.schema)
        : await defaultSessionReferences(tx, target.schema);
      collected = collectWhitelistedFiles(resolved.dataDir, resolved.agentDir);
      missing = validateReferences(references, resolved.dataDir, collected.files);
      // Opt-in strict completeness gate: any missing session reference fails
      // BEFORE any staging/publish/COMPLETE work (dry-run included), so a
      // strict backup can never publish an incomplete package.
      assertStrictCompleteness(options.requireCompleteSessionReferences, missing);
      ledger = await readLedger(tx, target.schema);
      // Same-transaction snapshot export: pg_dump --snapshot consumes exactly
      // this snapshot for as long as this transaction stays open. A server
      // without pg_export_snapshot() (or a failed export) fails the backup
      // closed — a dump without a same-snapshot binding is never published.
      let exported: string | null = null;
      try {
        const result = await tx.query<{ snapshot?: unknown }>("SELECT pg_export_snapshot() AS snapshot");
        exported = optionalText(result.rows[0]?.snapshot);
      } catch (error) {
        fail(`PostgreSQL pg_export_snapshot() failed; refusing a backup without a same-snapshot binding${error instanceof Error && error.message ? `: ${error.message}` : ""}`);
      }
      if (!exported || exported.length > 64 || exported.startsWith("-") || !/^[0-9A-Za-z]+(?:-[0-9A-Za-z]+)*$/.test(exported)) {
        fail("PostgreSQL pg_export_snapshot() returned no usable snapshot id; refusing a backup without a same-snapshot binding");
      }
      snapshotId = exported;
    }, undefined, report);
    if (options.dryRun === true) {
      await rollbackDedicated();
      await releaseDedicated();
      return {
        dryRun: true,
        finalPath: null,
        files: collected.files.map((item) => ({ path: `payload/${item.relativePath}.age`, kind: item.kind, size: 0, sha256: "0".repeat(64) })),
        missingSessionReferences: missing,
        manifest: null,
        publishedIdentity: null,
      };
    }
    const username = parsed.username ?? target.user;
    const pgDumpBinary = options.pgDumpBinary ?? "pg_dump";
    const pgRestoreBinary = options.pgRestoreBinary ?? "pg_restore";
    const diagnosticSecrets = [parsed.password, process.env.PGPASSWORD, username].filter((value): value is string => Boolean(value));
    // Complete all tool/crypto preflight before creating a package. In
    // particular, a dump must never be published unless the exact matching
    // pg_restore binary is available too.
    await age.ensureAvailable?.(options.paths.ageRecipientFile);
    const pgDumpVersion = await withPgEnv(parsed, target.database, username, async (env) =>
      verifyBinary(processAdapter, "pg_dump", pgDumpBinary, env, diagnosticSecrets));
    const pgDumpMajor = parseClientMajor(pgDumpVersion);
    assertPostgresClientServerMajor("pg_dump", pgDumpMajor, serverMajor);
    const pgRestoreVersion = await withPgEnv(parsed, target.database, username, async (env) =>
      verifyBinary(processAdapter, "pg_restore", pgRestoreBinary, env, diagnosticSecrets));
    const pgRestoreMajor = parseClientMajor(pgRestoreVersion);
    assertPostgresClientServerMajor("pg_restore", pgRestoreMajor, serverMajor);
    assertPostgresToolMajorMatch(pgDumpMajor, pgRestoreMajor);
    // Plaintext staging is validated/created before the backup root or its
    // publish staging exist, so a misconfigured staging root is rejected
    // without materializing anything.
    plainStaging = openPlaintextStaging(options.stagingRoot, resolved.backupRoot);
    if (!existsSync(options.paths.backupRoot)) mkdirSync(options.paths.backupRoot, { recursive: true, mode: 0o700 });
    chmodSync(options.paths.backupRoot, 0o700);
    // Two staging surfaces (same contract as the SQLite core): the publish
    // staging lives INSIDE backupRoot and holds only ciphertext, so the final
    // publish is one same-filesystem atomic rename and the backup root's
    // parent is never touched; plaintext staging (pg_dump output, JSONL
    // copies, manifest plaintext) lives in a private per-user config staging
    // root (default ~/Library/Application Support/pi-agent-server-backup-
    // staging; full trusted ancestor chain), never in the backup root or its
    // parent. This is a temporary plaintext working area; the final backup
    // root holds only ciphertext. The staging directory
    // FD stays held and is revalidated before every sensitive operation.
    publishStaging = mkdtempSync(path.join(resolved.backupRoot, ".pi-agent-backup-publish-"));
    chmodSync(publishStaging, 0o700);
    const dumpPlain = path.join(plainStaging.path, "database.pg_dump");
    plainStaging.revalidate();
    await withStageTimeout("pg-dump", budgets.pgDump, async () => {
      await withPgEnv(parsed, target.database, username, async (env) => {
        await runPgProcess(processAdapter, "pg_dump", pgDumpBinary, [
          "--format=custom", "--no-owner", "--no-privileges", `--schema=${target.schema}`,
          // The dump reads exactly the snapshot exported by the dedicated
          // transaction above; the transaction is held open until this child
          // has exited.
          `--snapshot=${snapshotId ?? fail("PostgreSQL snapshot id is missing; refusing to dump without a same-snapshot binding")}`,
        ], env, { stdoutPath: dumpPlain }, diagnosticSecrets);
      });
    }, { abort: () => processAdapter.abort?.() }, report);
    // The exporting transaction must remain open for the whole dump; commit
    // only now that the consistent snapshot has been consumed. A failed COMMIT
    // releases the client and fails the backup before anything is published.
    const txForCommit = dedicated;
    if (!txForCommit || !transactionOpen) fail("PostgreSQL snapshot transaction ended before the dump completed; refusing to publish an unbound dump");
    try {
      await txForCommit.query("COMMIT");
    } finally {
      transactionOpen = false;
      await releaseDedicated();
    }
    validateRegular(dumpPlain, "pg_dump output");
    const dump = hashFile(dumpPlain);
    if (dump.size === 0) fail("pg_dump output is empty");
    // Validate the custom archive structure while plaintext is still staged.
    // `--list -` only reads the archive and never connects to or mutates a
    // target database. A corrupt/incompatible archive therefore cannot reach
    // encryption publication (or the subsequent migration).
    plainStaging.revalidate();
    await withStageTimeout("archive-list", budgets.archiveList, async () => {
      await withPgEnv(parsed, target.database, username, async (env) => {
        await runPgProcess(processAdapter, "pg_restore", pgRestoreBinary, ["--list", dumpPlain], env, {}, [...diagnosticSecrets, dumpPlain]);
      });
    }, { abort: () => processAdapter.abort?.() }, report);
    let files: BackupFileRecord[] = [];
    const ageBudget = { timeoutMs: options.ageProcessTimeoutMs };
    await withStageTimeout("age", budgets.age, async () => {
      plainStaging!.revalidate();
      files = [await encryptFileTo(publishStaging!, "payload/database.pg_dump.age", dumpPlain, dump, options.paths.ageRecipientFile, age, "postgres-dump", ageBudget)];
      rmSync(dumpPlain, { force: true });
      for (const item of collected.files) {
        plainStaging!.revalidate();
        files.push(await encryptStableSource(plainStaging!.path, publishStaging!, item, options.paths.ageRecipientFile, age, ageBudget));
      }
    }, { abort: () => abortActiveAgeChild() }, report);
    const finishedAt = now().toISOString();
    const rootsHash = sourceRootsSha256(sourceRoots);
    const manifest: PostgresBackupManifest = {
      format: "pi-agent-server.backup-manifest.v1",
      kind: options.backupKind ?? "postgresql",
      dialect: "PostgreSQL",
      createdAt: finishedAt,
      sourceRoots,
      sourceRootsSha256: rootsHash,
      sourceRootsHash: rootsHash,
      timeWindow: { startedAt, finishedAt },
      postgres: {
        databaseIdentity: identity(target.database, "database"),
        schemaIdentity: identity(target.schema, "schema"),
        systemIdentifier: clusterIdentity.systemIdentifier,
        databaseOid: clusterIdentity.databaseOid,
        schemaOid: clusterIdentity.schemaOid,
        serverAddress: clusterIdentity.serverAddress,
        serverPort: clusterIdentity.serverPort,
        clusterName: clusterIdentity.clusterName,
        pgDumpVersion,
        pgRestoreVersion,
      },
      migrationLedger: ledger,
      credentials: { included: false, policy: "whitelist-excludes-credentials" },
      encryption: { format: "age-v1", recipients: resolved.recipients },
      files,
      missingSessionReferences: missing,
      excludedFiles: collected.excluded,
    };
    const manifestPlain = path.join(plainStaging.path, ".manifest.json");
    plainStaging.revalidate();
    writePrivate(manifestPlain, `${stableSerialize(manifest)}\n`);
    const manifestInfo = hashFile(manifestPlain);
    plainStaging.revalidate();
    const encryptedManifest = await withStageTimeout("age", budgets.age, () =>
      encryptFileTo(publishStaging!, "manifest.json.age", manifestPlain, manifestInfo, options.paths.ageRecipientFile, age, "config", ageBudget),
    { abort: () => abortActiveAgeChild() }, report);
    rmSync(manifestPlain, { force: true });
    // Crash durability gate (same contract as the SQLite core): fsync every
    // new ciphertext directory deepest first (payload leaves → payload root →
    // publish root) BEFORE the COMPLETE marker is written.
    syncDirectoryTreeBestEffort(publishStaging);
    writePrivate(path.join(publishStaging, "COMPLETE"), `${encryptedManifest.encryptedSha256}\n`);
    syncDirectoryBestEffort(publishStaging);
    finalPath = path.join(options.paths.backupRoot, `backup-${Date.now()}-${randomUUID()}`);
    renameSync(publishStaging, finalPath);
    publishStaging = undefined;
    syncDirectoryBestEffort(options.paths.backupRoot);
    const publishedIdentity: PublishedBackupIdentity = {
      manifestSha256: encryptedManifest.encryptedSha256 ?? fail("the encrypted manifest has no recorded ciphertext hash"),
      completeMarker: encryptedManifest.encryptedSha256!,
      sourceRootsSha256: rootsHash,
      sourceBindingSha256: createHash("sha256").update(stableSerialize(manifest.postgres), "utf8").digest("hex"),
    };
    return { dryRun: false, finalPath, files, missingSessionReferences: missing, manifest, publishedIdentity };
  } catch (error) {
    backupError = error;
    if (finalPath) {
      // Best-effort removal of a partially published package: a removal
      // failure must not mask the original backup error.
      try { rmSync(finalPath, { recursive: true, force: true }); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    throw error;
  } finally {
    // Independent per-item cleanup (plaintext staging, publish staging,
    // transaction rollback, client release, pool shutdown): every item runs
    // in its own try/catch so one failure can neither skip the remaining
    // items nor replace the original backup error. On the SUCCESS path a
    // cleanup failure fails closed instead of leaving plaintext/publish
    // leftovers or a leaked pool.
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
    // Transaction lifecycle cleanup: any failure path rolls the dedicated
    // transaction back and releases the client exactly once. The committed
    // path already reset transactionOpen, so rollback here is a safe no-op.
    try { await rollbackDedicated(); }
    catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { await releaseDedicated(); }
    catch (cleanupError) { cleanupErrors.push(cleanupError); }
    if (ownPool) {
      try { await ownPool.end(); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (backupError !== undefined) throw backupError;
    if (cleanupErrors.length > 0) {
      fail(`cleanup failed after the backup: ${cleanupErrors.map((cleanupError) => cleanupError instanceof Error ? cleanupError.message : String(cleanupError)).join("; ")}`);
    }
  }
}

export { identity as postgresIdentity, quoteIdentifier as quotePostgresIdentifier };
