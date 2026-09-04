// WP2A 受控 cutover 核心（离线显式工具）。
//
// 安全边界（全部 fail-closed）：
// - 任何删除/迁移都必须先经 authorizeCutover：显式 --reset-rc-data + 不可绕过的确认词
//   --confirm-reset DELETE_RC_DATA + --maintenance-window CONFIRMED。没有确认 = 零删除/零迁移。
// - 顺序固定：安全 target 解析 → pre-reset 加密备份（旧 RC 库无 migration ledger 也可备份，
//   manifest 以 migrationLedger.present=false 记录 legacy，绝不假称 legacy 数据可被 migration verify）
//   → 验证备份 COMPLETE/manifest/hash → 受控 reset → Manifest-driven migration apply →
//   严格 verify head → 脱敏 machine report。
// - 备份失败：绝不 reset；migration 失败：保留备份，绝不自动 restore/down；成功前绝不输出成功。
// - 本模块不接入 startServer、不启动服务、不安装 scheduler/timer；生产回滚 = 人工从 pre-reset
//   加密备份按 runbook 恢复到临时验证环境后受控恢复，这里绝不自动 restore。

import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import {
  isWithin,
  verifyPublishedBackup,
  assertSqliteSourceTreeUnchanged,
  abortActiveAgeChild,
  type BackupResult,
  type PostgresBackupResult,
  type PublishedBackupVerification,
} from "../backup/backup-core.js";
import { postgresIdentity, quotePostgresIdentifier } from "../backup/postgres-backup-core.js";
import {
  APPLY_STAGE_BUDGET_MS,
  withStageTimeout,
  type StageReporter,
} from "../backup/stage-guard.js";
import {
  runPostgresMigrations,
  runSqliteMigrations,
  type MigrationRunResult,
} from "../storage/migration-engine.js";
import { migrationDefinitions } from "../storage/migration-manifest.js";
import {
  resolveBackupCliPaths,
  type StorageEnvironment,
} from "../storage/storage-config.js";

export const CUTOVER_USAGE =
  "用法：pnpm cutover -- --dry-run|--apply --reset-rc-data --confirm-reset DELETE_RC_DATA " +
  "--maintenance-window CONFIRMED --backup-root ABSOLUTE_DIR --age-recipient-file ABSOLUTE_FILE " +
  "[--target-schema SCHEMA（仅 PostgreSQL）]";

/** 不可绕过的确认词：必须逐字匹配，大小写敏感，无默认值。 */
export const CUTOVER_CONFIRM_TOKEN = "DELETE_RC_DATA";
/** PG reset 仅接受的专用 schema 前缀（allowlist）；public / pi_restore_* / pg_* / 系统schema 永远拒绝。 */
export const CUTOVER_SCHEMA_PREFIX = "pi_cutover_";

export interface CutoverCliOptions {
  readonly mode: "apply" | "dry-run";
  readonly resetRcData: boolean;
  readonly confirmReset?: string;
  readonly maintenanceWindowConfirmed: boolean;
  readonly backupRoot?: string;
  readonly ageRecipientFile?: string;
  /** PostgreSQL 专用：显式 authenticated target schema（必须等于连接 effective schema）。 */
  readonly targetSchema?: string;
}

/**
 * 严格解析 CLI 参数：未知参数一律拒绝（不回显参数值——可能含 token/密钥）；重复参数拒绝；
 * 确认词逐字匹配。dry-run 与 apply 要求同一套完整确认（dry-run 是 apply 的命令行彩排，零写入）。
 */
export function parseCutoverArgs(args: readonly string[]): CutoverCliOptions {
  const actual = args[0] === "--" ? args.slice(1) : args;
  const modes = actual.filter((arg) => arg === "--apply" || arg === "--dry-run");
  if (modes.length !== 1) throw new Error(CUTOVER_USAGE);
  const mode = modes[0]!.slice(2) as CutoverCliOptions["mode"];
  let resetRcData = false;
  let confirmReset: string | undefined;
  let maintenanceWindowConfirmed = false;
  let backupRoot: string | undefined;
  let ageRecipientFile: string | undefined;
  let targetSchema: string | undefined;
  for (let index = 0; index < actual.length; index++) {
    const arg = actual[index]!;
    if (arg === "--apply" || arg === "--dry-run") continue;
    const takeValue = (label: string): string => {
      const inline = arg.startsWith(`${label}=`) ? arg.slice(label.length + 1) : undefined;
      if (inline !== undefined) return inline;
      if (arg !== label || !actual[index + 1]) throw new Error(`${CUTOVER_USAGE}；${label} 需要一个值`);
      index++;
      return actual[index]!;
    };
    if (arg === "--reset-rc-data") {
      if (resetRcData) throw new Error(`${CUTOVER_USAGE}；--reset-rc-data 只能出现一次`);
      resetRcData = true;
    } else if (arg === "--confirm-reset" || arg.startsWith("--confirm-reset=")) {
      if (confirmReset !== undefined) throw new Error(`${CUTOVER_USAGE}；--confirm-reset 只能出现一次`);
      confirmReset = takeValue("--confirm-reset");
    } else if (arg === "--maintenance-window" || arg.startsWith("--maintenance-window=")) {
      if (maintenanceWindowConfirmed) throw new Error(`${CUTOVER_USAGE}；--maintenance-window 只能出现一次`);
      // Strict literal match: only the exact original `CONFIRMED` is accepted.
      // Case variants and surrounding whitespace are rejected, never normalized.
      if (takeValue("--maintenance-window") !== "CONFIRMED") {
        throw new Error(`${CUTOVER_USAGE}；--maintenance-window 必须为 CONFIRMED（逐字匹配，大小写/空白不容忍）`);
      }
      maintenanceWindowConfirmed = true;
    } else if (arg === "--backup-root" || arg.startsWith("--backup-root=")) {
      if (backupRoot !== undefined) throw new Error(`${CUTOVER_USAGE}；--backup-root 只能出现一次`);
      backupRoot = takeValue("--backup-root");
    } else if (arg === "--age-recipient-file" || arg.startsWith("--age-recipient-file=")) {
      if (ageRecipientFile !== undefined) throw new Error(`${CUTOVER_USAGE}；--age-recipient-file 只能出现一次`);
      ageRecipientFile = takeValue("--age-recipient-file");
    } else if (arg === "--target-schema" || arg.startsWith("--target-schema=")) {
      if (targetSchema !== undefined) throw new Error(`${CUTOVER_USAGE}；--target-schema 只能出现一次`);
      targetSchema = takeValue("--target-schema");
    } else {
      // 不回显未知参数：命令行可能意外携带 token/密钥等敏感值。
      throw new Error(`${CUTOVER_USAGE}；未知参数`);
    }
  }
  if (!resetRcData) throw new Error(`${CUTOVER_USAGE}；必须显式提供 --reset-rc-data`);
  if (!confirmReset) throw new Error(`${CUTOVER_USAGE}；必须显式提供 --confirm-reset DELETE_RC_DATA`);
  if (confirmReset !== CUTOVER_CONFIRM_TOKEN) {
    // 不可绕过：确认词在解析层就逐字匹配，而不是留给后续阶段。
    throw new Error(`${CUTOVER_USAGE}；--confirm-reset 必须为 ${CUTOVER_CONFIRM_TOKEN}`);
  }
  if (!maintenanceWindowConfirmed) throw new Error(`${CUTOVER_USAGE}；必须显式提供 --maintenance-window CONFIRMED`);
  if (!backupRoot || !path.isAbsolute(backupRoot)) throw new Error(`${CUTOVER_USAGE}；必须显式提供绝对 --backup-root`);
  if (!ageRecipientFile || !path.isAbsolute(ageRecipientFile)) throw new Error(`${CUTOVER_USAGE}；必须显式提供绝对 --age-recipient-file`);
  return { mode, resetRcData, confirmReset, maintenanceWindowConfirmed, backupRoot, ageRecipientFile, targetSchema };
}

/** 结构化授权凭证：只能由 authorizeCutover 产生；破坏性步骤执行前后都会重新校验。 */
export interface CutoverAuthorization {
  readonly token: "rc-data-reset-authorized";
}

const AUTHORIZED: CutoverAuthorization = { token: "rc-data-reset-authorized" };

/**
 * 授权门禁：--reset-rc-data + 逐字确认词 + 维护窗口确认三者缺一不可。
 * 这是所有删除/迁移操作的唯一入口；未经授权时调用方应零删除/零迁移。
 */
export function authorizeCutover(cli: CutoverCliOptions): CutoverAuthorization {
  if (!cli.resetRcData) throw new Error("cutover: reset requires the explicit --reset-rc-data flag");
  if (cli.confirmReset !== CUTOVER_CONFIRM_TOKEN) {
    throw new Error(`cutover: confirmation token mismatch; the exact token --confirm-reset ${CUTOVER_CONFIRM_TOKEN} is required`);
  }
  if (!cli.maintenanceWindowConfirmed) throw new Error("cutover: --maintenance-window CONFIRMED is required");
  return AUTHORIZED;
}

/** 纯校验：PG reset 仅接受 pi_cutover_* 专用 schema；public / 系统 / restore 演练 schema 永远拒绝。 */
export function validateCutoverTargetSchema(schema: string): string {
  const trimmed = schema.trim();
  if (trimmed !== schema || trimmed.length === 0) throw new Error("cutover: --target-schema must be a non-blank schema name without surrounding whitespace");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) throw new Error("cutover: --target-schema must be a plain SQL identifier");
  if (trimmed.toLowerCase() === "public" || trimmed.toLowerCase() === "information_schema") {
    throw new Error(`cutover: target schema '${trimmed}' is never allowed; use a dedicated ${CUTOVER_SCHEMA_PREFIX}* schema`);
  }
  if (trimmed.toLowerCase().startsWith("pg_")) throw new Error("cutover: system pg_* schemas are never allowed as the reset target");
  if (trimmed.toLowerCase().startsWith("pi_restore_")) throw new Error("cutover: pi_restore_* databases/schemas belong to restore drills and are rejected as a reset target");
  if (!trimmed.startsWith(CUTOVER_SCHEMA_PREFIX)) {
    throw new Error(`cutover: only allowlisted dedicated schemas with the '${CUTOVER_SCHEMA_PREFIX}' prefix may be reset (got a non-allowlisted schema); this tool never drops DATABASE and never touches public`);
  }
  return trimmed;
}

export interface SqliteCutoverTarget {
  readonly dialect: "sqlite";
  readonly cwd: string;
  readonly dataDir: string;
  readonly agentDir: string;
  readonly modelsPath: string;
  readonly authPath: string;
  readonly dbPath: string;
  readonly backupRoot: string;
  readonly ageRecipientFile: string;
}

export interface PostgresCutoverTarget {
  readonly dialect: "postgres";
  readonly cwd: string;
  readonly dataDir: string;
  readonly agentDir: string;
  readonly modelsPath: string;
  readonly authPath: string;
  readonly backupRoot: string;
  readonly ageRecipientFile: string;
}

function assertNoSymlinkAncestors(input: string, label: string): void {
  const absolute = path.resolve(input);
  const root = path.parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    let entry: ReturnType<typeof lstatSync>;
    try { entry = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    // 与 backup-core securePath 相同的例外：macOS /var 与 Linux /tmp 系统别名。
    const trustedSystemAlias = (process.platform === "darwin" && (current === "/var" || current === "/tmp")) || (process.platform !== "darwin" && current === "/tmp");
    if (entry.isSymbolicLink() && !trustedSystemAlias) throw new Error(`cutover: ${label} contains a symbolic-link ancestor`);
  }
}

function assertRegularSingleLink(file: string, label: string): void {
  assertNoSymlinkAncestors(file, label);
  let entry: ReturnType<typeof lstatSync>;
  try { entry = lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`cutover: ${label} does not exist`);
    throw error;
  }
  if (entry.isSymbolicLink()) throw new Error(`cutover: ${label} is a symbolic link`);
  if (!entry.isFile()) throw new Error(`cutover: ${label} must be a regular file`);
  if (entry.nlink > 1) throw new Error(`cutover: ${label} is a hardlink (nlink=${entry.nlink})`);
}

/**
 * Canonical path for overlap comparisons: the same no-symlink-ancestor policy
 * as backup-core, with the existing prefix realpath'ed so mount/system aliases
 * cannot smuggle an alias past a prefix check.
 */
function canonicalCutoverPath(input: string, label: string): string {
  assertNoSymlinkAncestors(input, label);
  const absolute = path.resolve(input);
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

/**
 * Shared cutover path-safety resolution (pure checks, zero writes).
 *
 * - PI_AUTH_PATH and PI_AGENT_DIR are part of the resolver: the safety checks
 *   run against the *actual* credential and agentDir locations (defaults:
 *   `$HOME/.pi/agent/auth.json` and `dataDir/.pi-agent`), never just file names;
 * - DATA_DIR must be explicitly set (never silently inherited from the cwd) and
 *   the resolved dataDir must not equal, contain, or be contained in AGENT_CWD;
 * - the resolved authPath and agentDir/models.json must not overlap — in either
 *   direction, through realpath aliases — with the reset surface (SQLite:
 *   DB/WAL/SHM + sessions//projects/ roots; PG: sessions//projects/ roots).
 *   Custom credential names/locations are therefore never backed up and never
 *   deleted: any overlap fails the cutover before any destructive step.
 */
function resolveCutoverPathSafety(
  environment: StorageEnvironment,
  cli: CutoverCliOptions,
): {
  readonly cwd: string;
  readonly dataDir: string;
  readonly agentDir: string;
  readonly modelsPath: string;
  readonly authPath: string;
  readonly backupRoot: string;
  readonly ageRecipientFile: string;
} {
  if (!cli.backupRoot || !cli.ageRecipientFile) throw new Error("cutover: --backup-root and --age-recipient-file are required");
  if (!environment.DATA_DIR || environment.DATA_DIR.trim() === "") {
    throw new Error("cutover: an explicit absolute DATA_DIR is required; the data directory is never silently inherited from AGENT_CWD/process cwd");
  }
  const paths = resolveBackupCliPaths(environment, cli.backupRoot, cli.ageRecipientFile, environment.AGENT_CWD!);
  const cwd = canonicalCutoverPath(paths.cwd, "agent cwd");
  const dataDir = canonicalCutoverPath(paths.dataDir, "data directory");
  const agentDir = canonicalCutoverPath(paths.agentDir, "agent directory");
  const authPath = canonicalCutoverPath(paths.authPath, "credential path");
  const backupRoot = canonicalCutoverPath(paths.backupRoot, "backup root");
  const ageRecipientFile = canonicalCutoverPath(paths.ageRecipientFile, "age recipient file");
  const modelsPath = path.join(agentDir, "models.json");
  if (isWithin(cwd, dataDir) || isWithin(dataDir, cwd)) {
    throw new Error("cutover: the data directory must not overlap the agent cwd in either direction; use a dedicated absolute DATA_DIR");
  }
  return { cwd, dataDir, agentDir, modelsPath, authPath, backupRoot, ageRecipientFile };
}

/** The destructive SQLite surface: DB + WAL/SHM sidecars + sessions//projects/ roots. */
function sqliteResetRoots(dataDir: string, dbPath: string): readonly string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, path.join(dataDir, "sessions"), path.join(dataDir, "projects")];
}

/** The destructive PostgreSQL surface: sessions//projects/ JSONL roots under dataDir. */
function postgresResetRoots(dataDir: string): readonly string[] {
  return [path.join(dataDir, "sessions"), path.join(dataDir, "projects")];
}

function assertCredentialsOutsideResetSurface(agentDir: string, modelsPath: string, authPath: string, resetRoots: readonly string[]): void {
  for (const [label, protectedPath] of [["agent directory", agentDir], ["agentDir/models.json", modelsPath], ["credential path", authPath]] as const) {
    for (const root of resetRoots) {
      if (isWithin(root, protectedPath) || isWithin(protectedPath, root)) {
        throw new Error(`cutover: the resolved ${label} overlaps the destructive reset surface; refusing a plan that could delete credentials, service config, or the whole agent directory`);
      }
    }
  }
}

/**
 * SQLite 受控 cutover target 解析（纯安全检查，零写入）：
 * - 强制绝对 AGENT_CWD/DATA_DIR/DB_PATH（复用离线 CLI 共享解析；拒绝相对路径歧义）；
 * - 仅允许解析后的文件 DB：拒绝 :memory: 命名、symlink、hardlink、不存在的 DB；
 * - DB 必须位于 dataDir 内；backup root 与 dataDir/agentDir/dbPath 任一方向重叠都拒绝；
 * - cwd 本身永不被删除（reset 只触碰 DB/WAL/SHM 与 dataDir 下 sessions/、projects/ 两个根）。
 */
export function resolveSqliteCutoverTarget(environment: StorageEnvironment, cli: CutoverCliOptions): SqliteCutoverTarget {
  const safe = resolveCutoverPathSafety(environment, cli);
  // dbPath 使用与其余路径相同的 canonical 形式（macOS /var → /private/var 等系统别名），
  // 否则与 canonical dataDir 的 isWithin 比较会误判；symlink 祖先在此即被拒绝。
  const dbPath = canonicalCutoverPath(
    path.resolve(environment.DB_PATH?.trim() || path.join(safe.dataDir, "pi-agent-server.db")),
    "SQLite target database",
  );
  if (dbPath.endsWith(":memory:")) throw new Error("cutover: in-memory SQLite targets are never allowed; resolve to a file database first");
  assertRegularSingleLink(dbPath, "SQLite target database");
  const sessionsRoot = path.join(safe.dataDir, "sessions");
  const projectsRoot = path.join(safe.dataDir, "projects");
  if (!isWithin(safe.dataDir, dbPath)) throw new Error("cutover: the SQLite database must live inside the resolved data directory");
  for (const [label, root] of [["data directory", safe.dataDir], ["agent directory", safe.agentDir], ["database file", dbPath]] as const) {
    if (isWithin(root, safe.backupRoot) || isWithin(safe.backupRoot, root)) {
      throw new Error(`cutover: backup root physically overlaps the ${label}; use a separate absolute backup root`);
    }
  }
  if (isWithin(safe.backupRoot, sessionsRoot) || isWithin(sessionsRoot, safe.backupRoot) ||
      isWithin(safe.backupRoot, projectsRoot) || isWithin(projectsRoot, safe.backupRoot)) {
    throw new Error("cutover: backup root physically overlaps a session data root");
  }
  assertCredentialsOutsideResetSurface(safe.agentDir, safe.modelsPath, safe.authPath, sqliteResetRoots(safe.dataDir, dbPath));
  return { dialect: "sqlite", cwd: safe.cwd, dataDir: safe.dataDir, agentDir: safe.agentDir, modelsPath: safe.modelsPath, authPath: safe.authPath, dbPath, backupRoot: safe.backupRoot, ageRecipientFile: safe.ageRecipientFile };
}

/**
 * PostgreSQL cutover target resolution: the same path-safety boundary as the
 * SQLite resolver (explicit DATA_DIR, no cwd overlap, credential/agentDir
 * exclusion, backup-root overlap rejection) without SQLite file-DB checks.
 * The destructive file surface is sessions//projects/ JSONL roots only.
 */
export function resolvePostgresCutoverTarget(environment: StorageEnvironment, cli: CutoverCliOptions): PostgresCutoverTarget {
  const safe = resolveCutoverPathSafety(environment, cli);
  const sessionsRoot = path.join(safe.dataDir, "sessions");
  const projectsRoot = path.join(safe.dataDir, "projects");
  for (const [label, root] of [["data directory", safe.dataDir], ["agent directory", safe.agentDir]] as const) {
    if (isWithin(root, safe.backupRoot) || isWithin(safe.backupRoot, root)) {
      throw new Error(`cutover: backup root physically overlaps the ${label}; use a separate absolute backup root`);
    }
  }
  if (isWithin(safe.backupRoot, sessionsRoot) || isWithin(sessionsRoot, safe.backupRoot) ||
      isWithin(safe.backupRoot, projectsRoot) || isWithin(projectsRoot, safe.backupRoot)) {
    throw new Error("cutover: backup root physically overlaps a session data root");
  }
  assertCredentialsOutsideResetSurface(safe.agentDir, safe.modelsPath, safe.authPath, postgresResetRoots(safe.dataDir));
  return { dialect: "postgres", cwd: safe.cwd, dataDir: safe.dataDir, agentDir: safe.agentDir, modelsPath: safe.modelsPath, authPath: safe.authPath, backupRoot: safe.backupRoot, ageRecipientFile: safe.ageRecipientFile };
}

function assertResetPreconditions(target: SqliteCutoverTarget): void {
  assertRegularSingleLink(target.dbPath, "SQLite target database");
  assertNoSymlinkAncestors(target.dataDir, "data directory");
  if (!existsSync(target.dataDir)) throw new Error("cutover: data directory disappeared before reset");
  assertCredentialsOutsideResetSurface(target.agentDir, target.modelsPath, target.authPath, sqliteResetRoots(target.dataDir, target.dbPath));
  for (const root of [path.join(target.dataDir, "sessions"), path.join(target.dataDir, "projects")]) {
    if (!existsSync(root)) continue;
    const entry = lstatSync(root);
    if (entry.isSymbolicLink()) throw new Error("cutover: session data root is a symbolic link; refusing to delete");
    if (!entry.isDirectory()) throw new Error("cutover: session data root is not a directory");
  }
}

/**
 * 受控 SQLite reset（破坏性；只能由 runControlledCutover 在备份验证成功后调用）：
 * 删除 DB/WAL/SHM 与 dataDir 内会话 JSONL 两个根（sessions/、projects/）。
 * - 保留 agentDir（含白名单服务配置 models.json）与其余 dataDir 内容；
 * - 绝不触碰凭证（auth 文件不在删除清单，备份白名单也永久排除 auth）；
 * - 绝不删除任意 cwd 目录。
 */
export function resetSqliteForCutover(target: SqliteCutoverTarget): void {
  assertResetPreconditions(target);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${target.dbPath}${suffix}`, { force: true });
  for (const root of [path.join(target.dataDir, "sessions"), path.join(target.dataDir, "projects")]) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
}

/** PG JSONL reset preconditions: the same strict boundary as SQLite, minus DB files. */
function assertPostgresResetPreconditions(target: PostgresCutoverTarget): void {
  assertNoSymlinkAncestors(target.dataDir, "data directory");
  if (!existsSync(target.dataDir)) throw new Error("cutover: data directory disappeared before reset");
  assertCredentialsOutsideResetSurface(target.agentDir, target.modelsPath, target.authPath, postgresResetRoots(target.dataDir));
  for (const root of postgresResetRoots(target.dataDir)) {
    if (!existsSync(root)) continue;
    const entry = lstatSync(root);
    if (entry.isSymbolicLink()) throw new Error("cutover: session data root is a symbolic link; refusing to delete");
    if (!entry.isDirectory()) throw new Error("cutover: session data root is not a directory");
  }
}

/**
 * 受控 PG JSONL reset（破坏性；只能由 runControlledCutover 在备份验证通过后调用）：
 * 与 SQLite 同一严格边界，仅删除 dataDir 内 sessions/、projects/ 两个 JSONL 根；
 * 保留 agentDir（含白名单服务配置 models.json）与其余 dataDir 内容；
 * 绝不触碰凭证（resolved authPath 与 reset 面任意 overlap 都会先 fail）。
 */
export function resetPostgresDataForCutover(target: PostgresCutoverTarget): void {
  assertPostgresResetPreconditions(target);
  for (const root of postgresResetRoots(target.dataDir)) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
}

function assertSourceRootsMatch(roots: PublishedBackupVerification["sourceRoots"], expected: { readonly dataDir: string; readonly agentDir: string; readonly dbPath?: string }): void {
  if (!roots) throw new Error("cutover: the published backup has no authenticated source roots; refusing to reset (zero deletion performed)");
  const mismatches: string[] = [];
  if (canonicalCutoverPath(roots.dataDir, "backup dataDir") !== canonicalCutoverPath(expected.dataDir, "target dataDir")) mismatches.push("dataDir");
  if (canonicalCutoverPath(roots.agentDir, "backup agentDir") !== canonicalCutoverPath(expected.agentDir, "target agentDir")) mismatches.push("agentDir");
  if (expected.dbPath !== undefined && ("dbPath" in roots ? canonicalCutoverPath(roots.dbPath, "backup dbPath") !== canonicalCutoverPath(expected.dbPath, "target dbPath") : true)) mismatches.push("dbPath");
  if (mismatches.length > 0) {
    throw new Error(`cutover: the published backup was taken from different source roots (${mismatches.join(", ")} changed after the backup); refusing to reset (zero deletion performed)`);
  }
}

/**
 * Reset 前 SQLite binding 复验：重新解析 target（同一套安全检查）、比对 manifest 中的
 * canonical source roots，并断言源 DB 的 stat/content 指纹自备份以来未变（dev/ino/nlink/
 * mode/size/mtime/sha256）。任何不一致都抛错 —— reset 一次都不会执行。
 */
export function revalidateSqliteCutoverTarget(
  environment: StorageEnvironment,
  cli: CutoverCliOptions,
  target: SqliteCutoverTarget,
  verification: PublishedBackupVerification,
): void {
  const fresh = resolveSqliteCutoverTarget(environment, cli);
  for (const [label, current, resolved] of [
    ["data directory", target.dataDir, fresh.dataDir],
    ["agent directory", target.agentDir, fresh.agentDir],
    ["database file", target.dbPath, fresh.dbPath],
    ["credential path", target.authPath, fresh.authPath],
  ] as const) {
    if (canonicalCutoverPath(current, label) !== canonicalCutoverPath(resolved, label)) {
      throw new Error(`cutover: the resolved ${label} changed between backup and reset; refusing to reset (zero deletion performed)`);
    }
  }
  assertSourceRootsMatch(verification.sourceRoots, { dataDir: target.dataDir, agentDir: target.agentDir, dbPath: target.dbPath });
  if (!verification.sqliteTreeBinding) {
    throw new Error("cutover: the published backup has no SQLite DB/WAL/SHM binding; refusing to reset (zero deletion performed)");
  }
  assertSqliteSourceTreeUnchanged(verification.sqliteTreeBinding, target.dbPath);
}

/**
 * Reset 前 PG binding 复验：重新查询连接 identity（current_database()/current_schema()）
 * 与 cluster/server/database/schema identity（优先 pg_control_system().system_identifier，
 * 并核对 database/schema OID、server addr/port、cluster_name），断言 effective schema 仍等于
 * --target-schema、manifest 记录的 identity 一致。cluster identity 不可查询或为空时安全
 * fail（绝不回退到同名哈希）；任何 identity mismatch 都抛错 —— 零 reset。
 */
export async function revalidatePostgresCutoverTarget(
  client: CutoverPgClient,
  schema: string,
  target: PostgresCutoverTarget,
  verification: PublishedBackupVerification,
): Promise<void> {
  let row: Record<string, unknown>;
  try {
    const identity = await client.query(
      "SELECT current_database() AS database, current_schema() AS schema, " +
      "(SELECT system_identifier::text FROM pg_control_system()) AS system_identifier, " +
      "(SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid, " +
      "(SELECT oid::text FROM pg_namespace WHERE nspname = current_schema()) AS schema_oid, " +
      "inet_server_addr()::text AS server_address, inet_server_port()::text AS server_port, " +
      "current_setting('cluster_name') AS cluster_name",
    ) as { rows: Array<Record<string, unknown>> };
    row = identity.rows[0] ?? {};
  } catch (error) {
    throw new Error(`cutover: PostgreSQL cluster identity could not be queried during revalidation; refusing to reset (zero deletion performed)${error instanceof Error && error.message ? `: ${error.message}` : ""}`);
  }
  const text = (key: string): string | null => (typeof row[key] === "string" && (row[key] as string).length > 0 ? row[key] as string : null);
  const database = text("database");
  const effectiveSchema = text("schema");
  if (!database || !effectiveSchema) {
    throw new Error("cutover: PostgreSQL connection returned no target identity during revalidation; refusing to reset");
  }
  if (effectiveSchema !== schema) {
    throw new Error(`cutover: connection effective schema (${effectiveSchema}) no longer matches --target-schema (${schema}) during revalidation; refusing to reset`);
  }
  if (!verification.postgres) {
    throw new Error("cutover: the published backup has no PostgreSQL database/schema identity binding; refusing to reset (zero deletion performed)");
  }
  const binding = verification.postgres;
  // Cluster identity: pg_control_system() is the authoritative guard against a
  // same-named database in a different cluster. Absent on either side = fail.
  const systemIdentifier = text("system_identifier");
  if (!systemIdentifier || !binding.systemIdentifier) {
    throw new Error("cutover: the PostgreSQL cluster system identifier is unavailable (permission denied or empty) during revalidation; refusing to rely on same-name identity hashes (zero deletion performed)");
  }
  if (binding.systemIdentifier !== systemIdentifier) {
    throw new Error("cutover: the published backup was taken from a different PostgreSQL cluster (system identifier mismatch); refusing to reset (zero deletion performed)");
  }
  const databaseOid = text("database_oid");
  const schemaOid = text("schema_oid");
  if (!databaseOid || !schemaOid || binding.databaseOid !== databaseOid || binding.schemaOid !== schemaOid) {
    throw new Error("cutover: the published backup was taken from a different PostgreSQL database/schema identity (OID mismatch); refusing to reset (zero deletion performed)");
  }
  if (binding.databaseIdentity !== postgresIdentity(database, "database") || binding.schemaIdentity !== postgresIdentity(effectiveSchema, "schema")) {
    throw new Error("cutover: the published backup was taken from a different PostgreSQL database/schema identity; refusing to reset (zero deletion performed)");
  }
  // Server placement: the reset connection must sit on the same server the
  // backup/dump identity was bound to (null on both sides is a unix-socket match).
  for (const [label, manifestValue, currentValue] of [
    ["server address", binding.serverAddress ?? null, text("server_address")],
    ["server port", binding.serverPort ?? null, text("server_port")],
    ["cluster name", binding.clusterName ?? null, text("cluster_name")],
  ] as const) {
    if (manifestValue !== currentValue) {
      throw new Error(`cutover: the PostgreSQL ${label} changed between the backup and the reset connection; refusing to reset (zero deletion performed)`);
    }
  }
  assertSourceRootsMatch(verification.sourceRoots, { dataDir: target.dataDir, agentDir: target.agentDir });
}

/** 最小 PG 客户端面：reset 只需要 DDL/标量查询。 */
export interface CutoverPgClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * 受控 PG reset（破坏性；只能由 runControlledCutover 在备份验证成功后调用）：
 * 仅 DROP 允许列表内的专用 schema（CASCADE）并 CREATE 同名 schema + 最小必要授权；
 * 绝不 DROP DATABASE、绝不触碰 public/系统 schema、绝不删除数据库。
 * 调用方必须先确认连接 effective schema（current_schema()）等于该 target。
 */
export async function resetPostgresSchemaForCutover(client: CutoverPgClient, schema: string): Promise<void> {
  const validated = validateCutoverTargetSchema(schema);
  const quoted = quotePostgresIdentifier(validated);
  await client.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
  await client.query(`CREATE SCHEMA ${quoted}`);
  const role = await client.query("SELECT current_user");
  const currentRole = role.rows[0]?.current_user;
  if (typeof currentRole !== "string" || currentRole.length === 0) throw new Error("cutover: could not resolve the connecting role for minimal grants");
  await client.query(`GRANT USAGE, CREATE ON SCHEMA ${quoted} TO ${quotePostgresIdentifier(currentRole)}`);
}

/** 由 reset 门禁租用的专用 PoolClient（真实 pg PoolClient 满足此面）。 */
export interface CutoverPgPoolClient extends CutoverPgClient {
  release(err?: Error | boolean): void;
}

/** 最小 Pool 面：reset 门禁只租用一个专用 client，绝不经 pool.query 轮换连接。 */
export interface CutoverPgPoolLike {
  connect(): Promise<CutoverPgPoolClient>;
}

/**
 * PG reset 专用同连接门禁（P0：identity 复验与 DROP/CREATE/GRANT 必须在同一
 * PoolClient / 同一 transaction 内完成，杜绝 Pool 连接切换让“复验通过的连接”
 * 与“执行 DDL 的连接”错位）：
 * - revalidate：租用专用 client → BEGIN (REPEATABLE READ) → 在该事务内运行完整
 *   identity 复验；复验失败 → ROLLBACK + release，零删除；
 * - reset：同一 client / 同一事务内执行 JSONL file reset + DROP/CREATE/GRANT，
 *   COMMIT 成功才生效；任何失败 → ROLLBACK（schema DDL 回滚；JSONL 删除不参与
 *   数据库事务，失败路径下文件可能已删但 DDL 未提交——备份保留、绝不报成功）；
 * - cleanup：任何路径结束后的兑底 rollback + release（幂等）；
 * - 绝不 DROP DATABASE；schema 仍受 validateCutoverTargetSchema allowlist 约束。
 */
export function openPostgresDedicatedResetGate(
  pool: CutoverPgPoolLike,
  schema: string,
  target: PostgresCutoverTarget,
): PostgresDedicatedResetGate {
  let client: CutoverPgPoolClient | undefined;
  let transactionOpen = false;
  const begin = async (): Promise<CutoverPgPoolClient> => {
    if (client && transactionOpen) return client;
    if (client) { try { client.release(); } catch { /* stale client already gone */ } client = undefined; }
    const acquired = await pool.connect();
    client = acquired;
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    transactionOpen = true;
    return client;
  };
  const rollback = async (): Promise<void> => {
    if (!transactionOpen || !client) { transactionOpen = false; return; }
    transactionOpen = false;
    try { await client.query("ROLLBACK"); }
    catch { /* release below; the gate already failed on the original error */ }
  };
  const release = (): void => {
    const current = client;
    client = undefined;
    try { current?.release(); } catch { /* already released */ }
  };
  return {
    async revalidate(verification: PublishedBackupVerification): Promise<void> {
      const tx = await begin();
      try {
        await revalidatePostgresCutoverTarget(tx, schema, target, verification);
      } catch (error) {
        await rollback();
        throw error;
      }
    },
    async reset(): Promise<void> {
      if (!client || !transactionOpen) {
        throw new Error("cutover: the dedicated PostgreSQL reset client/transaction is not open; revalidation must run first (zero deletion performed)");
      }
      try {
        // 与既有顺序一致：先清 dataDir 的 sessions//projects/ JSONL 根，再在同一
        // client/transaction 内 DROP/CREATE/GRANT，COMMIT 成功才生效。
        resetPostgresDataForCutover(target);
        await resetPostgresSchemaForCutover(client, schema);
        await client.query("COMMIT");
        transactionOpen = false;
      } catch (error) {
        await rollback();
        throw error;
      } finally {
        release();
      }
    },
    async cleanup(): Promise<void> {
      await rollback();
      release();
    },
  };
}

/** 同连接 reset 门禁的公开面（revalidate → reset → cleanup）。 */
export interface PostgresDedicatedResetGate {
  readonly revalidate: (verification: PublishedBackupVerification) => Promise<void>;
  readonly reset: () => Promise<void>;
  readonly cleanup: () => Promise<void>;
}

export interface CutoverOperations {
  /** 步骤 1：pre-reset 加密备份（旧 RC 库无 ledger 也必须可备份，kind=pre-reset）。 */
  readonly createBackup: () => Promise<BackupResult | PostgresBackupResult>;
  /** 步骤 2：已发布备份 COMPLETE/manifest/payload 完整性复核。 */
  readonly verifyBackup: (backup: BackupResult | PostgresBackupResult) => PublishedBackupVerification;
  /**
   * 步骤 2.5（可选但强烈建议）：reset 前重新解析/复验 target。收到已验证的备份
   * binding（canonical source roots + SQLite DB/WAL/SHM 指纹或 PG cluster/database/schema identity），
   * 任何目标变化/identity mismatch 都必须抛错——reset 一次都不会执行。
   */
  readonly revalidateBeforeReset?: (verification: PublishedBackupVerification) => Promise<void> | void;
  /** 步骤 3：受控 reset（仅在备份验证 + target 复验通过后执行一次）。 */
  readonly reset: () => Promise<void> | void;
  /** 步骤 4：Manifest-driven migration apply。 */
  readonly applyMigration: () => Promise<MigrationRunResult>;
  /** 步骤 5：严格 verify（必须到达 canonical head）。 */
  readonly verifyMigration: () => Promise<MigrationRunResult>;
}

export interface CutoverReport {
  readonly status: "success";
  readonly mode: "apply";
  readonly dialect: "SQLite" | "PostgreSQL";
  readonly backup: {
    readonly id: string;
    readonly kind: string;
    readonly checksum: string;
    readonly version: number | null;
    readonly migrationLedgerPresent: boolean;
  };
  readonly migration: {
    readonly status: string;
    readonly appliedVersion: number;
    readonly pending: number;
  };
  readonly verify: {
    readonly status: string;
    readonly appliedVersion: number;
    readonly pending: number;
  };
  /** 旧库无 migration ledger 时为 true：备份仅承诺包完整性，不假称 legacy 数据经 migration verify。 */
  readonly legacy: boolean;
  readonly notes: readonly string[];
  /** PG 专用：被 reset 的 allowlisted schema 名；SQLite 恒为 null（不输出文件路径）。 */
  readonly schema: string | null;
}

function assertHeadApplyResult(result: MigrationRunResult): void {
  if (result.mode !== "apply" || result.status !== "applied" || result.pending.length !== 0 || result.appliedVersion === null) {
    throw new Error("cutover: migration apply did not reach the migration head; the pre-reset backup is retained and no success is reported");
  }
}

function assertHeadVerification(result: MigrationRunResult, appliedVersion: number, canonicalHead: number): void {
  if (result.mode !== "verify" || result.status !== "verified" || result.pending.length !== 0 || result.appliedVersion !== appliedVersion || appliedVersion !== canonicalHead) {
    throw new Error("cutover: post-reset verification did not confirm the canonical migration head; the pre-reset backup is retained and no success is reported");
  }
}

/**
 * 受控 cutover 编排：backup → verify backup → reset → migration apply → strict verify head。
 * - 任一备份/复核失败：绝不 reset，绝不迁移，无成功输出；
 * - reset 后 migration 失败：保留备份，绝不自动 restore/down（runbook 人工恢复），无成功输出；
 * - 成功输出 = 脱敏 machine report（无路径/URL/凭证）。
 */
export async function runControlledCutover(
  authorization: CutoverAuthorization,
  operations: CutoverOperations,
  options: { readonly dialect: "SQLite" | "PostgreSQL"; readonly schema?: string; readonly onStage?: StageReporter } ,
): Promise<CutoverReport> {
  if (authorization.token !== "rc-data-reset-authorized") throw new Error("cutover: unauthorized orchestration call");
  const report = options.onStage;
  const budgets = APPLY_STAGE_BUDGET_MS;
  // The backup stage is the only abortable stage (external age children);
  // on timeout the hung age child is SIGKILLed and the gate waits for the
  // confirmed settlement before returning. reset/migration stages are
  // non-cancellable: no abort, no timeout return while they still run.
  const backup = await withStageTimeout("backup", budgets.backup, operations.createBackup, { abort: () => abortActiveAgeChild() }, report);
  const verification = await withStageTimeout("backup-verify", budgets.backupVerify, () => Promise.resolve(operations.verifyBackup(backup)), undefined, report);
  if (verification.kind !== "pre-reset") throw new Error("cutover: pre-reset backup verification returned an unexpected kind; refusing to reset");
  if (authorization.token !== "rc-data-reset-authorized") throw new Error("cutover: unauthorized orchestration call before reset");
  // Binding revalidation happens strictly before any destructive step: a
  // target that changed after the backup (replaced DB, moved roots, different
  // database/schema identity) fails here and performs zero deletion.
  await withStageTimeout("reset", budgets.reset, () => Promise.resolve(operations.revalidateBeforeReset?.(verification)), undefined, report);
  await withStageTimeout("reset", budgets.reset, () => Promise.resolve(operations.reset()), undefined, report);
  const migration = await withStageTimeout("migration-apply", budgets.migrationApply, operations.applyMigration, undefined, report);
  assertHeadApplyResult(migration);
  const appliedVersion = migration.appliedVersion;
  if (appliedVersion === null) throw new Error("cutover: migration apply did not reach the migration head; the pre-reset backup is retained");
  const verify = await withStageTimeout("migration-verify", budgets.migrationVerify, operations.verifyMigration, undefined, report);
  const canonicalHead = migrationDefinitions.at(-1)!.version;
  assertHeadVerification(verify, appliedVersion, canonicalHead);
  const legacy = verification.version === null;
  return {
    status: "success",
    mode: "apply",
    dialect: options.dialect,
    backup: {
      id: verification.id,
      kind: verification.kind,
      checksum: verification.checksum,
      version: verification.version,
      migrationLedgerPresent: verification.version !== null,
    },
    migration: { status: migration.status, appliedVersion, pending: migration.pending.length },
    verify: { status: verify.status, appliedVersion: verify.appliedVersion ?? -1, pending: verify.pending.length },
    legacy,
    notes: legacy
      ? ["pre-reset backup captured a legacy database without a migration ledger; package integrity was verified, but migration verifiability of the legacy data is not claimed"]
      : [],
    schema: options.schema ?? null,
  };
}

/**
 * SQLite migration apply 到刚 reset 的空 DB：打开全新连接并按 Manifest 建基线。
 * 失败时由调用方关闭连接；绝不自动 restore。
 */
export async function applySqliteMigrationsAfterReset(dbPath: string): Promise<MigrationRunResult> {
  const db = new DatabaseSync(dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
  try {
    db.exec("PRAGMA journal_mode=WAL");
    return await runSqliteMigrations(db, { mode: "apply" });
  } finally {
    try { db.close(); } catch { /* preserve the original migration error */ }
  }
}
