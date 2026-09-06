/**
 * 故障注入矩阵（纯定义）。每个故障场景是一个「防护(guard) + 恢复(recovery)」对：
 * - guard：注入故障后，系统必须正确 fail-closed（备份非零、无成功报告、freshness 不推进、
 *   指标不半写/不倒退、告警触发等）；
 * - recovery：解除故障后，下一次成功运行必须使指标前进、对应告警自动清除、锁可恢复。
 *
 * 本模块只定义故障场景的标识、类别与判定元数据（纯数据），不执行任何副作用；具体由
 * drill-exec.ts 的 live executor 实现，单测用 fixture adapter 验证判定逻辑。
 */

/** 与 SOP 失败注入矩阵一一对应的故障场景标识。 */
export type FaultKind =
  | "age-failure"
  | "pg-tool-failure"
  | "sqlite-snapshot-failure"
  | "report-missing"
  | "report-duplicate"
  | "report-unparseable"
  | "report-dryrun"
  | "finalpath-escape"
  | "finalpath-perm"
  | "finalpath-owner"
  | "single-flight"
  | "late-run"
  | "clock-rollback"
  | "crash-rename"
  | "symlink-unsafe-perm"
  | "missing-alert"
  | "stale-alert"
  | "future-alert"
  | "exporter-down"
  | "textfile-scrape-error";

/** 故障场景元数据：id、所属类别、是否需要「告警触发并恢复」验收。 */
export interface FaultScenario {
  readonly fault: FaultKind;
  /** 防护步骤 id（guard）。 */
  readonly guardStep: string;
  /** 恢复步骤 id（recovery）。 */
  readonly recoveryStep: string;
  /** 是否必须同时证明告警触发(fires)且恢复(clears)（监控类为 true）。 */
  readonly alertCycle: boolean;
}

/** 防护/恢复步骤 id 的稳定前缀。 */
const GUARD_PREFIX = "fault:guard:";
const RECOVERY_PREFIX = "fault:recovery:";

export function guardStepId(fault: FaultKind): string {
  return `${GUARD_PREFIX}${fault}`;
}
export function recoveryStepId(fault: FaultKind): string {
  return `${RECOVERY_PREFIX}${fault}`;
}

/** 监控类故障（缺/旧/未来 freshness、exporter down、textfile scrape error）需要告警触发并恢复。 */
const ALERT_CYCLE_FAULTS: ReadonlySet<FaultKind> = new Set<FaultKind>([
  "missing-alert",
  "stale-alert",
  "future-alert",
  "exporter-down",
  "textfile-scrape-error",
]);

export function isAlertCycle(fault: FaultKind): boolean {
  return ALERT_CYCLE_FAULTS.has(fault);
}

/** 故障矩阵（SOP §4）。顺序即执行顺序；监控类故障最后（依赖正常监控基线）。 */
export const FAULT_SCENARIOS: readonly FaultScenario[] = [
  { fault: "age-failure", guardStep: guardStepId("age-failure"), recoveryStep: recoveryStepId("age-failure"), alertCycle: false },
  { fault: "pg-tool-failure", guardStep: guardStepId("pg-tool-failure"), recoveryStep: recoveryStepId("pg-tool-failure"), alertCycle: false },
  { fault: "sqlite-snapshot-failure", guardStep: guardStepId("sqlite-snapshot-failure"), recoveryStep: recoveryStepId("sqlite-snapshot-failure"), alertCycle: false },
  { fault: "report-missing", guardStep: guardStepId("report-missing"), recoveryStep: recoveryStepId("report-missing"), alertCycle: false },
  { fault: "report-duplicate", guardStep: guardStepId("report-duplicate"), recoveryStep: recoveryStepId("report-duplicate"), alertCycle: false },
  { fault: "report-unparseable", guardStep: guardStepId("report-unparseable"), recoveryStep: recoveryStepId("report-unparseable"), alertCycle: false },
  { fault: "report-dryrun", guardStep: guardStepId("report-dryrun"), recoveryStep: recoveryStepId("report-dryrun"), alertCycle: false },
  { fault: "finalpath-escape", guardStep: guardStepId("finalpath-escape"), recoveryStep: recoveryStepId("finalpath-escape"), alertCycle: false },
  { fault: "finalpath-perm", guardStep: guardStepId("finalpath-perm"), recoveryStep: recoveryStepId("finalpath-perm"), alertCycle: false },
  { fault: "finalpath-owner", guardStep: guardStepId("finalpath-owner"), recoveryStep: recoveryStepId("finalpath-owner"), alertCycle: false },
  { fault: "single-flight", guardStep: guardStepId("single-flight"), recoveryStep: recoveryStepId("single-flight"), alertCycle: false },
  { fault: "late-run", guardStep: guardStepId("late-run"), recoveryStep: recoveryStepId("late-run"), alertCycle: false },
  { fault: "clock-rollback", guardStep: guardStepId("clock-rollback"), recoveryStep: recoveryStepId("clock-rollback"), alertCycle: false },
  { fault: "crash-rename", guardStep: guardStepId("crash-rename"), recoveryStep: recoveryStepId("crash-rename"), alertCycle: false },
  { fault: "symlink-unsafe-perm", guardStep: guardStepId("symlink-unsafe-perm"), recoveryStep: recoveryStepId("symlink-unsafe-perm"), alertCycle: false },
  { fault: "missing-alert", guardStep: guardStepId("missing-alert"), recoveryStep: recoveryStepId("missing-alert"), alertCycle: true },
  { fault: "stale-alert", guardStep: guardStepId("stale-alert"), recoveryStep: recoveryStepId("stale-alert"), alertCycle: true },
  { fault: "future-alert", guardStep: guardStepId("future-alert"), recoveryStep: recoveryStepId("future-alert"), alertCycle: true },
  { fault: "exporter-down", guardStep: guardStepId("exporter-down"), recoveryStep: recoveryStepId("exporter-down"), alertCycle: true },
  { fault: "textfile-scrape-error", guardStep: guardStepId("textfile-scrape-error"), recoveryStep: recoveryStepId("textfile-scrape-error"), alertCycle: true },
] as const;

/** 授权枚举：允许被 drill 验证的故障场景集合（用于拒绝未知/越权注入）。 */
export function isValidFault(fault: string): fault is FaultKind {
  return FAULT_SCENARIOS.some((entry) => entry.fault === fault);
}

export const FAULT_KINDS: readonly FaultKind[] = FAULT_SCENARIOS.map((entry) => entry.fault);
