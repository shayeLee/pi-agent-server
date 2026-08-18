// SSE 背压判定（纯逻辑，从 SSE 路由抽出以便确定性单测）。
// write 返回 false 表示底层 socket 缓冲已满；连续失败累计，超过阈值后应主动断开慢消费者，
// 避免事件在服务端内存无界堆积。

/** 连续 write 失败达到该次数后判定应主动关闭连接。 */
export const SSE_BACKPRESSURE_THRESHOLD = 200;

export type BackpressureState = { backpressure: number; shouldClose: boolean };

/**
 * 根据单次 write 结果推进背压状态：
 * - 成功：计数归零（缓冲已排空）；
 * - 失败：计数 +1；累计超过阈值则标记应关闭。
 */
export function nextBackpressureState(
  backpressure: number,
  writeOk: boolean,
  threshold = SSE_BACKPRESSURE_THRESHOLD,
): BackpressureState {
  const next = writeOk ? 0 : backpressure + 1;
  return { backpressure: next, shouldClose: next > threshold };
}
