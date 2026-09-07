// RuntimeRegistry：管理会话与 runtime/事件总线的绑定（needs.md §4.2 会话生命周期）。
// - 构造注入 ConcurrencyController 与 createAdapter(sessionId) => AgentAdapter 工厂；
// - getOrCreate(sessionId, ownerKey)：首次创建 SessionRuntime（onEvent 接到对应会话的
//   SessionEventBus.push）与 SessionEventBus，之后复用；返回 { runtime, events }；
// - delete(sessionId)：移除会话的 runtime 与事件总线（会话删除时清理）；
// - 同 sessionId 复用同一 runtime/events；不同 sessionId 各自独立。

import { SessionRuntime, getExpireHandler, SessionDeletedError } from "./session-runtime.js";
import { SessionEventBus } from "./session-event-bus.js";
import type { ConcurrencyController } from "../core/concurrency-control.js";
import type { AgentAdapter } from "../agent/agent-adapter.js";
import type {
  IdempotencyStorePort,
  ManagedSessionRuntimePort,
  ObservabilityPort,
  SessionRuntimePort,
} from "../application/ports/index.js";

export { SessionDeletedError } from "./session-runtime.js";

export type RuntimeRegistryOptions = {
  concurrency: ConcurrencyController;
  /** 按 sessionId 异步创建通用 Agent 适配器；具体 Agent Session 由 application factory 负责。 */
  createAdapter: (sessionId: string) => Promise<AgentAdapter>;
  /** 时钟注入（默认 Date.now），便于测试；透传给 SessionRuntime。 */
  now?: () => number;
  /** 排队超时扫描间隔（毫秒，默认 30000）。 */
  expireIntervalMs?: number;
  /** 幂等记录持久化后端（可选，透传给 SessionRuntime）。 */
  idempotencyRepo?: IdempotencyStorePort;
  /** 幂等记录保留时长（毫秒，默认 24 小时）；过期的内存/SQLite 记录被定期清理。 */
  idempotencyTtlMs?: number;
  /** 观测订阅口（可选，透传给 SessionRuntime）。 */
  observability?: ObservabilityPort;
};

/** 默认幂等记录保留时长（24 小时）。 */
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** 删除会话时等待 pending 创建的超时（毫秒），避免 createAdapter 永不 resolve 时 DELETE 永久挂起。 */
const DELETE_PENDING_TIMEOUT_MS = 10_000;

/** 删除墓碑保留时长（毫秒，默认 24 小时）；过期后清理，避免无界增长。 */
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

/** 一个会话的绑定：任务编排 runtime（经 port 接口暴露）+ 该会话独占的事件总线。 */
export type SessionEntry = {
  runtime: SessionRuntimePort;
  events: SessionEventBus;
};

type ManagedSessionEntry = {
  runtime: ManagedSessionRuntimePort;
  events: SessionEventBus;
};

export class RuntimeRegistry {
  private readonly concurrency: ConcurrencyController;
  private readonly createAdapter: (sessionId: string) => Promise<AgentAdapter>;
  private readonly now: () => number;
  private readonly sessions = new Map<string, ManagedSessionEntry>();
  /** 初始化中的 Promise 占位，避免同一 session 的并发 getOrCreate 各自创建（竞态）。 */
  private readonly pending = new Map<string, Promise<ManagedSessionEntry>>();
  /** 删除墓碑（sessionId → 删除时间戳）：已删的 sessionId 在此 map，getOrCreate 拒绝重建；TTL 后清理。 */
  private readonly deleted = new Map<string, number>();
  private readonly expiryTimer: ReturnType<typeof setInterval>;
  private readonly idempotencyRepo?: IdempotencyStorePort;
  private readonly idempotencyTtlMs: number;
  private readonly observability?: ObservabilityPort;

  constructor(options: RuntimeRegistryOptions) {
    this.concurrency = options.concurrency;
    this.createAdapter = options.createAdapter;
    this.now = options.now ?? Date.now;
    this.idempotencyRepo = options.idempotencyRepo;
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.observability = options.observability;
    // 队列超时调度器：定期扫描超时排队任务并触发过期处理（unref 不阻止进程退出）
    this.expiryTimer = setInterval(
      () => this.expireQueuedTasks(),
      options.expireIntervalMs ?? 30_000,
    );
    this.expiryTimer.unref?.();
    // 启动时先同步 prune 一次 SQLite 过期幂等记录，避免首轮定时扫描前误命中过期记录
    if (this.idempotencyRepo) {
      void this.idempotencyRepo.prune(this.now() - this.idempotencyTtlMs).catch(() => {});
    }
  }

  /** 扫描超时排队任务，触发所属 runtime 的过期处理；并清理过期的幂等记录。 */
  private expireQueuedTasks(): void {
    const expired = this.concurrency.expireQueued(this.now());
    for (const taskId of expired) {
      getExpireHandler(taskId)?.();
    }
    // 幂等记录 TTL 清理（内存 + 持久化）
    const before = this.now() - this.idempotencyTtlMs;
    for (const { runtime } of this.sessions.values()) {
      runtime.pruneIdempotency(before);
    }
    if (this.idempotencyRepo) {
      void this.idempotencyRepo.prune(before).catch(() => {});
    }
    // 墓碑 TTL 清理：删除超过 24 小时的墓碑（此时 SQLite 通常也已删，findOwned 会拦）
    const tombstoneBefore = this.now() - TOMBSTONE_TTL_MS;
    for (const [id, ts] of this.deleted) {
      if (ts < tombstoneBefore) this.deleted.delete(id);
    }
  }

  /** 释放调度器定时器（优雅关闭时调用）。 */
  dispose(): void {
    clearInterval(this.expiryTimer);
  }

  /** 获取已存在的会话绑定（不创建）。 */
  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  /** 获取会话绑定；命中删除墓碑或不存在时异步创建（并发安全：同 session 只创建一次）。 */
  async getOrCreate(sessionId: string, ownerKey: string): Promise<SessionEntry> {
    // 删除墓碑：已删的会话拒绝重建，避免「删除后又被并发请求冒出来」
    if (this.deleted.has(sessionId)) {
      throw new SessionDeletedError(sessionId);
    }
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const inFlight = this.pending.get(sessionId);
    if (inFlight) return inFlight;

    const promise = this.create(sessionId, ownerKey);
    this.pending.set(sessionId, promise);
    try {
      const entry = await promise;
      if (this.deleted.has(sessionId)) {
        // 创建期间被删除：dispose 刚创建的 entry，抛错（不写回 map）
        entry.runtime.dispose();
        throw new SessionDeletedError(sessionId);
      }
      this.sessions.set(sessionId, entry);
      return entry;
    } finally {
      this.pending.delete(sessionId);
    }
  }

  private async create(sessionId: string, ownerKey: string): Promise<ManagedSessionEntry> {
    const events = new SessionEventBus();
    const runtime = new SessionRuntime({
      sessionId,
      ownerKey,
      concurrency: this.concurrency,
      adapter: await this.createAdapter(sessionId),
      now: this.now,
      idempotencyRepo: this.idempotencyRepo,
      observability: this.observability,
      // 会话运行时的所有输出事件写入该会话独占的事件总线（SSE 缓冲/分发）
      onEvent: (event) => events.push(event),
    });
    return { runtime, events };
  }

  /** 删除会话：写入永久墓碑、中止在途任务、释放 adapter 资源并移除 runtime/事件总线。 */
  async delete(sessionId: string): Promise<void> {
    // 永久墓碑（TTL 内有效）：此后任何 getOrCreate 都拒绝（墓碑不随 delete 结束清除）
    this.deleted.set(sessionId, this.now());
    const entry = this.sessions.get(sessionId);
    if (entry) {
      try {
        await entry.runtime.abort().catch(() => {}); // idle 时 abort 返回 conflict，无害
      } finally {
        // 关闭 SSE 连接、释放 adapter/订阅、清理 registry，每一步都兜底，保证 sessions.delete 一定执行
        try {
          entry.events.closeAll();
        } catch {
          // 忽略
        }
        try {
          entry.runtime.dispose();
        } catch {
          // 忽略
        }
        this.sessions.delete(sessionId);
      }
    } else {
      this.sessions.delete(sessionId);
    }
    // 若 pending 创建在途，等它完成后（带超时）再清理
    const inFlight = this.pending.get(sessionId);
    if (inFlight) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const created = await Promise.race([
        inFlight.then((e) => e).catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), DELETE_PENDING_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer); // 提前完成时清理超时定时器
      if (created) {
        await created.runtime.abort().catch(() => {});
        created.runtime.dispose();
      }
      this.sessions.delete(sessionId);
    }
  }

  /** 优雅关闭时并行中止所有在途任务并释放 adapter 资源（idle 会话的 abort 返回 conflict，无害；dispose 幂等）。 */
  async abortAll(): Promise<void> {
    // 并行 abort：每个卡住的 abort 最多 5 秒，避免串行等待累积超出优雅关闭时限
    await Promise.allSettled(
      [...this.sessions.values()].map(async ({ runtime }) => {
        await runtime.abort().catch(() => {});
        runtime.dispose();
      }),
    );
  }

  /** 关闭所有会话的 SSE 连接（优雅关闭时先调用，避免 app.close 等待长连接）。 */
  closeAllEvents(): void {
    for (const { events } of this.sessions.values()) {
      events.closeAll();
    }
  }
}