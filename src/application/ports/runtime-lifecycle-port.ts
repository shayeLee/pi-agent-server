// RuntimeLifecyclePort：RuntimeRegistry 管理的生命周期操作（dispose 释放资源、pruneIdempotency 清理过期幂等记录）。
// 由 RuntimeRegistry 通过该 port 接口驱动，不暴露给 HTTP/application 层。

/** RuntimeRegistry 管理的生命周期端口：dispose 释放资源、pruneIdempotency 清理过期幂等记录。 */
export interface RuntimeLifecyclePort {
  /** 宿主关闭/删除等强制路径中止；不得受用户控制锁影响。 */
  abortForLifecycle(): Promise<void>;
  /** 释放资源（幂等，重复调用安全）。 */
  dispose(): void;
  /** 清理过期的幂等记录（内存），返回清理条数。 */
  pruneIdempotency(before: number): number;
  /** 没有进行中、排队或后台的工作，换掉 adapter 不会打断什么。 */
  isQuiescent(): boolean;
  /** adapter 用的 MCP server 已经不是现在该用的了。 */
  isAdapterOutdated(): Promise<boolean>;
}
