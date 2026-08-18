// SessionEventBus：per-session 事件缓冲与分发（needs.md §4.2）。
// - push 为事件分配从 1 开始的递增 id，追加到有界缓冲（超限淘汰最旧），并同步通知所有活跃订阅者；
// - subscribe(listener, lastEventId?)：携带 lastEventId 时先按序补发缓冲中 id > lastEventId 的事件，
//   之后实时接收；返回退订函数；
// - 纯内存、同步，供 SSE 断线续传（Last-Event-ID）与服务端事件缓冲使用。

import type { SseEvent } from "../agent/events.js";

/** 带序号的事件（SSE 事件 id：客户端 Last-Event-ID 续传的基准）。 */
export type SseEventBatch = { id: number; event: SseEvent };

export type SessionEventBusOptions = {
  /** 有界缓冲容量；超限淘汰最旧事件（默认 1000）。 */
  maxEvents?: number;
};

export class SessionEventBus {
  private readonly maxEvents: number;
  private readonly buffer: SseEventBatch[] = [];
  private readonly subscribers = new Set<(item: SseEventBatch) => void>();
  /** 连接关闭回调（SSE 路由注册，删除会话/关闭时触发以终止长连接）。 */
  private readonly closeHandlers = new Set<() => void>();
  private nextId = 1;

  constructor(options: SessionEventBusOptions = {}) {
    this.maxEvents = options.maxEvents ?? 1000;
  }

  /** 当前最新事件 id（0 表示尚无事件）；供导出时返回快照 cursor，客户端据此订阅增量。 */
  get lastEventId(): number {
    return this.nextId - 1;
  }

  /** 分配递增 id、追加到有界缓冲并同步通知所有活跃订阅者；返回分配到的 id。 */
  push(event: SseEvent): number {
    const item: SseEventBatch = { id: this.nextId++, event };
    this.buffer.push(item);
    if (this.buffer.length > this.maxEvents) {
      this.buffer.shift(); // 淘汰最旧
    }
    // 迭代快照：通知期间新订阅者不参与本次派发；隔离单个订阅者异常，避免中断其他订阅者分发
    for (const listener of [...this.subscribers]) {
      try {
        listener(item);
      } catch {
        // 单个坏订阅者（如坏 SSE 客户端）不得影响其他订阅者
      }
    }
    return item.id;
  }

  /**
   * 订阅事件流；返回退订函数（退订后不再收到事件）。
   * 提供 lastEventId 时先按序补发缓冲中 id > lastEventId 的事件，再实时接收；
   * 不提供则只接收之后的新事件。
   */
  subscribe(
    listener: (item: SseEventBatch) => void,
    lastEventId?: number,
  ): () => void {
    // 只有显式提供 lastEventId 才补发（不带参数只接收之后的新事件）；隔离单个监听器异常
    if (lastEventId !== undefined) {
      for (const item of this.buffer) {
        if (item.id > lastEventId) {
          try {
            listener(item);
          } catch {
            // 补发期间监听器异常不得中断后续补发
          }
        }
      }
    }
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /** 注册连接关闭回调（SSE 路由用它清理心跳与响应）；返回注销函数。 */
  registerClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  /** 关闭所有关联连接（删除会话/优雅关闭时调用）；幂等。 */
  closeAll(): void {
    for (const handler of [...this.closeHandlers]) {
      try {
        handler();
      } catch {
        // 隔离单个 close handler 异常，避免一个坏连接阻塞其余关闭（优雅关闭自锁）
      }
    }
    this.closeHandlers.clear();
    this.subscribers.clear();
  }
}