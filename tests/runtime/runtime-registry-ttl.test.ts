// RuntimeRegistry 幂等 TTL 调度（H6）。契约：
// - 构造时立即 prune 一次（cutoff = now - ttl；启动即清理，避免首轮定时扫描前误命中过期记录）；
// - 每 expireIntervalMs 周期 prune 一次，cutoff 随时间前进精确 = now - ttl（精确 cutoff：created_at < before）；
// - prune 失败不产生 unhandled rejection（构造与周期路径都 catch）；
// - dispose() 后不再 prune（定时器已清理）。
//
// 全部用 fake timers + fake now + spy IdempotencyStorePort，不依赖真实 setTimeout(10) 时序。
// 注：run 在 vitest fake timers 下 Date.now 随 advanceTimersByTime 前进；registry 默认 now = Date.now，
// 故这里显式注入 now 并以相同基准推进（等价、可确定的 cutoff 断言）。

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { RuntimeRegistry } from "../../src/runtime/runtime-registry.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import type { IdempotencyStorePort } from "../../src/application/ports/index.js";

const TTL_MS = 60_000;
const INTERVAL_MS = 5_000;
const START_TIME = 3_000_000;

function makeSpyIdempotencyRepo(): { repo: IdempotencyStorePort; prune: ReturnType<typeof vi.fn> } {
  const prune = vi.fn<IdempotencyStorePort["prune"]>().mockResolvedValue(0);
  const repo: IdempotencyStorePort = {
    get: async () => null,
    put: async () => {},
    prune,
  };
  return { repo, prune };
}

function makeRegistry(opts: {
  now?: () => number;
  idempotencyRepo?: IdempotencyStorePort;
  expireIntervalMs?: number;
} = {}) {
  const concurrency = new ConcurrencyController({
    globalLimit: 2,
    perUserLimit: 2,
    perUserQueueLimit: 2,
    globalQueueLimit: 4,
    queueTimeoutMs: 5000,
  });
  return new RuntimeRegistry({
    concurrency,
    createAdapter: async () => new MockAgentAdapter(),
    // 默认 now = Date.now：fake timers（含 Date）下随 advanceTimersByTime 前进，cutoff 可确定
    now: opts.now ?? (() => Date.now()),
    idempotencyRepo: opts.idempotencyRepo,
    expireIntervalMs: opts.expireIntervalMs ?? INTERVAL_MS,
    idempotencyTtlMs: TTL_MS,
  });
}

const registries: RuntimeRegistry[] = [];
afterEach(() => {
  // 释放所有 registry 定时器（fake timers 下即 dispose；真实环境 unref 不阻塞退出）
  while (registries.length) registries.pop()!.dispose();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_TIME);
});

describe("RuntimeRegistry 幂等 TTL 调度（fake now + fake timers + spy Idempotency repo）", () => {
  it("构造时立即 prune 一次，cutoff = now - ttl（启动即清理）", () => {
    const { repo, prune } = makeSpyIdempotencyRepo();
    registries.push(makeRegistry({ idempotencyRepo: repo }));
    // 构造内同步调用：cutoff 精确等于 now - idempotencyTtlMs
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith(START_TIME - TTL_MS);
  });

  it("周期性 prune：每 expireIntervalMs 一次，cutoff 随时间前进精确 = now - ttl", () => {
    const { repo, prune } = makeSpyIdempotencyRepo();
    registries.push(makeRegistry({ idempotencyRepo: repo }));
    const callArgs: number[] = [];
    prune.mockImplementation(async (before: number) => {
      callArgs.push(before);
      return 0;
    });

    vi.advanceTimersByTime(INTERVAL_MS);
    vi.advanceTimersByTime(INTERVAL_MS);
    vi.advanceTimersByTime(INTERVAL_MS + 1); // 跨到第 4 个周期边界

    expect(callArgs).toEqual([
      START_TIME + INTERVAL_MS - TTL_MS,
      START_TIME + INTERVAL_MS * 2 - TTL_MS,
      START_TIME + INTERVAL_MS * 3 - TTL_MS,
    ]);
  });

  it("精确 cutoff：before = now - ttl 作为 prune 入参（仓库层测 created_at < before 的删除语义）", () => {
    // 与仓库层 prune(created_at < before) 语义对接：此处锁定传入的 before 值随时间精确推进
    const { repo, prune } = makeSpyIdempotencyRepo();
    registries.push(makeRegistry({ idempotencyRepo: repo }));
    vi.advanceTimersByTime(INTERVAL_MS * 2);
    expect(prune).toHaveBeenLastCalledWith(START_TIME + INTERVAL_MS * 2 - TTL_MS);
  });

  it("prune 失败不产生 unhandled rejection（构造与周期路径均被 catch）", async () => {
    const { repo, prune } = makeSpyIdempotencyRepo();
    prune.mockRejectedValue(new Error("模拟 prune 失败（数据库不可用）"));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      registries.push(makeRegistry({ idempotencyRepo: repo }));
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3); // 触发构造 + 3 次周期 prune
      // 所有 rejection 都已被 .catch(() => {}) 吞掉，进程级不泄漏
      expect(unhandled).toEqual([]);
      expect(prune).toHaveBeenCalledTimes(4); // 1 构造 + 3 周期
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("dispose() 后不再 prune；重复 dispose 幂等不抛错", () => {
    const { repo, prune } = makeSpyIdempotencyRepo();
    const registry = makeRegistry({ idempotencyRepo: repo });
    expect(prune).toHaveBeenCalledTimes(1); // 构造 prune

    registry.dispose();
    registries.push(registry); // afterEach 再 dispose 验证幂等
    vi.advanceTimersByTime(INTERVAL_MS * 10);
    expect(prune).toHaveBeenCalledTimes(1); // dispose 后定时器不再触发
    registry.dispose();
    expect(prune).toHaveBeenCalledTimes(1);
  });
});