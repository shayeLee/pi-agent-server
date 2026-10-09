// IdempotencyStorePort：幂等记录持久化端口（needs.md §4.2 requestId 去重跨重启）。
// 进程内 IdempotencyStore 提供快路径；本接口把已完成请求的终态结果持久化，
// 重启后重复提交同一 requestId 时返回原结果，不重复执行。
// 作为 application/ports 层的正式契约，storage 实现依赖此接口。

export type IdempotencyReservationResult =
  | { kind: "owner"; token: string }
  | { kind: "done"; result: unknown; fingerprint: string | null }
  | { kind: "reserved"; fingerprint: string | null };

export interface IdempotencyStorePort {
  /** 查已完成请求的终态结果；无记录返回 null。保留中的预约不得作为 miss 返回。 */
  get(sessionId: string, requestId: string): Promise<unknown | null>;
  /** Atomic lookup with the persisted payload fingerprint (new schema). */
  getWithFingerprint?(sessionId: string, requestId: string): Promise<{ result: unknown; fingerprint: string | null } | null>;
  /** 原子地占有 request key；owner 是唯一可执行者，既有预约表示执行结果未知。 */
  reserve?(sessionId: string, requestId: string, fingerprint: string): Promise<IdempotencyReservationResult>;
  /** 仅当 token 仍匹配预约时提交终态；false 表示预约已不再由此执行者持有。 */
  completeReservation?(sessionId: string, requestId: string, token: string, result: unknown, fingerprint: string): Promise<boolean>;
  /** 仅释放尚未执行的本 token 预约。 */
  releaseReservation?(sessionId: string, requestId: string, token: string): Promise<boolean>;
  /** 写入/覆盖请求的终态结果（兼容既有调用）。 */
  put(sessionId: string, requestId: string, result: unknown, fingerprint?: string): Promise<void>;
  /** 清理 before 之前的记录（TTL），返回清理条数。 */
  prune(before: number): Promise<number>;
}
