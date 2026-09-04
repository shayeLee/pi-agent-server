// WP4B（方案 A）安全只读 planner。
//
// 本模块是 file_operations outbox 的唯一离线配套实现，边界如下：
// - 只读：唯一数据来源是 store.list()（WP4A 仓库契约，纯 SELECT）；
//   不 claim、不 lease、不 complete/fail、不改任何状态；
// - 不扫描文件系统、不生成操作（reconcile 属 WP4C）、不触碰任何文件；
// - 报告只含计数与安全 error codes，绝不包含 relative/absolute 路径；
// - 不执行：WP4B 物理执行器未实施。真正执行需受审计的外部运维工具或未来
//   native helper（单独事项），本模块（及 file-ops CLI）永不 pretend 能执行。
//
// WP4A 的 outbox schema/repository/lease 契约保持不变，是未来执行器的实现基础。

import {
  FileOperationRecord,
  FileOperationState,
  FileOperationStorePort,
} from "../application/ports/file-operation-store-port.js";
import { isFileOperationErrorCodeAllowlisted } from "../storage/file-operation-policy.js";

/** 按状态的安全计数（唯一合法 key 集）。 */
export const PLAN_STATES: readonly FileOperationState[] = ["pending", "processing", "completed", "failed"] as const;

export interface FileOperationPlanStateCounts {
  readonly pending: number;
  readonly processing: number;
  readonly completed: number;
  readonly failed: number;
}

export interface FileOperationPlanReport {
  readonly mode: "dry-run";
  /** 恒为 false：本实现永不执行；执行需外部受审计工具或未来 native helper。 */
  readonly executable: false;
  /** 未来执行器可处理候选 = pending + processingExpired + failedDue。 */
  readonly planned: number;
  /** state=pending 的记录数。 */
  readonly pending: number;
  /** state=processing 且 lease 已过期（崩溃残留、未来可重领）的记录数。 */
  readonly processingExpired: number;
  /** state=failed 且 available_at 已到（未来可重试）的记录数。 */
  readonly failedDue: number;
  /** 全量按状态计数。 */
  readonly stateCounts: FileOperationPlanStateCounts;
  /** last_error 安全计数；key 只来自固定、有限的 allowlist（未知/相对路径/credential= 等不会是 key）。 */
  readonly errorCodes: Readonly<Record<string, number>>;
  /** last_error 不在固定 allowlist 内的行数（只计数、不泄漏值；fail-closed）。 */
  readonly unsafeErrors: number;
}

function emptyErrorCodes(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

/**
 * 只读计划：对持久 file_operations 记录做状态/错误计数。零写入、零文件访问、
 * 零 claim。任何非固定 allowlist 的 last_error 只按 unsafeErrors 计数，
 * 绝不进入报告 key（未知文本/相对路径/credential= 等一律 fail-closed）。
 */
export async function planFileOperationBatch(
  store: FileOperationStorePort,
  now: number = Date.now(),
): Promise<FileOperationPlanReport> {
  const rows: readonly FileOperationRecord[] = await store.list();
  const stateCounts: { pending: number; processing: number; completed: number; failed: number } = { pending: 0, processing: 0, completed: 0, failed: 0 };
  const errorCodes = emptyErrorCodes();
  let planned = 0;
  let pending = 0;
  let processingExpired = 0;
  let failedDue = 0;
  let unsafeErrors = 0;
  for (const row of rows) {
    if (row.state === "pending") {
      stateCounts.pending += 1;
      pending += 1;
      planned += 1;
    } else if (row.state === "processing") {
      stateCounts.processing += 1;
      if (row.leaseUntil !== null && row.leaseUntil <= now) {
        processingExpired += 1;
        planned += 1;
      }
    } else if (row.state === "completed") {
      stateCounts.completed += 1;
    } else {
      stateCounts.failed += 1;
      if (row.availableAt <= now) {
        failedDue += 1;
        planned += 1;
      }
    }
    if (row.lastError !== null) {
      if (isFileOperationErrorCodeAllowlisted(row.lastError)) {
        errorCodes[row.lastError] = (errorCodes[row.lastError] ?? 0) + 1;
      } else {
        unsafeErrors += 1;
      }
    }
  }
  return {
    mode: "dry-run",
    executable: false,
    planned,
    pending,
    processingExpired,
    failedDue,
    stateCounts,
    errorCodes,
    unsafeErrors,
  };
}