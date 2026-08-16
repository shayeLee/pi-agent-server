// 并发控制（README §4.2）
// 全局与每用户并发上限、每用户/全局队列长度、排队超时、全局超载拒绝。

export type ConcurrencyConfig = {
  globalLimit: number; // 全局并发上限
  perUserLimit: number; // 每用户并发上限
  perUserQueueLimit: number; // 每用户队列长度上限
  globalQueueLimit: number; // 全局队列长度上限（超载阈值）
  queueTimeoutMs: number; // 排队超时
};

export type Decision =
  | { kind: "run" }
  | { kind: "queue"; position: number }
  | { kind: "reject"; reason: "user-queue-full" | "global-overload" };

type QueuedTask = { taskId: string; userId: string; enqueuedAt: number };

export class ConcurrencyController {
  private readonly config: ConcurrencyConfig;
  private active = new Map<string, string>(); // taskId -> userId
  private queue: QueuedTask[] = [];

  constructor(config: ConcurrencyConfig) {
    this.config = config;
  }

  submit(taskId: string, userId: string, now: number): Decision {
    const userQueued = this.queue.filter((t) => t.userId === userId).length;
    if (userQueued >= this.config.perUserQueueLimit) {
      return { kind: "reject", reason: "user-queue-full" };
    }
    if (this.queue.length >= this.config.globalQueueLimit) {
      return { kind: "reject", reason: "global-overload" };
    }
    if (this.canRun(userId)) {
      this.active.set(taskId, userId);
      return { kind: "run" };
    }
    this.queue.push({ taskId, userId, enqueuedAt: now });
    return { kind: "queue", position: this.queue.length };
  }

  finish(taskId: string): string[] {
    this.active.delete(taskId);
    return this.drainQueue();
  }

  cancelQueued(taskId: string): boolean {
    const idx = this.queue.findIndex((t) => t.taskId === taskId);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    return true;
  }

  expireQueued(now: number): string[] {
    const expiredIds = this.queue
      .filter((t) => now - t.enqueuedAt >= this.config.queueTimeoutMs)
      .map((t) => t.taskId);
    if (expiredIds.length > 0) {
      this.queue = this.queue.filter((t) => !expiredIds.includes(t.taskId));
    }
    return expiredIds;
  }

  activeCount(): number {
    return this.active.size;
  }

  queuedCount(): number {
    return this.queue.length;
  }

  private canRun(userId: string): boolean {
    if (this.active.size >= this.config.globalLimit) return false;
    const userActive = [...this.active.values()].filter((u) => u === userId).length;
    return userActive < this.config.perUserLimit;
  }

  private drainQueue(): string[] {
    const promoted: string[] = [];
    const remaining: QueuedTask[] = [];
    for (const t of this.queue) {
      if (this.canRun(t.userId)) {
        this.active.set(t.taskId, t.userId);
        promoted.push(t.taskId);
      } else {
        remaining.push(t);
      }
    }
    this.queue = remaining;
    return promoted;
  }
}
