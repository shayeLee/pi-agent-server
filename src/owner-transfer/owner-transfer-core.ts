// WP5D-4 IP→IP owner transfer 核心（离线显式工具）。
//
// 安全边界（全部 fail-closed）：
// - 任何 owner 转移都必须先经 authorizeOwnerTransfer：显式确认词
//   --confirm-transfer TRANSFER_IP_OWNERSHIP + --maintenance-window CONFIRMED。
//   --maintenance-window 是运维声明（"我声明当前处于维护窗口"），不是进程锁：
//   数据库侧串行化由 SQLite BEGIN IMMEDIATE 与 PG 的 session-level advisory lock
//   承担（POSTGRES_MIGRATION_LOCK_KEY：事务外参数化 SELECT pg_advisory_lock 取得，
//   与迁移引擎同 key 的 xact lock 冲突；COMMIT/ROLLBACK 后显式 pg_advisory_unlock
//   验证返回 true 才把 client 归还池），绝不基于该声明获取任何分布式锁。
// - 仅更新 projects.owner_key / sessions.owner_key 两列，绝不触碰 JSONL 文件、
//   其他表、策略文件、token 绑定或角色（接收方继承自己的 IP 画像）。
// - 不合并：target owner 必须完全为空（无 projects 且无 sessions）。
// - source owner 必须持有至少 1 个资源。
// - 默认项目行（DEFAULT_PROJECT_ID, owner=''）必须存在且 owner 保持空串；其下
//   source session 的 owner_key 正常转移。
// - 拒绝错位引用：source session 引用非 source 自定义项目、或他人 session 引用
//   source 自定义项目 → 整个事务 ROLLBACK，零生效。
// - apply 顺序固定：strict pre-owner-transfer 加密备份 → verify published →
//   target binding 复验 → 事务内 transfer/verify。任何失败 = 零/回滚，无自动 restore。
// - 报告只含 subject sha256、counts 与 backup 元信息；绝不输出原始 IP/owner/path/url。
// - 本模块不接入 startServer、不启动服务、不安装 scheduler/timer。

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import {
  abortActiveAgeChild,
  assertSqliteSourceTreeUnchanged,
  isWithin,
  verifyPublishedBackup,
  type BackupResult,
  type PostgresBackupResult,
  type PublishedBackupVerification,
} from "../backup/backup-core.js";
import { parsePostgresConnectionUrl, postgresIdentity, quotePostgresIdentifier } from "../backup/postgres-backup-core.js";
import { parseIpStrict } from "../core/cidr.js";
import { identityKey } from "../core/user-identity.js";
import { DEFAULT_PROJECT_ID } from "../application/ports/project-store-port.js";
import { POSTGRES_MIGRATION_LOCK_KEY } from "../storage/migration-engine.js";
import {
  resolveBackupCliPaths,
  resolveCliAuthPath,
  validateMigrationCliPathValues,
  type StorageEnvironment,
} from "../storage/storage-config.js";
import { APPLY_STAGE_BUDGET_MS, withStageTimeout, type StageReporter } from "../backup/stage-guard.js";

export const OWNER_TRANSFER_USAGE =
  "用法：pnpm owner-transfer -- --dry-run|--apply --source-ip CANONICAL_IP --target-ip CANONICAL_IP " +
  "--confirm-transfer TRANSFER_IP_OWNERSHIP --maintenance-window CONFIRMED --backup-root ABSOLUTE_DIR " +
  "--age-recipient-file ABSOLUTE_FILE [--target-schema SCHEMA（仅 PostgreSQL）]";

/** 不可绕过的确认词：必须逐字匹配，大小写敏感，无默认值。 */
export const OWNER_TRANSFER_CONFIRM_TOKEN = "TRANSFER_IP_OWNERSHIP";

export interface OwnerTransferCliOptions {
  readonly mode: "apply" | "dry-run";
  readonly sourceIp: string;
  readonly targetIp: string;
  readonly confirmTransfer?: string;
  readonly maintenanceWindowConfirmed: boolean;
  readonly backupRoot?: string;
  readonly ageRecipientFile?: string;
  /** PostgreSQL 专用：显式 authenticated target schema（必须等于连接 effective schema）。 */
  readonly targetSchema?: string;
}

/**
 * 严格解析 CLI 参数：未知参数一律拒绝（不回显参数值——可能含 token/密钥）；重复参数拒绝；
 * 确认词逐字匹配；source/target IP 必须是严格 canonical IP 文本（`parseIpStrict` 的
 * canonical-or-mapped 之外一律拒绝；task 冻结语义要求 --source-ip/--target-ip 为 canonical，
 * 故 mapped 形式同样拒绝，绝不隐式归一）；source != target。dry-run 与 apply 要求同一套
 * 完整确认（dry-run 是 apply 的命令行彩排，零写入）。
 */
export function parseOwnerTransferArgs(args: readonly string[]): OwnerTransferCliOptions {
  const actual = args[0] === "--" ? args.slice(1) : args;
  const modes = actual.filter((arg) => arg === "--apply" || arg === "--dry-run");
  if (modes.length !== 1) throw new Error(OWNER_TRANSFER_USAGE);
  const mode = modes[0]!.slice(2) as OwnerTransferCliOptions["mode"];
  let sourceIp: string | undefined;
  let targetIp: string | undefined;
  let confirmTransfer: string | undefined;
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
      if (arg !== label || !actual[index + 1]) throw new Error(`${OWNER_TRANSFER_USAGE}；${label} 需要一个值`);
      index++;
      return actual[index]!;
    };
    const takeCanonicalIp = (label: string, target: (value: string) => void): void => {
      const value = takeValue(label);
      let parsed;
      try { parsed = parseIpStrict(value); }
      catch { throw new Error(`${OWNER_TRANSFER_USAGE}；${label} 必须是规范 canonical IP 文本`); }
      // Strict canonical: the argument must be byte-identical to the canonical
      // text (IPv4-mapped forms are accepted by parseIpStrict for admission,
      // but a transfer subject must be unambiguous canonical).
      if (parsed.text !== value) {
        throw new Error(`${OWNER_TRANSFER_USAGE}；${label} 必须是规范 canonical IP 文本（无前导零/大写/非压缩形式）`);
      }
      target(value);
    };
    if (arg === "--source-ip" || arg.startsWith("--source-ip=")) {
      if (sourceIp !== undefined) throw new Error(`${OWNER_TRANSFER_USAGE}；--source-ip 只能出现一次`);
      takeCanonicalIp("--source-ip", (value) => { sourceIp = value; });
    } else if (arg === "--target-ip" || arg.startsWith("--target-ip=")) {
      if (targetIp !== undefined) throw new Error(`${OWNER_TRANSFER_USAGE}；--target-ip 只能出现一次`);
      takeCanonicalIp("--target-ip", (value) => { targetIp = value; });
    } else if (arg === "--confirm-transfer" || arg.startsWith("--confirm-transfer=")) {
      if (confirmTransfer !== undefined) throw new Error(`${OWNER_TRANSFER_USAGE}；--confirm-transfer 只能出现一次`);
      confirmTransfer = takeValue("--confirm-transfer");
    } else if (arg === "--maintenance-window" || arg.startsWith("--maintenance-window=")) {
      if (maintenanceWindowConfirmed) throw new Error(`${OWNER_TRANSFER_USAGE}；--maintenance-window 只能出现一次`);
      // Strict literal match: only the exact original `CONFIRMED` is accepted.
      if (takeValue("--maintenance-window") !== "CONFIRMED") {
        throw new Error(`${OWNER_TRANSFER_USAGE}；--maintenance-window 必须为 CONFIRMED（逐字匹配，大小写/空白不容忍）`);
      }
      maintenanceWindowConfirmed = true;
    } else if (arg === "--backup-root" || arg.startsWith("--backup-root=")) {
      if (backupRoot !== undefined) throw new Error(`${OWNER_TRANSFER_USAGE}；--backup-root 只能出现一次`);
      backupRoot = takeValue("--backup-root");
    } else if (arg === "--age-recipient-file" || arg.startsWith("--age-recipient-file=")) {
      if (ageRecipientFile !== undefined) throw new Error(`${OWNER_TRANSFER_USAGE}；--age-recipient-file 只能出现一次`);
      ageRecipientFile = takeValue("--age-recipient-file");
    } else if (arg === "--target-schema" || arg.startsWith("--target-schema=")) {
      if (targetSchema !== undefined) throw new Error(`${OWNER_TRANSFER_USAGE}；--target-schema 只能出现一次`);
      targetSchema = takeValue("--target-schema");
    } else {
      // 不回显未知参数：命令行可能意外携带 token/密钥等敏感值。
      throw new Error(`${OWNER_TRANSFER_USAGE}；未知参数`);
    }
  }
  if (!sourceIp || !targetIp) throw new Error(`${OWNER_TRANSFER_USAGE}；必须显式提供 --source-ip 与 --target-ip`);
  if (sourceIp === targetIp) throw new Error(`${OWNER_TRANSFER_USAGE}；--source-ip 与 --target-ip 必须不同`);
  if (confirmTransfer !== OWNER_TRANSFER_CONFIRM_TOKEN) {
    throw new Error(`${OWNER_TRANSFER_USAGE}；--confirm-transfer 必须为 ${OWNER_TRANSFER_CONFIRM_TOKEN}`);
  }
  if (!maintenanceWindowConfirmed) throw new Error(`${OWNER_TRANSFER_USAGE}；必须显式提供 --maintenance-window CONFIRMED`);
  if (!backupRoot || !path.isAbsolute(backupRoot)) throw new Error(`${OWNER_TRANSFER_USAGE}；必须显式提供绝对 --backup-root`);
  if (!ageRecipientFile || !path.isAbsolute(ageRecipientFile)) throw new Error(`${OWNER_TRANSFER_USAGE}；必须显式提供绝对 --age-recipient-file`);
  return { mode, sourceIp, targetIp, confirmTransfer, maintenanceWindowConfirmed, backupRoot, ageRecipientFile, targetSchema };
}

/** 结构化授权凭证：只能由 authorizeOwnerTransfer 产生；转移步骤执行前后都会重新校验。 */
export interface OwnerTransferAuthorization {
  readonly token: "ip-ownership-transfer-authorized";
}

const AUTHORIZED: OwnerTransferAuthorization = { token: "ip-ownership-transfer-authorized" };

/**
 * 授权门禁：逐字确认词 + 维护窗口声明二者缺一不可。这是 owner 转移的唯一入口；未经授权时
 * 零写入。维护窗口只是运维声明（见本模块顶注），绝不在授权外获取任何进程锁。
 */
export function authorizeOwnerTransfer(cli: OwnerTransferCliOptions): OwnerTransferAuthorization {
  if (cli.confirmTransfer !== OWNER_TRANSFER_CONFIRM_TOKEN) {
    throw new Error(`owner-transfer: confirmation token mismatch; the exact token --confirm-transfer ${OWNER_TRANSFER_CONFIRM_TOKEN} is required`);
  }
  if (!cli.maintenanceWindowConfirmed) throw new Error("owner-transfer: --maintenance-window CONFIRMED is required");
  return AUTHORIZED;
}

/** 派生 owner_key（与既有 UserIdentity.identityKey 完全一致：ip:<canonical IP>）。 */
export function ownerKeyForIp(canonicalIp: string): string {
  return identityKey({ kind: "ip", ip: canonicalIp });
}

/** 报告用 subject 哈希（与 admission 后置日志同一派生：sha256(identityKey).slice(0,16)）。 */
export function subjectHashForIp(canonicalIp: string): string {
  return createHash("sha256").update(ownerKeyForIp(canonicalIp), "utf8").digest("hex").slice(0, 16);
}

/**
 * 纯校验：PG 仅接受显式的业务 schema —— public 永远拒绝（用户明确无业务 public
 * schema，backup/restore/owner-transfer 一律不接收 public 源），
 * information_schema / pg_* / pi_restore_* / pi_cutover_* 也永远拒绝（pi_cutover_* 是
 * 已移除的受控 cutover 专用前缀，保留拒绝以隔离旧命名）。owner transfer 在真实业务 schema 上运行。
 */
export function validateOwnerTransferSchema(schema: string): string {
  const trimmed = schema.trim();
  if (trimmed !== schema || trimmed.length === 0) {
    throw new Error("owner-transfer: --target-schema must be a non-blank schema name without surrounding whitespace");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) throw new Error("owner-transfer: --target-schema must be a plain SQL identifier");
  if (trimmed.toLowerCase() === "information_schema") throw new Error("owner-transfer: information_schema is never allowed as the transfer schema");
  if (trimmed.toLowerCase() === "public") throw new Error("owner-transfer: public is never allowed as the transfer schema (no business public schema)");
  if (trimmed.toLowerCase().startsWith("pg_")) throw new Error("owner-transfer: system pg_* schemas are never allowed as the transfer schema");
  if (trimmed.toLowerCase().startsWith("pi_restore_")) throw new Error("owner-transfer: pi_restore_* schemas belong to restore drills and are rejected");
  if (trimmed.toLowerCase().startsWith("pi_cutover_")) throw new Error("owner-transfer: pi_cutover_* schemas were the removed controlled-cutover prefix and are rejected");
  return trimmed;
}

// ---------------------------------------------------------------------------
// 纯状态校验（SQLite 与 PostgreSQL 共用同一语义；只读分析 + 事务内复验都走这里）
// ---------------------------------------------------------------------------

export interface OwnerProjectRow {
  readonly id: string;
  readonly ownerKey: string;
}

export interface OwnerSessionRow {
  readonly id: string;
  readonly ownerKey: string;
  readonly projectId: string;
}

export interface OwnerTransferState {
  readonly projects: readonly OwnerProjectRow[];
  readonly sessions: readonly OwnerSessionRow[];
}

export interface OwnerTransferPlan {
  readonly projectsTransferred: number;
  readonly sessionsTransferred: number;
  readonly defaultProjectOwnerPreserved: true;
}

function ownerTransferFail(message: string): never {
  throw new Error(`owner-transfer: ${message}`);
}

/**
 * 事务前校验（纯函数）：默认项目行 owner='' 必须存在且不转移；target owner 必须完全
 * 为空（不合并）；source owner 至少 1 个资源；错位引用（source session 引用非 source
 * 自定义项目、他人 session 引用 source 自定义项目）一律拒绝。返回 pre-counts。
 */
export function planOwnerTransfer(params: {
  readonly sourceOwnerKey: string;
  readonly targetOwnerKey: string;
  readonly projects: readonly OwnerProjectRow[];
  readonly sessions: readonly OwnerSessionRow[];
}): OwnerTransferPlan {
  const { sourceOwnerKey, targetOwnerKey, projects, sessions } = params;
  if (sourceOwnerKey === targetOwnerKey) ownerTransferFail("source and target owner keys are identical; refusing a no-op transfer");

  // 默认项目行必须存在且 owner 为空串；default 项目永不转移。
  const defaultProject = projects.find((project) => project.id === DEFAULT_PROJECT_ID);
  if (!defaultProject) ownerTransferFail("the default project row (owner '') does not exist; refusing transfer");
  if (defaultProject.ownerKey !== "") ownerTransferFail("the default project row has a non-empty owner; refusing transfer");

  // target owner 必须完全为空：不合并、不覆盖。
  const targetProjects = projects.filter((project) => project.ownerKey === targetOwnerKey);
  const targetSessions = sessions.filter((session) => session.ownerKey === targetOwnerKey);
  if (targetProjects.length !== 0 || targetSessions.length !== 0) {
    ownerTransferFail(`the target owner already holds ${targetProjects.length} project(s) and ${targetSessions.length} session(s); merge is not supported`);
  }

  // source owner 必须持有至少 1 个资源。
  const sourceProjects = projects.filter((project) => project.ownerKey === sourceOwnerKey);
  const sourceSessions = sessions.filter((session) => session.ownerKey === sourceOwnerKey);
  if (sourceProjects.length + sourceSessions.length === 0) {
    ownerTransferFail("the source owner holds no resources to transfer");
  }

  // 自定义项目 owner 映射（default 项目是共享的，owner 恒空串）。
  const customProjectOwner = new Map<string, string>();
  for (const project of projects) if (project.id !== DEFAULT_PROJECT_ID) customProjectOwner.set(project.id, project.ownerKey);

  // source session 只能引用 default 项目或 source 自定义项目。
  for (const session of sourceSessions) {
    if (session.projectId === DEFAULT_PROJECT_ID) continue;
    const owner = customProjectOwner.get(session.projectId);
    if (owner === undefined) ownerTransferFail("a source session references a custom project that does not exist; refusing transfer");
    if (owner !== sourceOwnerKey) ownerTransferFail("a source session references a custom project owned by another owner; refusing transfer");
  }

  // 他人 session 不得引用 source 自定义项目（default 项目共享，不受此限）。
  const sourceProjectIds = new Set(sourceProjects.map((project) => project.id));
  for (const session of sessions) {
    if (session.ownerKey === sourceOwnerKey) continue;
    if (sourceProjectIds.has(session.projectId)) {
      ownerTransferFail("a session owned by another owner references a project owned by the source owner; refusing transfer");
    }
  }

  return {
    projectsTransferred: sourceProjects.length,
    sessionsTransferred: sourceSessions.length,
    defaultProjectOwnerPreserved: true,
  };
}

/**
 * 事务后校验（纯函数）：source owner 必须归零、target owner 必须恰好持有 plan 数量、
 * default 项目 owner 仍为空串。任何不一致都抛错（调用方随之 ROLLBACK）。
 */
export function verifyOwnerTransferOutcome(params: {
  readonly sourceOwnerKey: string;
  readonly targetOwnerKey: string;
  readonly plan: OwnerTransferPlan;
  readonly projects: readonly OwnerProjectRow[];
  readonly sessions: readonly OwnerSessionRow[];
}): void {
  const { sourceOwnerKey, targetOwnerKey, plan, projects, sessions } = params;
  const remainingSource = projects.filter((project) => project.ownerKey === sourceOwnerKey).length +
    sessions.filter((session) => session.ownerKey === sourceOwnerKey).length;
  if (remainingSource !== 0) ownerTransferFail("post-transfer verification failed: the source owner still holds resources; rolling back");
  const targetProjects = projects.filter((project) => project.ownerKey === targetOwnerKey).length;
  const targetSessions = sessions.filter((session) => session.ownerKey === targetOwnerKey).length;
  if (targetProjects !== plan.projectsTransferred || targetSessions !== plan.sessionsTransferred) {
    ownerTransferFail("post-transfer verification failed: the target owner does not hold exactly the transferred resource counts; rolling back");
  }
  const defaultProject = projects.find((project) => project.id === DEFAULT_PROJECT_ID);
  if (!defaultProject || defaultProject.ownerKey !== "") {
    ownerTransferFail("post-transfer verification failed: the default project owner changed; rolling back");
  }
}

// ---------------------------------------------------------------------------
// 路径安全（与 backup/migrate 同一 no-symlink-ancestor + canonical 语义）
// ---------------------------------------------------------------------------

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
    if (entry.isSymbolicLink() && !trustedSystemAlias) throw new Error(`owner-transfer: ${label} contains a symbolic-link ancestor`);
  }
}

export function canonicalOwnerTransferPath(input: string, label: string): string {
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


function assertRegularSingleLink(file: string, label: string): void {
  assertNoSymlinkAncestors(file, label);
  let entry: ReturnType<typeof lstatSync>;
  try { entry = lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`owner-transfer: ${label} does not exist`);
    throw error;
  }
  if (entry.isSymbolicLink()) throw new Error(`owner-transfer: ${label} is a symbolic link`);
  if (!entry.isFile()) throw new Error(`owner-transfer: ${label} must be a regular file`);
  if (entry.nlink > 1) throw new Error(`owner-transfer: ${label} is a hardlink (nlink=${entry.nlink})`);
}

export interface SqliteOwnerTransferTarget {
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

/**
 * SQLite owner-transfer target 解析（纯安全检查，零写入）：
 * - AGENT_CWD / DATA_DIR / DB_PATH 三者都必须显式提供绝对路径（绝不静默继承 cwd/默认值）；
 * - 仅允许解析后的文件 DB：拒绝 :memory: 命名、symlink、hardlink、不存在的 DB；
 * - DB_PATH 解析后必须位于 DATA_DIR 内（与离线 backup/migrate 安全基线一致）；
 * - dataDir 不得与 cwd 任一方向重叠；backup root 不得与 dataDir/agentDir/dbPath 任一方向重叠；
 * - 凭证位置（解析后的 authPath）解析出来仅供 backup 白名单/排除共用（backup core 会复核）。
 */
export function resolveSqliteOwnerTransferTarget(environment: StorageEnvironment, cli: OwnerTransferCliOptions): SqliteOwnerTransferTarget {
  if (!cli.backupRoot || !cli.ageRecipientFile) throw new Error("owner-transfer: --backup-root and --age-recipient-file are required");
  const agentCwd = nonBlank(environment.AGENT_CWD);
  const dataDirValue = nonBlank(environment.DATA_DIR);
  const dbPathValue = nonBlank(environment.DB_PATH);
  if (!agentCwd || !dataDirValue || !dbPathValue) {
    throw new Error("owner-transfer: explicit absolute AGENT_CWD, DATA_DIR, and DB_PATH are required; the database target is never silently derived from the process cwd");
  }
  if (!path.isAbsolute(agentCwd) || !path.isAbsolute(dataDirValue) || !path.isAbsolute(dbPathValue)) {
    throw new Error("owner-transfer: AGENT_CWD, DATA_DIR, and DB_PATH must be absolute paths");
  }
  validateMigrationCliPathValues(environment);
  const paths = resolveBackupCliPaths(environment, cli.backupRoot, cli.ageRecipientFile, agentCwd);
  const cwd = canonicalOwnerTransferPath(paths.cwd, "agent cwd");
  const dataDir = canonicalOwnerTransferPath(paths.dataDir, "data directory");
  const agentDir = canonicalOwnerTransferPath(paths.agentDir, "agent directory");
  const authPath = canonicalOwnerTransferPath(paths.authPath, "credential path");
  const backupRoot = canonicalOwnerTransferPath(paths.backupRoot, "backup root");
  const ageRecipientFile = canonicalOwnerTransferPath(paths.ageRecipientFile, "age recipient file");
  if (dbPathValue.endsWith(":memory:")) throw new Error("owner-transfer: in-memory SQLite targets are never allowed; resolve to a file database first");
  const dbPath = canonicalOwnerTransferPath(dbPathValue, "SQLite target database");
  assertRegularSingleLink(dbPath, "SQLite target database");
  if (isWithin(cwd, dataDir) || isWithin(dataDir, cwd)) {
    throw new Error("owner-transfer: the data directory must not overlap the agent cwd in either direction; use a dedicated absolute DATA_DIR");
  }
  // Same safety baseline as the offline backup/migrate resolvers: the target database
  // must live inside the resolved data directory (canonical on both sides).
  if (!isWithin(dataDir, dbPath)) {
    throw new Error("owner-transfer: the SQLite target database must live inside the resolved data directory");
  }
  const modelsPath = path.join(agentDir, "models.json");
  for (const [label, root] of [["data directory", dataDir], ["agent directory", agentDir], ["database file", dbPath]] as const) {
    if (isWithin(root, backupRoot) || isWithin(backupRoot, root)) {
      throw new Error(`owner-transfer: backup root physically overlaps the ${label}; use a separate absolute backup root`);
    }
  }
  return { dialect: "sqlite", cwd, dataDir, agentDir, modelsPath, authPath, dbPath, backupRoot, ageRecipientFile };
}

function assertSourceRootsMatch(roots: PublishedBackupVerification["sourceRoots"], expected: { readonly dataDir: string; readonly agentDir: string; readonly dbPath: string }): void {
  if (!roots || !("dbPath" in roots)) {
    throw new Error("owner-transfer: the published backup has no authenticated source roots; refusing to transfer (zero writes performed)");
  }
  const mismatches: string[] = [];
  if (canonicalOwnerTransferPath(roots.dataDir, "backup dataDir") !== canonicalOwnerTransferPath(expected.dataDir, "target dataDir")) mismatches.push("dataDir");
  if (canonicalOwnerTransferPath(roots.agentDir, "backup agentDir") !== canonicalOwnerTransferPath(expected.agentDir, "target agentDir")) mismatches.push("agentDir");
  if (canonicalOwnerTransferPath(roots.dbPath, "backup dbPath") !== canonicalOwnerTransferPath(expected.dbPath, "target dbPath")) mismatches.push("dbPath");
  if (mismatches.length > 0) {
    throw new Error(`owner-transfer: the published backup was taken from different source roots (${mismatches.join(", ")} changed after the backup); refusing to transfer (zero writes performed)`);
  }
}

/**
 * 转移前 SQLite binding 复验：重新解析 target（同一套安全检查）、比对 manifest 的
 * canonical source roots，并断言源 DB 的 DB/WAL/SHM 树指纹自备份以来未变
 * （含 WAL-only commits）。任何不一致都抛错 —— 一次 UPDATE 都不会执行。
 */
export function revalidateSqliteOwnerTransferTarget(
  environment: StorageEnvironment,
  cli: OwnerTransferCliOptions,
  target: SqliteOwnerTransferTarget,
  verification: PublishedBackupVerification,
): void {
  const fresh = resolveSqliteOwnerTransferTarget(environment, cli);
  for (const [label, current, resolved] of [
    ["data directory", target.dataDir, fresh.dataDir],
    ["agent directory", target.agentDir, fresh.agentDir],
    ["database file", target.dbPath, fresh.dbPath],
    ["credential path", target.authPath, fresh.authPath],
  ] as const) {
    if (canonicalOwnerTransferPath(current, label) !== canonicalOwnerTransferPath(resolved, label)) {
      throw new Error(`owner-transfer: the resolved ${label} changed between backup and transfer; refusing to transfer (zero writes performed)`);
    }
  }
  assertSourceRootsMatch(verification.sourceRoots, { dataDir: target.dataDir, agentDir: target.agentDir, dbPath: target.dbPath });
  if (verification.sqliteTreeBinding) {
    assertSqliteSourceTreeUnchanged(verification.sqliteTreeBinding, target.dbPath);
    return;
  }
  // Pre-owner-transfer packages always carry the tree binding; legacy packages
  // must never be consumed as a transfer baseline.
  throw new Error("owner-transfer: the published backup has no SQLite DB/WAL/SHM tree binding; refusing to transfer (zero writes performed)");
}

// ---------------------------------------------------------------------------
// SQLite 状态读取 / dry-run / 事务内 transfer
// ---------------------------------------------------------------------------

function readSqliteState(db: DatabaseSync): OwnerTransferState {
  // Aliases are quoted so the row labels are exactly "ownerKey"/"projectId" on
  // every dialect (unquoted camelCase would be folded by PostgreSQL). Project
  // owner may legitimately be the empty string (shared default project row);
  // session owner must stay non-empty.
  const projects = db.prepare('SELECT id, owner_key AS "ownerKey" FROM projects').all() as Array<{ id: unknown; ownerKey: unknown }>;
  const sessions = db.prepare('SELECT id, owner_key AS "ownerKey", project_id AS "projectId" FROM sessions').all() as Array<{ id: unknown; ownerKey: unknown; projectId: unknown }>;
  for (const row of projects) {
    if (typeof row.id !== "string" || row.id.length === 0 || typeof row.ownerKey !== "string") ownerTransferFail("projects contains a malformed owner row");
  }
  for (const row of sessions) {
    if (typeof row.id !== "string" || row.id.length === 0 || typeof row.ownerKey !== "string" || row.ownerKey.length === 0 || typeof row.projectId !== "string" || row.projectId.length === 0) {
      ownerTransferFail("sessions contains a malformed owner row");
    }
  }
  return {
    projects: projects.map((row) => ({ id: row.id as string, ownerKey: row.ownerKey as string })),
    sessions: sessions.map((row) => ({ id: row.id as string, ownerKey: row.ownerKey as string, projectId: row.projectId as string })),
  };
}

/**
 * SQLite 只读分析（dry-run 用）：调用方必须以 readOnly 打开连接（或打开快照副本），
 * 本函数只读不写，返回计划 counts。
 */
export function analyzeSqliteOwnerTransferReadOnly(db: DatabaseSync, sourceOwnerKey: string, targetOwnerKey: string): OwnerTransferPlan {
  const state = readSqliteState(db);
  return planOwnerTransfer({ sourceOwnerKey, targetOwnerKey, projects: state.projects, sessions: state.sessions });
}

/**
 * SQLite owner 转移事务：BEGIN IMMEDIATE → 校验（plan）→ UPDATE projects/sessions 的
 * owner_key → 事务内 post 校验（verifyOwnerTransferOutcome）→ COMMIT。任何失败 = ROLLBACK
 * 并保留原错误，绝不部分生效。只更新两列，绝不触碰其它表或 JSONL 文件。
 */
export function runSqliteOwnerTransfer(db: DatabaseSync, sourceOwnerKey: string, targetOwnerKey: string): OwnerTransferPlan {
  db.exec("BEGIN IMMEDIATE");
  try {
    const before = readSqliteState(db);
    const plan = planOwnerTransfer({ sourceOwnerKey, targetOwnerKey, projects: before.projects, sessions: before.sessions });
    db.prepare("UPDATE projects SET owner_key = ? WHERE owner_key = ?").run(targetOwnerKey, sourceOwnerKey);
    db.prepare("UPDATE sessions SET owner_key = ? WHERE owner_key = ?").run(targetOwnerKey, sourceOwnerKey);
    const after = readSqliteState(db);
    verifyOwnerTransferOutcome({ sourceOwnerKey, targetOwnerKey, plan, projects: after.projects, sessions: after.sessions });
    db.exec("COMMIT");
    return plan;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve the original transfer error */ }
    throw error;
  }
}

/** DB/WAL/SHM 的字节级指纹（dry-run 零变更断言；不存在 = null）。 */
export interface SqliteFileFingerprint {
  readonly sha256: string | null;
  readonly size: number;
}

export function sqliteOwnerTransferFingerprints(dbPath: string): Record<string, SqliteFileFingerprint> {
  const fingerprints: Record<string, SqliteFileFingerprint> = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${dbPath}${suffix}`;
    try {
      const stat = lstatSync(file);
      const fd = openReadWhole(file);
      const { size, text } = fd;
      fingerprints[file] = { sha256: text, size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fingerprints[file] = { sha256: null, size: 0 };
      else throw error;
    }
  }
  return fingerprints;
}

function openReadWhole(file: string): { size: number; text: string } {
  const buffer = readFileSync(file);
  return { size: buffer.length, text: createHash("sha256").update(buffer).digest("hex") };
}

/** 断言 DB/WAL/SHM 与 dry-run 前的指纹逐字节一致；任何变化都抛错（fail-closed）。 */
export function assertSqliteOwnerTransferDryRunUnchanged(before: Record<string, SqliteFileFingerprint>, dbPath: string): void {
  const after = sqliteOwnerTransferFingerprints(dbPath);
  for (const file of Object.keys(before)) {
    if (before[file]!.sha256 !== after[file]!.sha256 || before[file]!.size !== after[file]!.size) {
      throw new Error("owner-transfer: the SQLite target (DB/WAL/SHM) changed during dry-run; refusing to report a plan over a moving target");
    }
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL（专用 client + REPEATABLE READ + 既有 migration advisory lock +
// identity 复验与 UPDATE 同一连接）
// ---------------------------------------------------------------------------

export interface OwnerTransferPgClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface OwnerTransferPgPoolClient extends OwnerTransferPgClient {
  release?(err?: Error | boolean): void;
}

export interface OwnerTransferPgPool {
  connect(): Promise<OwnerTransferPgPoolClient>;
}

export interface PostgresOwnerTransferTarget {
  readonly database: string;
  readonly schema: string;
  readonly sourceOwnerKey: string;
  readonly targetOwnerKey: string;
}

function textOf(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && (value as string).length > 0 ? value as string : null;
}

async function fetchPostgresState(client: OwnerTransferPgClient, schema: string): Promise<OwnerTransferState> {
  // Explicitly double-quoted column aliases: unquoted camelCase aliases would
  // be folded to lower case by PostgreSQL, silently turning every row into a
  // malformed row. Project owner may be the empty string (the shared default
  // project row); session owner must stay non-empty.
  const qschema = quotePostgresIdentifier(schema);
  const projects = await client.query(`SELECT id, owner_key AS "ownerKey" FROM ${qschema}."projects"`);
  const sessions = await client.query(`SELECT id, owner_key AS "ownerKey", project_id AS "projectId" FROM ${qschema}."sessions"`);
  const projectRows: OwnerProjectRow[] = [];
  for (const row of projects.rows) {
    const id = textOf(row, "id");
    const ownerValue = row["ownerKey"];
    if (!id || typeof ownerValue !== "string") ownerTransferFail("PostgreSQL projects contains a malformed owner row");
    projectRows.push({ id, ownerKey: ownerValue });
  }
  const sessionRows: OwnerSessionRow[] = [];
  for (const row of sessions.rows) {
    const id = textOf(row, "id");
    const ownerValue = row["ownerKey"];
    const projectId = textOf(row, "projectId");
    if (!id || typeof ownerValue !== "string" || ownerValue.length === 0 || !projectId) ownerTransferFail("PostgreSQL sessions contains a malformed owner row");
    sessionRows.push({ id, ownerKey: ownerValue, projectId });
  }
  return { projects: projectRows, sessions: sessionRows };
}

async function assertPostgresSchemaQueryable(client: OwnerTransferPgClient, schema: string): Promise<void> {
  try {
    // Both tables must be present: count(DISTINCT table_name) == 2, never an
    // EXISTS over either table (which would pass with only one of the two).
    const result = await client.query(
      `SELECT count(DISTINCT table_name)::int AS present FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('projects', 'sessions')`,
      [schema],
    );
    const present = result.rows[0]?.present;
    if (present !== 2) ownerTransferFail("the transfer schema does not contain both projects and sessions tables");
  } catch {
    // Never echo the raw catalog query/connection error (stable desensitized text only).
    ownerTransferFail("the transfer schema could not be inspected; refusing transfer (details withheld)");
  }
}

/**
 * 同连接 identity 复验（转移专用）：在已开始的 REPEATABLE READ 事务内，把当前
 * current_database()/current_schema() 与 cluster/database/schema identity 与
 * 已发布 backup binding 比对；任何 mismatch 都抛错 —— 零写入。
 */
async function assertTransferBindingRevalidation(client: OwnerTransferPgClient, schema: string, verification: PublishedBackupVerification): Promise<void> {
  if (!verification.postgres) {
    ownerTransferFail("the published backup has no PostgreSQL database/schema identity binding; refusing to transfer (zero writes performed)");
  }
  let row: Record<string, unknown>;
  try {
    const result = await client.query(
      "SELECT current_database() AS database, current_schema() AS schema, " +
      "(SELECT system_identifier::text FROM pg_control_system()) AS system_identifier, " +
      "(SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid, " +
      "(SELECT oid::text FROM pg_namespace WHERE nspname = current_schema()) AS schema_oid, " +
      "inet_server_addr()::text AS server_address, inet_server_port()::text AS server_port, " +
      "current_setting('cluster_name') AS cluster_name",
    );
    row = result.rows[0] ?? {};
  } catch {
    // Stable desensitized failure: never echo the raw connection/query text.
    ownerTransferFail("the PostgreSQL cluster identity could not be queried during revalidation; refusing to transfer (zero writes performed, details withheld)");
  }
  const database = textOf(row, "database");
  const effectiveSchema = textOf(row, "schema");
  if (!database || !effectiveSchema) ownerTransferFail("the PostgreSQL connection returned no target identity during revalidation; refusing to transfer");
  if (effectiveSchema !== schema) {
    ownerTransferFail(`the connection effective schema (${effectiveSchema}) no longer matches the transfer schema (${schema}) during revalidation; refusing to transfer`);
  }
  const binding = verification.postgres;
  const systemIdentifier = textOf(row, "system_identifier");
  if (!systemIdentifier || !binding.systemIdentifier) {
    ownerTransferFail("the PostgreSQL cluster system identifier is unavailable during revalidation; refusing to rely on same-name identity hashes (zero writes performed)");
  }
  if (binding.systemIdentifier !== systemIdentifier) {
    ownerTransferFail("the published backup was taken from a different PostgreSQL cluster (system identifier mismatch); refusing to transfer (zero writes performed)");
  }
  const databaseOid = textOf(row, "database_oid");
  const schemaOid = textOf(row, "schema_oid");
  if (!databaseOid || !schemaOid || binding.databaseOid !== databaseOid || binding.schemaOid !== schemaOid) {
    ownerTransferFail("the published backup was taken from a different PostgreSQL database/schema identity (OID mismatch); refusing to transfer (zero writes performed)");
  }
  if (binding.databaseIdentity !== postgresIdentity(database, "database") || binding.schemaIdentity !== postgresIdentity(effectiveSchema, "schema")) {
    ownerTransferFail("the published backup was taken from a different PostgreSQL database/schema identity; refusing to transfer (zero writes performed)");
  }
  for (const [label, manifestValue, currentValue] of [
    ["server address", binding.serverAddress ?? null, textOf(row, "server_address")],
    ["server port", binding.serverPort ?? null, textOf(row, "server_port")],
    ["cluster name", binding.clusterName ?? null, textOf(row, "cluster_name")],
  ] as const) {
    if (manifestValue !== currentValue) {
      ownerTransferFail(`the PostgreSQL ${label} changed between the backup and the transfer connection; refusing to transfer (zero writes performed)`);
    }
  }
  void database;
}

/**
 * 同连接 transfer 事务（P0）：identity 复验与 UPDATE 必须在同一专用 PoolClient /
 * 同一 REPEATABLE READ 事务内完成。由门禁保证该事务就是 revalidate 已开启的事务
 * （同一 leased client、同一快照直至 COMMIT），杜绝 Pool 连接切换让「复验通过的
 * 连接」与「执行 UPDATE 的连接」错位：
 * - session-level advisory lock 已由门禁在 BEGIN **之前**以参数化
 *   `SELECT pg_advisory_lock($1)`（$1 = POSTGRES_MIGRATION_LOCK_KEY）取得，并持有
 *   至本事务 COMMIT/ROLLBACK 之后显式解锁（与迁移引擎同 key 的 xact lock 冲突 →
 *   串行化并发 migration/transfer；本函数不再重复取锁）；
 * - 复验 current_database() == 期望 database、current_schema() == 期望 schema（exact）；
 * - 双表 schema 确认 → 校验 plan → UPDATE → post 校验；apply 由门禁 COMMIT，
 *   dry-run 由门禁 ROLLBACK（零写入）；任何失败 → ROLLBACK（零生效）。
 */
export async function runPostgresOwnerTransferTransaction(
  client: OwnerTransferPgClient,
  target: PostgresOwnerTransferTarget,
  mode: "apply" | "dry-run",
): Promise<OwnerTransferPlan> {
  let identity: Record<string, unknown>;
  try {
    const result = await client.query("SELECT current_database() AS database, current_schema() AS schema");
    identity = result.rows[0] ?? {};
  } catch {
    // Stable desensitized failure: never echo the raw connection/query text.
    ownerTransferFail("the PostgreSQL connection identity could not be queried; refusing to transfer (details withheld)");
  }
  const database = textOf(identity, "database");
  const effectiveSchema = textOf(identity, "schema");
  if (!database || !effectiveSchema) ownerTransferFail("the PostgreSQL connection returned no target identity; refusing to transfer");
  if (database !== target.database) {
    ownerTransferFail(`the connection current_database no longer matches the transfer target database; refusing to transfer`);
  }
  if (effectiveSchema !== target.schema) {
    ownerTransferFail(`the connection effective schema (${effectiveSchema}) does not exactly match the transfer schema (${target.schema}); refusing ambiguous transfer`);
  }
  await assertPostgresSchemaQueryable(client, target.schema);
  const before = await fetchPostgresState(client, target.schema);
  const plan = planOwnerTransfer({ sourceOwnerKey: target.sourceOwnerKey, targetOwnerKey: target.targetOwnerKey, projects: before.projects, sessions: before.sessions });
  if (mode === "dry-run") return plan;
  const qschema = quotePostgresIdentifier(target.schema);
  await client.query(`UPDATE ${qschema}."projects" SET owner_key = $2 WHERE owner_key = $1`, [target.sourceOwnerKey, target.targetOwnerKey]);
  await client.query(`UPDATE ${qschema}."sessions" SET owner_key = $2 WHERE owner_key = $1`, [target.sourceOwnerKey, target.targetOwnerKey]);
  const after = await fetchPostgresState(client, target.schema);
  verifyOwnerTransferOutcome({ sourceOwnerKey: target.sourceOwnerKey, targetOwnerKey: target.targetOwnerKey, plan, projects: after.projects, sessions: after.sessions });
  return plan;
}

/** 门禁一次性 phase 状态机：idle → revalidating → revalidated → transacting → done（任一步失败 → failed）；dry-run 走独立 one-shot 路径。 */
type PostgresOwnerTransferGatePhase = "idle" | "revalidating" | "revalidated" | "transacting" | "done" | "failed";

/**
 * PG 专用同连接门禁（reviewer P1 修复：session lock + 不可重入一次性 phase 状态机）。
 *
 * 锁模型：同一 leased client 在**事务外**先以参数化 `SELECT pg_advisory_lock($1)`
 * （$1 = POSTGRES_MIGRATION_LOCK_KEY）取得 **session-level** advisory lock —— 该锁与
 * 迁移引擎在事务内持有的同 key xact lock 冲突，因此与并发 migration/transfer 串行化；
 * 取得锁之后才 `BEGIN ISOLATION LEVEL REPEATABLE READ`（dry-run 为 READ ONLY），
 * binding 复验 → plan/update/post-verify 全部同此快照。事务 COMMIT/ROLLBACK **之后**
 * 显式 `SELECT pg_advisory_unlock($1)` 并验证返回 true，**之后才**把 client release
 * 归还池；解锁未确认 true / 解锁查询失败 / 事务结束失败 → `release(error)` 销毁连接，
 * 绝不把可能仍持锁的连接交回池（错误/cleanup 路径同此规则）。
 *
 * 一次性 phase 状态机（全部 fail-closed，绝不覆盖 in-flight client）：
 * - revalidate 只允许在 idle 执行一次：并发/重复 revalidate 一律拒绝（零加连）；
 * - transfer("apply") 只允许在 revalidated 执行一次：跳过复验（idle/failed）拒绝、
 *   复验/转移进行中（revalidating/transacting）拒绝并发、完成后（done）拒绝复用；
 * - transfer("dry-run") 是独立 one-shot 路径（idle → transacting → done），不共享
 *   复验事务，也只允许执行一次；
 * - cleanup()：idle/done/failed 时幂等 no-op；revalidating/transacting 进行中拒绝
 *   （不打断、不破坏 in-flight client 的租约）；revalidated（复验后未 apply）时
 *   ROLLBACK + 解锁验证 + 归还，gate 进入终态。
 */
export function openPostgresOwnerTransferGate(
  pool: OwnerTransferPgPool,
  database: string,
  schema: string,
  sourceOwnerKey: string,
  targetOwnerKey: string,
): PostgresOwnerTransferGate {
  let client: OwnerTransferPgPoolClient | undefined;
  let phase: PostgresOwnerTransferGatePhase = "idle";
  const target: PostgresOwnerTransferTarget = { database, schema, sourceOwnerKey, targetOwnerKey };

  /** release(error) 销毁语义要求 Error；非 Error 的 unknown 也归一为 Error（保底销毁）。 */
  const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

  /**
   * 租用专用 client，事务外以参数化 SELECT 取得 session advisory lock，然后 BEGIN。
   * 取锁/BEGIN 任一失败：尽力 ROLLBACK + 尽力解锁，但无论解锁是否确认，连接一律
   * `release(error)` 销毁（绝不把可能持锁的连接归还池）。
   */
  const acquire = async (readOnly: boolean): Promise<OwnerTransferPgPoolClient> => {
    const acquired = await pool.connect();
    let lockHeld = false;
    let begun = false;
    try {
      await acquired.query("SELECT pg_advisory_lock($1)", [POSTGRES_MIGRATION_LOCK_KEY]);
      lockHeld = true;
      await acquired.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN ISOLATION LEVEL REPEATABLE READ");
      begun = true;
      return acquired;
    } catch (error) {
      if (begun) {
        try { await acquired.query("ROLLBACK"); } catch { /* connection state unknown: destroy below */ }
      }
      if (lockHeld) {
        try {
          const unlocked = await acquired.query("SELECT pg_advisory_unlock($1)", [POSTGRES_MIGRATION_LOCK_KEY]);
          if (unlocked.rows[0]?.pg_advisory_unlock !== true) throw new Error("owner-transfer: pg_advisory_unlock did not confirm release");
        } catch { /* destroy below */ }
      }
      acquired.release?.(asError(error));
      throw error;
    }
  };

  /**
   * COMMIT/ROLLBACK → 显式 pg_advisory_unlock 并验证返回 true → 才 release() 归还池。
   * 解锁未确认 true、解锁查询失败或事务结束失败：`release(error)` 销毁连接（可能仍持锁，
   * 绝不回池）。本函数会清空 gate 的 client/事务引用（settle 后 client 即不再被 gate 持有）。
   */
  const settleTransaction = async (end: "COMMIT" | "ROLLBACK"): Promise<void> => {
    const current = client;
    if (!current) return;
    client = undefined;
    try {
      await current.query(end);
    } catch (error) {
      try {
        const unlocked = await current.query("SELECT pg_advisory_unlock($1)", [POSTGRES_MIGRATION_LOCK_KEY]);
        if (unlocked.rows[0]?.pg_advisory_unlock !== true) throw new Error("owner-transfer: pg_advisory_unlock did not confirm release");
      } catch { /* connection state unknown: destroy below */ }
      current.release?.(asError(error));
      throw error;
    }
    try {
      const unlocked = await current.query("SELECT pg_advisory_unlock($1)", [POSTGRES_MIGRATION_LOCK_KEY]);
      if (unlocked.rows[0]?.pg_advisory_unlock !== true) {
        ownerTransferFail("pg_advisory_unlock did not confirm release; the session may still hold the migration lock; the client is destroyed instead of returning to the pool");
      }
    } catch (error) {
      // 解锁未确认/失败：连接可能仍持锁，销毁而非归还；解锁错误原样上抛。
      current.release?.(asError(error));
      throw error;
    }
    current.release?.();
  };

  const finish = (next: "done" | "failed"): void => {
    phase = next;
    client = undefined;
  };

  return {
    /**
     * 转移前 binding 复验（一次性、不可重入）：租用专用 client，事务外取得 session
     * advisory lock 后 BEGIN REPEATABLE READ，在本事务内对比已发布备份的
     * cluster/database/schema identity；成功后保持事务与快照打开供 transfer("apply")
     * 同一 client 继续使用。失败 → 本事务 ROLLBACK + 解锁验证 + 归还（fail-closed），
     * 后续 apply 不再重建事务。
     */
    async revalidate(verification: PublishedBackupVerification): Promise<void> {
      if (phase !== "idle") {
        ownerTransferFail("revalidate is one-shot and non-reentrant: it may run only once while the gate is idle; repeated or concurrent revalidate is refused (fail-closed)");
      }
      phase = "revalidating";
      try {
        const tx = await acquire(false);
        client = tx;
      } catch (error) {
        finish("failed");
        throw error;
      }
      try {
        await assertTransferBindingRevalidation(client!, schema, verification);
        phase = "revalidated";
      } catch (error) {
        try { await settleTransaction("ROLLBACK"); } catch { /* settle 已尽力销毁连接 */ }
        finish("failed");
        throw error;
      }
    },
    /**
     * 实际转移（apply）或 dry-run 计划。apply 复用 revalidate 同一事务同一快照
     * （同一 client 上 lock → BEGIN → plan/update/post-verify → COMMIT）；dry-run
     * 独立 one-shot 路径（READ ONLY 事务、可无 backup/binding）。二者都经 settle
     * （COMMIT/ROLLBACK + 解锁验证 + 归还）收尾，之后 gate 进入终态（不可复用）。
     */
    async transfer(mode: "apply" | "dry-run"): Promise<OwnerTransferPlan> {
      if (mode === "apply") {
        if (phase === "idle" || phase === "failed") {
          // 跳过复验（或复验已失败）直接 apply：零 connect / 零写入，fail-closed。
          ownerTransferFail("apply requires binding revalidation on the same connection transaction (call revalidate first); refusing to write without a same-transaction binding check");
        }
        if (phase === "revalidating" || phase === "transacting") {
          ownerTransferFail("a revalidate/transfer is already in progress on this gate; concurrent apply is refused (fail-closed)");
        }
        if (phase !== "revalidated" || !client) {
          ownerTransferFail("the gate is one-shot and already finished; apply cannot run again on this gate (create a new gate)");
        }
      } else if (phase !== "idle") {
        ownerTransferFail("dry-run is an independent one-shot path: it runs only while the gate is idle and never shares the revalidate transaction; repeated or concurrent dry-run is refused (fail-closed)");
      }
      phase = "transacting";
      if (mode === "apply") {
        try {
          const plan = await runPostgresOwnerTransferTransaction(client!, target, "apply");
          await settleTransaction("COMMIT");
          finish("done");
          return plan;
        } catch (error) {
          try { await settleTransaction("ROLLBACK"); } catch { /* settle 已尽力销毁连接 */ }
          finish("failed");
          throw error;
        }
      }
      try {
        const tx = await acquire(true);
        client = tx;
      } catch (error) {
        finish("failed");
        throw error;
      }
      try {
        const plan = await runPostgresOwnerTransferTransaction(client!, target, "dry-run");
        await settleTransaction("ROLLBACK");
        finish("done");
        return plan;
      } catch (error) {
        try { await settleTransaction("ROLLBACK"); } catch { /* settle 已尽力销毁连接 */ }
        finish("failed");
        throw error;
      }
    },
    /**
     * 兜底清退：幂等。终态/未启动 = no-op；revalidated（复验后未 apply）= ROLLBACK +
     * 解锁验证 + 归还后进入终态；revalidate/transfer 进行中 = 拒绝（fail-closed，
     * 绝不覆盖 in-flight client 的租约）。
     */
    async cleanup(): Promise<void> {
      if (phase === "idle" || phase === "done" || phase === "failed") return;
      if (phase === "revalidating" || phase === "transacting") {
        ownerTransferFail("cleanup is refused while revalidate/transfer is in progress; the in-flight operation owns the client lease and must settle first (fail-closed: the client is never clobbered)");
      }
      // revalidated：同步进入清退终态（在 ROLLBACK 的 await 之前），杜绝
      // 「cleanup 过程中并发 apply」看到 revalidated+已清空的 client 的竞态窗口；
      // 清退失败则由 finish("failed") 覆盖。
      phase = "done";
      try {
        await settleTransaction("ROLLBACK");
      } catch (error) {
        finish("failed");
        throw error;
      }
      finish("done");
    },
  };
}

/** 同连接转移门禁的公开面（一次性：revalidate → transfer → cleanup，全部不可重入）。 */
export interface PostgresOwnerTransferGate {
  readonly revalidate: (verification: PublishedBackupVerification) => Promise<void>;
  readonly transfer: (mode: "apply" | "dry-run") => Promise<OwnerTransferPlan>;
  readonly cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// 编排：backup → verify → binding revalidate → transfer/verify（apply 固定顺序）
// ---------------------------------------------------------------------------

export interface OwnerTransferBackupMetadata {
  readonly id: string;
  readonly kind: string;
  readonly checksum: string;
  readonly version: number | null;
}

export interface OwnerTransferReport {
  readonly status: "success";
  readonly mode: "apply";
  readonly dialect: "SQLite" | "PostgreSQL";
  readonly sourceSubjectHash: string;
  readonly targetSubjectHash: string;
  readonly transfer: {
    readonly projectsTransferred: number;
    readonly sessionsTransferred: number;
    readonly defaultProjectOwnerPreserved: true;
  };
  readonly backup: OwnerTransferBackupMetadata;
  readonly notes: readonly string[];
}

export interface OwnerTransferOperations {
  /** 步骤 1：pre-owner-transfer 加密备份。 */
  readonly createBackup: () => Promise<BackupResult | PostgresBackupResult>;
  /** 步骤 2：已发布备份 COMPLETE/manifest/payload 完整性复核。 */
  readonly verifyBackup: (backup: BackupResult | PostgresBackupResult) => PublishedBackupVerification;
  /**
   * 步骤 2.5（必需，不可跳过）：转移前 binding 复验（source roots + SQLite DB/WAL/SHM
   * 树指纹 或 PG cluster/database/schema identity）；任何目标变化/mismatch 都抛错 ——
   * 零写入。apply 路径没有该步骤视为编排错误。
   */
  readonly revalidateBeforeTransfer: (verification: PublishedBackupVerification) => Promise<void> | void;
  /** 步骤 3：同一事务内 transfer/verify（SQLite BEGIN IMMEDIATE / PG 专用 client REPEATABLE READ）。 */
  readonly transfer: () => Promise<OwnerTransferPlan> | OwnerTransferPlan;
}

/** apply 编排：严格固定 backup → verify → revalidate → transfer；任何失败不报成功。 */
export async function runOwnerTransfer(
  authorization: OwnerTransferAuthorization,
  operations: OwnerTransferOperations,
  options: { readonly dialect: "SQLite" | "PostgreSQL"; readonly sourceSubjectHash: string; readonly targetSubjectHash: string; readonly onStage?: StageReporter },
): Promise<OwnerTransferReport> {
  if (authorization.token !== "ip-ownership-transfer-authorized") throw new Error("owner-transfer: unauthorized orchestration call");
  const report = options.onStage;
  const budgets = APPLY_STAGE_BUDGET_MS;
  // The backup stage is the only abortable stage (external age children); on
  // timeout the hung age child is SIGKILLed and the gate waits for the confirmed
  // settlement. transfer is non-cancellable: no abort, no timeout return while
  // it still runs.
  if (authorization.token !== "ip-ownership-transfer-authorized") throw new Error("owner-transfer: unauthorized orchestration call before backup");
  const backup = await withStageTimeout("backup", budgets.backup, operations.createBackup, { abort: () => abortActiveAgeChild() }, report);
  const verification = await withStageTimeout("backup-verify", budgets.backupVerify, () => Promise.resolve(operations.verifyBackup(backup)), undefined, report);
  if (verification.kind !== "pre-owner-transfer") throw new Error("owner-transfer: backup verification returned an unexpected kind; refusing to transfer (zero writes performed)");
  if (authorization.token !== "ip-ownership-transfer-authorized") throw new Error("owner-transfer: unauthorized orchestration call before transfer");
  // Binding revalidation happens strictly before any write: a target that changed
  // after the backup fails here and performs zero writes.
  await withStageTimeout("migration-apply", budgets.migrationApply, () => Promise.resolve(operations.revalidateBeforeTransfer(verification)), undefined, report);
  const plan = await withStageTimeout("migration-apply", budgets.migrationApply, () => Promise.resolve(operations.transfer()), undefined, report);
  return {
    status: "success",
    mode: "apply",
    dialect: options.dialect,
    sourceSubjectHash: options.sourceSubjectHash,
    targetSubjectHash: options.targetSubjectHash,
    transfer: {
      projectsTransferred: plan.projectsTransferred,
      sessionsTransferred: plan.sessionsTransferred,
      defaultProjectOwnerPreserved: plan.defaultProjectOwnerPreserved,
    },
    backup: {
      id: verification.id,
      kind: verification.kind,
      checksum: verification.checksum,
      version: verification.version,
    },
    notes: [
      "maintenance window is an operator declaration, not a process lock; database serialization is provided by the SQLite BEGIN IMMEDIATE / PostgreSQL session advisory lock (POSTGRES_MIGRATION_LOCK_KEY, taken with a parametrized SELECT before BEGIN and explicitly released with verification after COMMIT/ROLLBACK)",
      "the pre-owner-transfer backup is retained for manual recovery; no automatic restore is ever performed",
    ],
  };
}
