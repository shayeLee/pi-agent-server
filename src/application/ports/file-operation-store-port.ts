// 持久化文件操作 outbox 端口（WP4A）。
// 数据库只记录待执行的文件副作用；本端口不执行 unlink，实际 worker 留给后续工作包。

export const FILE_OPERATION_STATES = ["pending", "processing", "completed", "failed"] as const;
export type FileOperationState = (typeof FILE_OPERATION_STATES)[number];

export const FILE_OPERATION_KINDS = ["delete"] as const;
export type FileOperationKind = (typeof FILE_OPERATION_KINDS)[number];

/** 允许的持久状态转移；过期 lease 由 claim 作为 processing → processing 的重新预留处理。 */
export const FILE_OPERATION_TRANSITIONS: Readonly<Record<FileOperationState, readonly FileOperationState[]>> = Object.freeze({
  pending: ["processing"],
  processing: ["completed", "failed"],
  completed: [],
  failed: ["processing"],
});

export interface FileOperationRecord {
  id: string;
  /** 稳定且绑定 agent kind + conversation format + 相对路径的业务幂等键，例如 delete-artifact:<agentKind>:<conversationFormat>:<path-digest>（不含 sessionId）。 */
  operationKey: string;
  kind: FileOperationKind;
  /** 相对 DATA_DIR 的、经过白名单校验的 JSONL 路径。 */
  relativePath: string;
  sessionId: string | null;
  projectId: string | null;
  state: FileOperationState;
  attemptCount: number;
  availableAt: number;
  leaseUntil: number | null;
  leaseToken: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueFileOperationInput {
  operationKey: string;
  relativePath: string;
  kind?: FileOperationKind;
  sessionId?: string | null;
  projectId?: string | null;
  createdAt?: number;
}

export interface FileOperationStorePort {
  /** 按 operationKey 幂等入队；同键重复入队返回既有记录，不覆盖其状态。 */
  enqueue(input: EnqueueFileOperationInput): Promise<FileOperationRecord>;
  get(id: string): Promise<FileOperationRecord | null>;
  getByOperationKey(operationKey: string): Promise<FileOperationRecord | null>;
  list(state?: FileOperationState): Promise<FileOperationRecord[]>;
  /**
   * 原子预留可执行操作：返回 processing 记录及 leaseToken。
   * 实现必须在 SQLite/PG 的同一事务内完成候选选择与状态更新；本方法不执行文件副作用。
   */
  claim(now?: number, limit?: number, leaseMs?: number): Promise<FileOperationRecord[]>;
  /**
   * 仅 processing → completed；leaseToken 是必填的 fencing token。
   * Lease expiry makes a row reclaimable; token equality fences the old worker
   * as soon as another claim replaces the lease (the chosen lease-validity policy).
   */
  complete(id: string, leaseToken: string): Promise<boolean>;
  /** 仅 processing → failed；leaseToken 是必填的 fencing token，nextAttemptAt 决定重试时间。 */
  fail(id: string, error: unknown, nextAttemptAt: number | undefined, leaseToken: string): Promise<boolean>;
}
