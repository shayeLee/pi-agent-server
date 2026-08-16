// 消息幂等去重（README §4.2）
// 客户端生成的 requestId 作为键；首次执行，重复提交返回原结果，不重复执行。

export type IdempotencyResult =
  | { status: "new" } // 首次，可以执行
  | { status: "processing" } // 并发重复提交，正在处理中
  | { status: "done"; result: unknown }; // 已完成，返回原结果

export class IdempotencyStore {
  private done = new Map<string, { result: unknown; at: number }>();
  private processing = new Set<string>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  check(key: string): IdempotencyResult {
    const entry = this.done.get(key);
    if (entry) {
      return { status: "done", result: entry.result };
    }
    if (this.processing.has(key)) {
      return { status: "processing" };
    }
    this.processing.add(key);
    return { status: "new" };
  }

  complete(key: string, result: unknown): void {
    this.processing.delete(key);
    this.done.set(key, { result, at: this.now() });
  }

  fail(key: string): void {
    this.processing.delete(key);
  }

  /** 清理 before 之前完成的记录（TTL），返回清理条数。 */
  prune(before: number): number {
    let count = 0;
    for (const [key, entry] of this.done) {
      if (entry.at < before) {
        this.done.delete(key);
        count++;
      }
    }
    return count;
  }
}
