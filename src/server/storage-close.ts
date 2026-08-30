// 幂等 storage close helper。
//
// startServer 在成功路径（app.close 触发 onClose）与失败路径（schema 初始化后的后续步骤 / app.listen 抛错）
// 都需要释放 Kysely / DatabaseSync。为保证「无论走哪条路径都恰好销毁一次」，这里用单个 closer
// 作为唯一所有权点：首次调用执行真正的 destroy；进行中的并发调用返回同一个 in-flight
// Promise（共享同一次 destroy 的完成结果）；destroy 结束后（无论成败）后续调用一律 no-op。
// destroy 抛错时原样传播给首次（及并发共享）调用者，不掩盖原始错误，且失败后不重复尝试。

export function createIdempotentStorageCloser(
  destroy: () => Promise<void> | void,
): () => Promise<void> {
  let closed = false;
  let inFlight: Promise<void> | null = null;
  return function close(): Promise<void> {
    // 进行中的并发 caller 共享同一个 in-flight Promise（等待同一次 destroy 完成）
    if (inFlight) return inFlight;
    // destroy 已结束（无论成败）：后续调用一律 no-op，不重复销毁、不重复抛错
    if (closed) return Promise.resolve();
    closed = true;
    inFlight = Promise.resolve()
      .then(destroy)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

/**
 * 失败路径收尾：尝试 await close() 但仍保证原始 error 不被掩盖。
 *
 * startServer / mock-server 的启动 catch 需要先释放存储、再向上抛原始错误；
 * 若清理本身失败，不能让 cleanupError 覆盖原始 error。这里只把 cleanupError
 * 交给 onCleanupError（可记录/忽略），无论清理成功与否都重新抛出原始 error。
 * 返回 Promise<never>：调用方流程不会从这里继续。
 */
export async function closeStoragePreservingError(
  close: () => Promise<void>,
  error: unknown,
  onCleanupError?: (cleanupError: unknown) => void,
): Promise<never> {
  try {
    await close();
  } catch (cleanupError) {
    onCleanupError?.(cleanupError);
  }
  throw error;
}
