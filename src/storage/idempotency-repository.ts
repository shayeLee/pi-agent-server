// 幂等记录持久化抽象（README §4.2 requestId 去重跨重启）。
// 进程内 IdempotencyStore 提供快路径；本接口把已完成请求的终态结果持久化，
// 重启后重复提交同一 requestId 时返回原结果，不重复执行。

export interface IdempotencyRepository {
  /** 查已完成请求的终态结果；无记录返回 null。 */
  get(sessionId: string, requestId: string): Promise<unknown | null>;
  /** 写入/覆盖请求的终态结果（幂等，重复写覆盖）。 */
  put(sessionId: string, requestId: string, result: unknown): Promise<void>;
  /** 清理 before 之前的记录（TTL），返回清理条数。 */
  prune(before: number): Promise<number>;
}
