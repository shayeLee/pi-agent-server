/**
 * backup freshness helper 的纯逻辑（脱敏、可单测）：解析 `backup-json-report` 机器报告，
 * 依据 SOP §2/§3 决定是否推进 freshness 指标。真正的原子写入/锁/single-flight 由执行器
 * （drill-exec.ts）结合本模块的纯判定实现；这里的函数无副作用、可在 vitest 直接验证。
 */

/** 解析后的 published 机器报告。 */
export interface MachineReport {
  readonly dialect: string;
  readonly status: "published";
  readonly dryRun: false;
  readonly finalPath: string;
  readonly payloadCount: number;
  readonly missingSessionReferences: number;
}

const REPORT_PREFIX = "backup-json-report:";

/**
 * 解析备份 CLI 的 stdout 为机器报告。规则：必须恰好一行 `backup-json-report:` 前缀且可
 * 解析为 status=published / dryRun=false / finalPath 非空。缺失、重复、不可解析一律返回 null
 * （helper 拒绝推进 freshness）。绝不抛出带原始路径/URL 的异常。
 */
export function parseMachineReport(stdout: string): MachineReport | null {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const matches = lines.filter((line) => line.startsWith(REPORT_PREFIX));
  // 恰好一行；0 行或 >1 行都视为不满足（0 = 缺失，>1 = 重复）。
  if (matches.length !== 1) return null;
  const raw = matches[0]!.slice(REPORT_PREFIX.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.status !== "published" || record.dryRun !== false) return null;
  if (typeof record.finalPath !== "string" || record.finalPath.trim() === "") return null;
  return {
    dialect: String(record.dialect ?? ""),
    status: "published",
    dryRun: false,
    finalPath: record.finalPath,
    payloadCount: toCount(record.payloadCount),
    missingSessionReferences: toCount(record.missingSessionReferences),
  };
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 报告校验是否位于备份根内（词法 plus 拒绝绝对路径逃逸）。 */
export function isWithin(root: string, candidate: string): boolean {
  const relative = relativePath(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${pathSeparator()}`) && !isAbsolutePath(relative));
}

function relativePath(root: string, candidate: string): string {
  const rootParts = normalize(root);
  const candidateParts = normalize(candidate);
  const r = rootParts.join("/");
  const c = candidateParts.join("/");
  if (c === r) return "";
  if (!c.startsWith(`${r}/`)) {
    // may share ancestor
    let i = 0;
    while (i < rootParts.length && i < candidateParts.length && rootParts[i] === candidateParts[i]) i += 1;
    return `../`.repeat(rootParts.length - i) + candidateParts.slice(i).join("/");
  }
  return c.slice(r.length + 1);
}

function normalize(input: string): string[] {
  const absolute = isAbsolutePath(input) ? input : `/`;
  const parts: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    // strip any Windows drive prefix already handled by isAbsolutePath
    parts.push(segment);
  }
  return parts;
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function isAbsolutePath(input: string): boolean {
  return input.startsWith("/") || /^[A-Za-z]:[\\/]/.test(input);
}

/**
 * 判定是否推进 freshness。全部通过才 update：
 * - exitCode === 0；
 * - report 恰好一行且 published / dryRun=false；
 * - finalPath 位于 backupRoot 内；
 * - 包目录与 COMPLETE 存在；
 * - 包属主/权限合法。
 * 任一不满足 → skip，并给出脱敏 reason（仅枚举/布尔，不含路径）。
 */
export interface FreshnessGuardInput {
  readonly exitCode: number;
  readonly report: MachineReport | null;
  readonly backupRoot: string;
  readonly finalPath: string | null;
  readonly completeExists: boolean;
  readonly packageOwnerOk: boolean;
}

export interface FreshnessGuardResult {
  readonly update: boolean;
  /** 脱敏原因：只含枚举/布尔，绝不含路径/URL。 */
  readonly reason: string;
}

export function evaluateFreshnessGuard(input: FreshnessGuardInput): FreshnessGuardResult {
  if (input.exitCode !== 0) return { update: false, reason: "exit non-zero" };
  if (input.report === null) return { update: false, reason: "machine report invalid (missing/duplicate/unparseable or not published)" };
  const finalPath = input.finalPath ?? input.report.finalPath;
  if (!finalPath || !isWithin(input.backupRoot, finalPath)) return { update: false, reason: "finalPath outside backup root" };
  if (!input.completeExists) return { update: false, reason: "COMPLETE marker missing" };
  if (!input.packageOwnerOk) return { update: false, reason: "package owner/perm unsafe" };
  return { update: true, reason: "guard passed" };
}

/** 计算新的 freshness 值，并强制**不倒退**与「不早于 now+300s 才算有效」的时钟约束。 */
export interface FreshnessValueInput {
  readonly backupStart: number;
  readonly priorValue: number | null;
  readonly now: number;
  readonly maxFutureSkewSec: number;
}
export interface FreshnessValueResult {
  readonly value: number | null;
  /** 若拒绝写入，给出脱敏原因。 */
  readonly reason: string;
  readonly advanced: boolean;
}
export function computeFreshnessValue(input: FreshnessValueInput): FreshnessValueResult {
  if (input.backupStart > input.now + input.maxFutureSkewSec) {
    return { value: null, reason: "clock rollback rejected (backup start too far in the future)", advanced: false };
  }
  if (input.priorValue !== null && input.backupStart < input.priorValue) {
    return { value: null, reason: "no-regress guard: refusing to move freshness backwards", advanced: false };
  }
  if (input.priorValue !== null && input.backupStart === input.priorValue) {
    return { value: input.backupStart, reason: "unchanged value", advanced: false };
  }
  return { value: input.backupStart, reason: "updated", advanced: input.priorValue === null || input.backupStart > input.priorValue };
}

/** textfile 指标内容（脱敏：只含数字与固定 label）。 */
export function freshnessTextfileContent(value: number, target: string): string {
  // 仅数字与固定 label；target 由调用方保证为安全 token。
  return `# HELP pi_agent_server_backup_last_success_timestamp_seconds Last successful backup start.\n# TYPE pi_agent_server_backup_last_success_timestamp_seconds gauge\npi_agent_server_backup_last_success_timestamp_seconds{target="${target}"} ${value}\n`;
}
