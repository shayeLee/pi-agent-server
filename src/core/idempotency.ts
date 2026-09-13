// 消息幂等去重（needs.md §4.2）
// 客户端生成的 requestId 作为键；首次执行，重复提交返回原结果，不重复执行。
//
// 载荷冲突：同一个 key 先以载荷 A 完成，又用载荷 B 重放时，直接返回 A 的结果是静默错误
// （客户端会以为 B 已被处理）。因此每次 complete 同时记录载荷指纹；check 带指纹时若不一致
// 返回 `conflict`，由调用方拒绝该重放。**仅进程内可识别**：持久化表不含指纹（见
// src/core/payload-fingerprint.ts）。

export type IdempotencyResult =
  | { status: "new" } // 首次，可以执行
  | { status: "processing" } // 并发重复提交，正在处理中
  | { status: "done"; result: unknown } // 已完成，返回原结果
  | { status: "payload-conflict" }; // 同 requestId 但载荷不同：拒绝重放，不返回旧结果

export class IdempotencyStore {
  private done = new Map<string, { result: unknown; at: number; fingerprint?: string }>();
  private processing = new Map<string, { fingerprint?: string }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * 查询幂等状态。提供 fingerprint 时，命中已完成/处理中且指纹不一致 → payload-conflict
   * （不返回旧结果）；未提供 fingerprint 时保持既有语义（向后兼容）。
   */
  check(key: string, fingerprint?: string): IdempotencyResult {
    const entry = this.done.get(key);
    if (entry) {
      if (fingerprint !== undefined && entry.fingerprint !== undefined && entry.fingerprint !== fingerprint) {
        return { status: "payload-conflict" };
      }
      return { status: "done", result: entry.result };
    }
    const inFlight = this.processing.get(key);
    if (inFlight) {
      if (fingerprint !== undefined && inFlight.fingerprint !== undefined && inFlight.fingerprint !== fingerprint) {
        return { status: "payload-conflict" };
      }
      return { status: "processing" };
    }
    this.processing.set(key, { ...(fingerprint !== undefined ? { fingerprint } : {}) });
    return { status: "new" };
  }

  complete(key: string, result: unknown, fingerprint?: string): void {
    this.processing.delete(key);
    this.done.set(key, {
      result,
      at: this.now(),
      ...(fingerprint !== undefined ? { fingerprint } : {}),
    });
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
