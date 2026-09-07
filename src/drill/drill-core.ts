/**
 * 正式部署侧演习 runner 的纯函数核心。
 *
 * 职责与边界（与 docs/backup-freshness-drill-sop.md 语义一致）：
 * - 为一次性隔离演练提供安全门禁、计划、判定、脱敏证据与文件清理；live executor 只启动
 *   本次运行专属的临时 Podman scheduler/monitoring 资源，绝不安装宿主 timer/unit/plist；
 * - 绝不触碰正式 data / backup / staging / credential 路径：任一正式路径与演练根
 *   重叠即 fail-closed（正式路径按服务默认解析，backup root/recipient/identity 使用
 *   显式 PI_FORMAL_* 输入，缺失时不宣称已隔离）；
 * - 演练根 `PI_DRILL_ROOT` 必须是绝对、私有（精确 0700，拒绝 special bits）、
 *   当前用户/root 属主、非 symlink，且固定保留 `$PI_DRILL_ROOT/secrets/` 中的演练专用
 *   age identity/recipient（精确 0600、拒绝 special bits / hardlink / symlink）；
 * - cleanup 必须先通过完整 preflight（root + 固定 secrets + 正式路径重叠 + 资源隔离），
 *   任一失败即拒绝删除；同时要求两个 secrets 有效存在；绝不删除根或 secrets；
 * - run 只能在 preflight PASS 后执行；PASS 仅由完整 live observations 判定，普通环境变量
 *   不能作为 attestation 或绕过任何步骤；
 * - 所有输出（verdict / 日志）都必须经 `redactText` 脱敏，绝不含 secret / URL / 绝对路径。
 *
 * 该模块只依赖 node 内建模块，可在 vitest 中直接单测（见 tests/drill/drill-core.test.ts）。
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { FAULT_SCENARIOS, guardStepId, recoveryStepId, type FaultKind, type FaultScenario } from "./drill-faults.js";

/** 松散的进程/测试环境输入：key -> 原始字符串（可能为 undefined）。 */
export type DrillEnv = Record<string, string | undefined>;

export type DrillOutcome = "PASS" | "FAIL" | "DEFERRED";

export interface DrillCheck {
  readonly name: string;
  readonly ok: boolean;
  /** 经脱敏的简短说明；绝不包含 secret/URL/绝对路径。 */
  readonly detail: string;
}

export interface DrillVerdict {
  readonly outcome: DrillOutcome;
  readonly checks: readonly DrillCheck[];
  /** 经脱敏的总体结论。 */
  readonly summary: string;
}



export interface DrillRootInfo {
  readonly raw: string;
  readonly canonical: string;
}

export interface DrillSecrets {
  readonly identityFile: string;
  readonly recipientFile: string;
}

export interface FormalDrillPaths {
  readonly agentCwd?: string;
  readonly dataDir?: string;
  readonly dbPath?: string;
  readonly agentDir?: string;
  readonly authPath?: string;
  readonly stagingRoot?: string;
  readonly backupRoot?: string;
  readonly backupRecipient?: string;
  readonly backupIdentity?: string;
  readonly databaseUrl?: string;
}

export interface CleanupResult {
  readonly removedRuns: number;
  readonly cleared: readonly string[];
  readonly preservedSecrets: boolean;
}

/** 固定布局：secrets 为保留目录，其余为明确的运行/临时子目录。 */
export const SECRETS_DIR = "secrets";
export const RUNS_DIR = "runs";
const IDENTITY_FILE = "age-identity.txt";
const RECIPIENT_FILE = "age-recipient.txt";

/** 演练步骤分类。 */
export type DrillStepKind = "prerequisite" | "mandatory" | "fault-guard" | "fault-recovery";

/** 单个演练步骤规格（纯声明）。 */
export interface DrillStepSpec {
  readonly id: string;
  readonly kind: DrillStepKind;
  readonly fault?: FaultKind;
  readonly alertCycle?: boolean;
}

/** 单个步骤实测结果（仅枚举/布尔/时长/脱敏 detail）。 */
export interface DrillObservation {
  readonly stepId: string;
  readonly passed: boolean;
  readonly detail: string;
  readonly durationMs: number;
  /** Only a genuinely unavailable prerequisite may set this flag. */
  readonly deferred?: boolean;
}

/** 演练计划：步骤顺序 + 故障场景组（纯声明）。 */
export interface DrillPlan {
  readonly steps: readonly DrillStepSpec[];
  readonly faultScenarios: readonly FaultScenario[];
}

/** 演练判定结果。 */
export interface DrillAdjudication {
  readonly outcome: DrillOutcome;
  readonly summary: string;
  readonly mandatoryFailures: readonly DrillObservation[];
  readonly prerequisiteFailures: readonly DrillObservation[];
  /** 故障场景中 guard 或 recovery 未通过的项。 */
  readonly faultFailures: readonly { fault: FaultKind; guardOk: boolean; recoveryOk: boolean }[];
  /** DEFERRED 的明确先决条件（如缺 podman/age/pg 工具）。 */
  readonly deferredBy: readonly string[];
  readonly passedCount: number;
  readonly totalCount: number;
}

/** 固定先决条件步骤：provision 是否具备 podman/age/pg 工具链。 */
export const PROVISION_STEP = "provision";

/** 成功路径（必要）步骤 id。 */
export const SUCCESS_STEPS = [
  "fixture-sqlite",
  "fixture-postgres",
  "backup-sqlite-success",
  "backup-postgres-success",
  "restore-sqlite-success",
  "restore-postgres-success",
  "monitor-normal",
] as const;

export type SuccessStepId = (typeof SUCCESS_STEPS)[number];

/** 构建默认演练计划：先决条件 + 成功路径 + 故障矩阵。 */
export function defaultDrillPlan(): DrillPlan {
  const steps: DrillStepSpec[] = [{ id: PROVISION_STEP, kind: "prerequisite" }];
  for (const id of SUCCESS_STEPS) steps.push({ id, kind: "mandatory" });
  for (const scenario of FAULT_SCENARIOS) {
    steps.push({ id: scenario.guardStep, kind: "fault-guard", fault: scenario.fault, alertCycle: scenario.alertCycle });
    steps.push({ id: scenario.recoveryStep, kind: "fault-recovery", fault: scenario.fault, alertCycle: scenario.alertCycle });
  }
  return { steps, faultScenarios: FAULT_SCENARIOS };
}

/**
 * 纯判定：给定步骤实测结果与计划，判定 PASS / FAIL / DEFERRED。
 * - 任一先决条件(provision 类)未过 → DEFERRED（缺明确工具链）；
 * - 任一 mandatory 未过，或任一故障场景的 guard/recovery 未过 → FAIL；
 * - 全部通过 → PASS。
 * 判定只信任传入的 observations（由执行器真实采集），不接受任何环境变量自证。
 */
export function adjudicateDrill(observations: readonly DrillObservation[], plan: DrillPlan): DrillAdjudication {
  const byId = new Map<string, DrillObservation>();
  for (const observation of observations) byId.set(observation.stepId, observation);
  const deferredBy: string[] = [];
  const mandatoryFailures: DrillObservation[] = [];
  const prerequisiteFailures: DrillObservation[] = [];
  let passedCount = 0;
  for (const spec of plan.steps) {
    const observation = byId.get(spec.id);
    if (observation?.passed) passedCount += 1;
    if (!observation) {
      if (spec.kind === "prerequisite") deferredBy.push(spec.id);
      else if (spec.kind === "mandatory") {
        mandatoryFailures.push({ stepId: spec.id, passed: false, detail: "step did not run", durationMs: 0 });
      }
      continue;
    }
    if (observation.passed) continue;
    if (spec.kind === "prerequisite") {
      // Compatibility for old fixture adapters is limited to their literal
      // "fail" marker. Live execution marks every infrastructure failure
      // explicitly deferred=false, so build/pull/network/start/config errors
      // can never become DEFERRED.
      const detail = observation.detail.toLowerCase();
      const unavailable = observation.deferred === true || detail.includes("toolchain missing") || (observation.deferred === undefined && detail === "fail");
      if (unavailable) deferredBy.push(spec.id);
      else prerequisiteFailures.push(observation);
    } else if (spec.kind === "mandatory") mandatoryFailures.push(observation);
    // fault-guard / fault-recovery failures are grouped below.
  }
  const faultFailures: { fault: FaultKind; guardOk: boolean; recoveryOk: boolean }[] = [];
  for (const scenario of plan.faultScenarios) {
    // 故障 guard/recovery 步骤已计入上方 passedCount；这里只做分组判定，避免重复计数。
    const guard = byId.get(scenario.guardStep);
    const recovery = byId.get(scenario.recoveryStep);
    const guardOk = guard?.passed ?? false;
    const recoveryOk = recovery?.passed ?? false;
    if (!guardOk || !recoveryOk) {
      faultFailures.push({ fault: scenario.fault, guardOk, recoveryOk });
    }
  }
  let outcome: DrillOutcome;
  if (deferredBy.length > 0) {
    outcome = "DEFERRED";
  } else if (prerequisiteFailures.length > 0 || mandatoryFailures.length > 0 || faultFailures.length > 0) {
    outcome = "FAIL";
  } else {
    outcome = "PASS";
  }
  const summary =
    outcome === "PASS"
      ? `drill pass: ${passedCount}/${plan.steps.length} checks`
      : outcome === "FAIL"
        ? `drill fail: ${mandatoryFailures.length} mandatory + ${faultFailures.length} fault-scenario failure(s)`
        : `drill deferred: prerequisite(s) unavailable (${deferredBy.join(", ")})`;
  return { outcome, summary, mandatoryFailures, prerequisiteFailures, faultFailures, deferredBy, passedCount, totalCount: plan.steps.length };
}

/** 演练根下允许被 cleanup 清空的已知工作/临时子目录（不含 secrets）。 */
export const WORKSPACE_DIRS = ["fixtures", "backups", "restore", "staging", "textfile", "textfile-pg", "logs", "faultbin", "scheduler", "monitor", "evidence", RUNS_DIR] as const;

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** canonical 枚举：某目录 isWithin 另一目录（含相等）。 */
export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** 拒绝路径中任何 symlink 祖先；仅放行受信任的系统挂载别名（/var、/tmp）。 */
function secureDrillPath(input: string, label: string): string {
  const absolute = path.resolve(input);
  const root = path.parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const entry = lstatSync(current);
      const trustedSystemAlias =
        (process.platform === "darwin" && (current === "/var" || current === "/tmp")) ||
        (process.platform !== "darwin" && current === "/tmp");
      if (entry.isSymbolicLink() && !trustedSystemAlias) {
        throw new Error(`${label} contains a symbolic-link ancestor`);
      }
    } catch (error) {
      // 正式路径的默认值（如 ~/.pi/agent/auth.json、.$AGENT_CWD/.pi-agent）可能因
      // 权限受限/缺失而不可访问。对 formal 进行 best-effort 重叠比较时，把
      // ENOENT / EACCES / EPERM 视为“无法访问”并停止继续判定（不因默认值泄密/报错）。
      // 演练根本身不可访问仍会在 validateDrillRoot 的 lstat 处 fail-closed。
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM") break;
      throw error;
    }
  }
  return absolute;
}

/** 对已有祖先做 realpath，保留尚不存在的后缀，得到可用于比较的 canonical 形式。
 * 对因权限/TCC 而不可访问的路径（如 ~/.pi/agent/auth.json 受保护）退化为词法绝对路径，
 * 仅用于 best-effort 重叠比较，绝不因此泄密或报错。 */
function canonicalizeForComparison(input: string): string {
  const absolute = secureDrillPath(input, "path");
  let existing = absolute;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  let resolvedExisting: string;
  try {
    resolvedExisting = realpathSync(existing);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return path.resolve(input);
    throw error;
  }
  return path.join(resolvedExisting, ...suffix);
}

/** 解析 PI_DRILL_ROOT：必填、绝对。 */
export function resolveDrillRoot(env: DrillEnv): string {
  const raw = nonBlank(env.PI_DRILL_ROOT);
  if (!raw) throw new Error("drill root is not set; provide absolute PI_DRILL_ROOT");
  if (!path.isAbsolute(raw)) throw new Error("drill root must be absolute");
  return path.resolve(raw);
}

/** 校验演练根：存在、目录、精确 0700（拒绝 special bits）、当前用户/root 属主、非 symlink（含无 symlink 祖先）。 */
export function validateDrillRoot(root: string): DrillRootInfo {
  secureDrillPath(root, "drill root");
  const st = lstatSync(root);
  if (st.isSymbolicLink()) throw new Error("drill root is a symbolic link");
  if (!st.isDirectory()) throw new Error("drill root is not a directory");
  if ((Number(st.mode) & 0o7777) !== 0o700) throw new Error("drill root must be exactly 0700 (no group/other or special bits)");
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid && st.uid !== 0) throw new Error("drill root must be owned by the current user");
  const canonical = realpathSync(root);
  return { raw: root, canonical };
}

/** 默认 secrets 位置：$PI_DRILL_ROOT/secrets/age-identity.txt 与 age-recipient.txt。 */
export function resolveDrillSecrets(root: string): DrillSecrets {
  return {
    identityFile: path.join(root, SECRETS_DIR, IDENTITY_FILE),
    recipientFile: path.join(root, SECRETS_DIR, RECIPIENT_FILE),
  };
}

/** 校验 secrets：存在、精确 0600（拒绝 special bits）、普通文件、非 symlink、非 hardlink。 */
export function validateDrillSecrets(root: string): DrillSecrets {
  const { identityFile, recipientFile } = resolveDrillSecrets(root);
  for (const [label, file] of [["age identity", identityFile], ["age recipient", recipientFile]] as const) {
    secureDrillPath(file, label);
    const st = lstatSync(file);
    if (st.isSymbolicLink()) throw new Error(`${label} is a symbolic link`);
    if (!st.isFile()) throw new Error(`${label} is not a regular file`);
    if ((Number(st.mode) & 0o7777) !== 0o600) throw new Error(`${label} is not exactly 0600`);
    if (st.nlink > 1) throw new Error(`${label} is a hardlink`);
  }
  return { identityFile, recipientFile };
}

/** 显式正式路径必须为绝对；缺失返回空串（不视为提供），相对/非法即 fail-closed。 */
function absoluteOrThrow(value: string | undefined, label: string): string {
  const v = nonBlank(value);
  if (!v) return "";
  if (!path.isAbsolute(v)) throw new Error(`formal ${label} must be absolute`);
  return path.resolve(v);
}

/** 解析服务默认正式路径（AGENT_CWD/DATA_DIR/DB/agent/auth），含显式 PI_FORMAL_* 备份输入与正式 DB URL。 */
export function resolveFormalPaths(env: DrillEnv): FormalDrillPaths {
  const baseCwd = process.cwd();
  const agentCwd = absoluteOrThrow(env.AGENT_CWD, "agentCwd") || baseCwd;
  const dataDir = absoluteOrThrow(env.DATA_DIR, "dataDir") || agentCwd;
  const dbPath = absoluteOrThrow(env.DB_PATH, "dbPath") || path.join(dataDir, "pi-agent-server.db");
  const agentDir = absoluteOrThrow(env.PI_AGENT_DIR, "agentDir") || path.join(dataDir, ".pi-agent");
  const authPath = absoluteOrThrow(env.PI_AUTH_PATH, "authPath") || path.join(homedir(), ".pi", "agent", "auth.json");
  return {
    agentCwd: path.resolve(agentCwd),
    dataDir: path.resolve(dataDir),
    dbPath: path.resolve(dbPath),
    agentDir: path.resolve(agentDir),
    authPath: path.resolve(authPath),
    stagingRoot: absoluteOrThrow(env.PI_BACKUP_STAGING_ROOT, "stagingRoot") || undefined,
    backupRoot: absoluteOrThrow(env.PI_FORMAL_BACKUP_ROOT, "backupRoot") || undefined,
    backupRecipient: absoluteOrThrow(env.PI_FORMAL_BACKUP_RECIPIENT, "backupRecipient") || undefined,
    backupIdentity: absoluteOrThrow(env.PI_FORMAL_BACKUP_IDENTITY, "backupIdentity") || undefined,
    databaseUrl: nonBlank(env.PI_DATABASE_URL),
  };
}

/** 归一化 PostgreSQL 目标（忽略凭据），用于数据库级重叠判断；非 postgres/解析失败返回 undefined。 */
function normalizedDbTarget(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.replace(/:$/, "");
    if (protocol !== "postgres" && protocol !== "postgresql") return undefined;
    const database = parsed.pathname.replace(/^\//, "") || "(default)";
    const port = parsed.port || "5432";
    return `${protocol}://${parsed.hostname}:${port}/${database}`;
  } catch {
    return undefined;
  }
}

/**
 * fail-closed：任一正式路径与演练根在任一方向重叠即拒绝；正式 postgres DB 与演练
 * postgres DB 指向同一目标亦拒绝。报告只包含正式路径的标签（枚举），绝不包含实际路径。
 * 缺失的 PI_FORMAL_* 备份输入不参与比较（不宣称已隔离），也绝不因缺失而泄密/报错。
 */
export function assertNoFormalOverlap(root: string, formal: FormalDrillPaths, drillDbUrl?: string): void {
  const rootCanonical = canonicalizeForComparison(root);
  const overlapping: string[] = [];
  for (const [label, value] of Object.entries(formal)) {
    if (label === "databaseUrl") continue; // 数据库目标单独比较
    if (!value) continue; // 缺失的正式备份输入不参与比较
    if (!path.isAbsolute(value)) throw new Error(`formal ${label} must be absolute`);
    const candidate = canonicalizeForComparison(value);
    if (candidate === rootCanonical || isWithin(rootCanonical, candidate) || isWithin(candidate, rootCanonical)) {
      overlapping.push(label);
    }
  }
  const formalDb = normalizedDbTarget(formal.databaseUrl);
  const drillDb = normalizedDbTarget(drillDbUrl);
  if (formalDb && drillDb && formalDb === drillDb) {
    overlapping.push("database");
  }
  if (overlapping.length > 0) throw new Error(`drill root overlaps formal ${overlapping.join(", ")}`);
}

/**
 * 校验演练的测试资源 / 接收方配置全部来自显式 DRILL 环境变量，并拒绝不安全、空、
 * 相对或非预期的配置。任何错误消息都不回显 URL / secret。
 */
export interface DrillResourceConfig {
  readonly dialect: "sqlite" | "postgres";
  readonly textfileDir: string | null;
}

export function validateDrillResources(root: string, env: DrillEnv): DrillResourceConfig {
  const dialectRaw = nonBlank(env.PI_DRILL_DIALECT);
  let dialect: "sqlite" | "postgres" = "sqlite";
  if (dialectRaw !== undefined) {
    if (dialectRaw !== "sqlite" && dialectRaw !== "postgres") throw new Error("drill dialect must be sqlite or postgres");
    dialect = dialectRaw;
  }
  if (dialect === "postgres") {
    const url = nonBlank(env.PI_DRILL_DATABASE_URL);
    if (!url) throw new Error("drill postgres requires PI_DRILL_DATABASE_URL");
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") throw new Error("unsupported scheme");
    } catch {
      throw new Error("drill database URL is invalid");
    }
  }
  const textfile = nonBlank(env.PI_DRILL_TEXTFILE_DIR);
  let textfileDir: string | null = null;
  if (textfile !== undefined) {
    if (!path.isAbsolute(textfile)) throw new Error("drill textfile dir must be absolute");
    if (!isWithin(root, textfile)) throw new Error("drill textfile dir must live inside the drill root");
    textfileDir = textfile;
  }
  for (const [label, value] of [
    ["receiver reference", env.PI_DRILL_RECEIVER_REFERENCE],
    ["review reference", env.PI_DRILL_REVIEW_REFERENCE],
  ] as const) {
    const token = nonBlank(value);
    if (token !== undefined && !/^[A-Za-z0-9._:-]+$/.test(token)) {
      throw new Error(`${label} must be an opaque reference token`);
    }
  }
  const monitoring = nonBlank(env.PI_DRILL_MONITORING_CONFIG);
  if (monitoring !== undefined && !path.isAbsolute(monitoring)) {
    throw new Error("drill monitoring config must be absolute");
  }
  return { dialect, textfileDir };
}

/** 收集需要被脱敏的 secret / 路径值（从环境 + 额外集合）。 */
export function collectRedactables(env: DrillEnv, extra: readonly string[] = []): string[] {
  const values = new Set<string>();
  for (const key of [
    "PI_DRILL_DATABASE_URL",
    "PI_DATABASE_URL",
    "PI_AUTH_PATH",
    "PI_AGENT_DIR",
    "PI_MODEL_API_KEY",
    "AGENT_CWD",
    "DATA_DIR",
    "DB_PATH",
    "PI_BACKUP_STAGING_ROOT",
    "PI_BACKUP_ROOT",
    "PI_FORMAL_BACKUP_ROOT",
    "PI_FORMAL_BACKUP_RECIPIENT",
    "PI_FORMAL_BACKUP_IDENTITY",
    "PI_DRILL_ROOT",
    "PI_DRILL_TEXTFILE_DIR",
    "PI_DRILL_MONITORING_CONFIG",
    "PGPASSWORD",
    "PGUSER",
    "PGPASSFILE",
  ] as const) {
    const v = env[key];
    if (v && v.trim().length >= 3) values.add(v.trim());
  }
  for (const v of extra) if (v && v.trim().length >= 3) values.add(v.trim());
  return [...values];
}

/** 脱敏：替换已知 secret/path 值，并保守地抹掉真正的绝对路径（避免误伤 data/backup 这类枚举短语）。 */
export function redactText(text: string, redactables: readonly string[]): string {
  let out = text;
  for (const value of redactables) {
    if (value.length >= 3) out = out.split(value).join("[redacted]");
  }
  // / 之前不是字母/数字（避免把 data/backup、identity/recipient 这类用 / 连接的枚举词误当路径），
  // 或前面是盘符（C:）。仅命中真正的绝对路径片段。
  out = out.replace(/(?<![A-Za-z0-9])([A-Za-z]:)?\/[^ \t\n,;)'"<>=]+/g, "[redacted]");
  return out;
}

/** 运行单个检查项，捕获异常并返回 DrillCheck（detail 不抛原始路径）。 */
function runCheck(name: string, fn: () => string): DrillCheck {
  try {
    return { name, ok: true, detail: fn() };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * preflight：安全门禁。无必须项通过即 FAIL；所有 detail 均经脱敏。
 * 不触碰任何正式资源；不创建任何目录。
 */
export function preflightDrill(env: DrillEnv): DrillVerdict {
  const redactables = collectRedactables(env);
  const checks: DrillCheck[] = [];
  // 用可变持有对象而非闭包捕获的 let，避免 TS 对闭包内赋值的窄化误判。
  const state: { root?: string; rootInfo?: DrillRootInfo } = {};

  const add = (check: DrillCheck): void => {
    checks.push({ ...check, detail: redactText(check.detail, redactables) });
  };

  add(runCheck("drill_root_set", () => {
    state.root = resolveDrillRoot(env);
    return "is set and absolute";
  }));

  if (state.root) {
    add(runCheck("drill_root_private", () => {
      state.rootInfo = validateDrillRoot(state.root!);
      return "is a current-user 0700 non-symlink directory";
    }));
    const overlapRoot = state.rootInfo?.canonical ?? state.root;
    add(runCheck("drill_overlap", () => {
      const formal = resolveFormalPaths(env);
      assertNoFormalOverlap(overlapRoot, formal, nonBlank(env.PI_DRILL_DATABASE_URL));
      // 正式 backup root/recipient/identity 必须用显式 PI_FORMAL_* 输入比较；缺失时不宣称已隔离。
      const backupAsserted = Boolean(formal.backupRoot || formal.backupRecipient || formal.backupIdentity);
      return backupAsserted
        ? "does not overlap formal data/backup/staging/auth paths (formal backup isolation asserted via PI_FORMAL_*)"
        : "does not overlap formal data/service paths (formal backup isolation NOT asserted: pass PI_FORMAL_BACKUP_ROOT/RECIPIENT/IDENTITY)";
    }));
    if (state.rootInfo) {
      add(runCheck("drill_secrets", () => {
        validateDrillSecrets(state.root!);
        return "identity/recipient are 0600 regular non-symlink files";
      }));
      add(runCheck("drill_resources", () => {
        validateDrillResources(state.root!, env);
        return "test resource / receiver config is safe";
      }));
    }
  }

  const failed = checks.filter((check) => !check.ok);
  const outcome: DrillOutcome = failed.length === 0 ? "PASS" : "FAIL";
  return {
    outcome,
    checks,
    summary: outcome === "PASS" ? "preflight ok" : `preflight blocked by ${failed.length} check(s)`,
  };
}

/**
 * 证据条目（仅安全枚举/布尔/计数/时长/version，绝不含 secret/URL/绝对路径/正文）。
 * successPath 与 faults 以布尔结果登记，便于审计且不泄密。
 */
export interface DrillEvidence {
  readonly op: string;
  readonly outcome: DrillOutcome;
  readonly stepCount: number;
  readonly passedCount: number;
  readonly dialectCount: number;
  readonly versions: Record<string, string>;
  readonly successSteps: readonly boolean[];
  readonly faults: readonly { fault: string; guard: boolean; recovery: boolean }[];
  readonly durationsMs: readonly { step: string; ms: number }[];
  readonly resourceCleanup: boolean;
  readonly completedAt: string;
}

/**
 * 把证据对象序列化并脱敏为一串安全 JSON 文本：替换已知 secret/path 值并抹掉绝对路径。
 * 证据以字符串形式返回，便于直接写入 `$PI_DRILL_ROOT/runs/<run-id>/summary.json`。
 */
export function sanitizeDrillEvidence(doc: DrillEvidence, env: DrillEnv, extra: readonly string[] = []): string {
  const redactables = collectRedactables(env, extra);
  const json = JSON.stringify(doc);
  return redactText(json, redactables);
}

/**
 * 构建证据对象（纯数据，不含路径/secret；版本号来自调用方传入 map）。
 * 若 adjudication 为 DEFERRED，则不计入通过/故障判定（仍记录到 evidence 供审计）。
 */
export function buildDrillEvidence(adjudication: DrillAdjudication, plan: DrillPlan, observations: readonly DrillObservation[], versions: Record<string, string>, completedAt: string, resourceCleanup = false): DrillEvidence {
  const successSteps = plan.steps
    .filter((spec) => spec.kind === "mandatory")
    .map((spec) => observations.find((o) => o.stepId === spec.id)?.passed ?? false);
  const faults = plan.faultScenarios.map((scenario) => {
    const guard = observations.find((o) => o.stepId === scenario.guardStep)?.passed ?? false;
    const recovery = observations.find((o) => o.stepId === scenario.recoveryStep)?.passed ?? false;
    return { fault: scenario.fault, guard, recovery };
  });
  const durationsMs = observations.map((o) => ({ step: o.stepId, ms: Math.round(o.durationMs) }));
  return {
    op: "backup-freshness-drill",
    outcome: adjudication.outcome,
    stepCount: plan.steps.length,
    passedCount: adjudication.passedCount,
    dialectCount: 2,
    versions,
    successSteps,
    faults,
    durationsMs,
    resourceCleanup,
    completedAt,
  };
}

/** cleanup 目标安全断言：必须是严格位于根内、非 symlink、非 hardlink、精确 0700/0600，且既非根也非 secrets。 */
function ensureSafeCleanupTarget(root: string, target: string): void {
  const resolved = path.resolve(target);
  if (resolved === path.resolve(root)) throw new Error("cleanup target is the drill root; refusing");
  if (!isWithin(root, resolved)) throw new Error("cleanup target escapes the drill root");
  let st;
  try {
    st = lstatSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (st.isSymbolicLink()) throw new Error("cleanup target is a symbolic link; refusing");
  // 目录的 nlink 恒包含子目录条目（>=2），hardlink 检查仅对普通文件有意义。
  if (st.isFile() && st.nlink > 1) throw new Error("cleanup target is a hardlink; refusing");
  if (st.isDirectory()) {
    if ((Number(st.mode) & 0o7777) !== 0o700) throw new Error("cleanup target is not exactly 0700; refusing");
  } else {
    if ((Number(st.mode) & 0o7777) !== 0o600) throw new Error("cleanup target is not exactly 0600; refusing");
  }
}

/**
 * cleanup：先执行完整 preflight（root + 固定 secrets + 正式路径重叠 + 资源隔离），任一失败
 * 即拒绝删除；再要求两个 secrets 有效存在。只清空明确的运行/临时子目录，固定保留
 * $PI_DRILL_ROOT/secrets（及其 age identity/recipient），绝不删除根本身。
 * 未知顶层条目一律跳过（fail-closed）。
 */
export function cleanupRunDirectories(env: DrillEnv): CleanupResult {
  const preflight = preflightDrill(env);
  if (preflight.outcome !== "PASS") {
    throw new Error("cleanup refused: preflight not passed");
  }
  const root = resolveDrillRoot(env);
  const info = validateDrillRoot(root);
  validateDrillSecrets(root);
  const r = info.canonical;
  const cleared: string[] = [];
  let removedRuns = 0;
  for (const name of WORKSPACE_DIRS) {
    // SECRETS_DIR 不在 WORKSPACE_DIRS 中，天然被保留；这里仅作显式防御。
    if ((name as string) === SECRETS_DIR) continue;
    const target = path.join(r, name);
    ensureSafeCleanupTarget(r, target);
    if (!existsSync(target)) continue;
    if (name === RUNS_DIR) {
      for (const entry of readdirSync(target)) {
        const runDir = path.join(target, entry);
        ensureSafeCleanupTarget(r, runDir);
        if (entry === SECRETS_DIR) continue;
        rmSync(runDir, { recursive: true, force: true });
        removedRuns += 1;
      }
      cleared.push(RUNS_DIR);
    } else {
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { mode: 0o700 });
      cleared.push(name);
    }
  }
  return {
    removedRuns,
    cleared,
    preservedSecrets: existsSync(path.join(r, SECRETS_DIR)),
  };
}
