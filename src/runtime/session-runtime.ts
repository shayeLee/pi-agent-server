// SessionRuntime：把状态机 / 并发控制 / 幂等 / Agent 适配器串成会话任务生命周期（needs.md §4.2、docs/architecture.md §1 数据流 ④⑤⑥⑦⑧）。
// - 外部依赖全部注入（ConcurrencyController / AgentAdapter / now / onEvent），单元测试一律用 MockAgentAdapter，不碰真实 Pi SDK。
// - SDK 事件经 translateSdkEvent 翻译后输出；queued / completed / aborted / error 由本编排层合成。
// - 返回决策为判别联合类型（run / queued / rejected / conflict / done；控制接口 ok / conflict）。

import { transition, type TaskState, type TaskEvent } from "../core/task-state-machine.js";
import type { ConcurrencyController } from "../core/concurrency-control.js";
import { IdempotencyStore } from "../core/idempotency.js";
import { payloadFingerprint } from "../core/payload-fingerprint.js";
import type { AgentAdapter, ImageInput } from "../agent/agent-adapter.js";
import type { FailbackLifecycleEvent } from "../agent/failback-lifecycle.js";
import type { AgentSdkEvent, SseEvent } from "../agent/events.js";
import { translateSdkEvent } from "../agent/translate.js";
import { extractFinalStop } from "../agent/events.js";
import type {
  IdempotencyStorePort,
  ManagedSessionRuntimePort,
  ObservabilityEvent,
  ObservabilityPort,
  RunTurnInput,
  SessionTurnResult,
  SubmitDecision,
  ControlDecision,
  SubmitInput,
} from "../application/ports/index.js";
import { TURN_ERROR_CODES } from "../application/ports/session-runtime-port.js";

/** 单一 requestId 的同步轮次等待者：settle 时按该 key 专属结果一次性 resolve。 */
type TurnWaiter = { resolve: (result: SessionTurnResult) => void };

/** 单一 requestId 的轮次累计（按运行时实际 currentKey 归属，隔离跨请求事件）。
 * maxToolCalls / maxDurationMs 与 maxText 同构：runTurn 专属预算，不传时为 Infinity（无限制）。 */
type TurnState = {
  text: string;
  maxText: number;
  overflow: boolean;
  maxToolCalls: number;
  maxDurationMs: number;
};

/** 会话已删除：disposed runtime 上调用方法时抛出，HTTP 层转 404。 */
export class SessionDeletedError extends Error {
  constructor(sessionId: string) {
    super(`会话已删除: ${sessionId}`);
    this.name = "SessionDeletedError";
  }
}

export type SessionRuntimeOptions = {
  sessionId: string;
  ownerKey: string;
  concurrency: ConcurrencyController;
  adapter: AgentAdapter;
  now: () => number;
  onEvent: (event: SseEvent) => void;
  /** 幂等记录持久化后端（可选）；提供则重启后重复 requestId 返回原结果不重复执行。 */
  idempotencyRepo?: IdempotencyStorePort;
  /** 观测订阅口（可选）；关键路径推送脱敏观测事件（调用耗时/usage/队列/错误）。 */
  observability?: ObservabilityPort;
};

type PendingTask = {
  requestId: string;
  userId: string;
  prompt: string;
  parentId?: string;
  images?: ImageInput[];
  key: string;
  fingerprint: string;
};

// 排队中任务的接续执行注册表（taskId → 拥有该排队任务的 runtime 的启动函数）。
// concurrency.finish 释放槽位后返回的出队 taskId 可能属于其他会话（全局/每用户队列跨会话），
// 由注册表把任务交还给所属 runtime 执行（dequeue：queued → streaming）。
const RESUME_REGISTRY = new Map<string, (taskId: string) => void>();
/** 排队任务的过期处理注册表（taskId → 过期回调，供调度器触发排队超时）。 */
const EXPIRY_REGISTRY = new Map<string, () => void>();

/** 供调度器查询排队任务的过期回调。 */
export function getExpireHandler(taskId: string): (() => void) | undefined {
  return EXPIRY_REGISTRY.get(taskId);
}

/** abort 超时（毫秒）：避免上游 abort 永不返回时卡死并发槽位。 */
const ABORT_TIMEOUT_MS = 5_000;
/** usage 读取超时（毫秒）：避免 getLastUsage 挂起时永久占用并发槽位。 */
const USAGE_TIMEOUT_MS = 1_000;
/** 单 turn 工具错误（isError）次数上限：超过则中止，避免模型反复请求未授权/失败工具无限循环。 */
const MAX_TOOL_ERRORS_PER_TURN = 8;
/**
 * Node 定时器可接受的最大延迟（2^31 - 1 ms，即 32 位有符号上限）。
 * 超过该值时 Node 会发 `TimeoutOverflowWarning` 并把延迟**改为 1ms**，使本来“约 24.8 天”的
 * 预算变成“约 1ms 后超时”。因此必须显式截断；截断后若到点仍未结束，
 * `armTurnDeadline` 会按剩余额度继续武装下一段（见 expire 前的重算逻辑）。
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** 把毫秒延迟收敛到 Node 定时器可接受范围（非有限值视为无穷，用最大值代替）。 */
function clampTimerDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs)) return MAX_TIMER_DELAY_MS;
  return Math.min(Math.max(delayMs, 0), MAX_TIMER_DELAY_MS);
}

export class SessionRuntime implements ManagedSessionRuntimePort {
  readonly sessionId: string;
  readonly ownerKey: string;

  private readonly concurrency: ConcurrencyController;
  private readonly adapter: AgentAdapter;
  private readonly now: () => number;
  private readonly onEvent: (event: SseEvent) => void;
  private readonly idempotency = new IdempotencyStore();
  private readonly idempotencyRepo?: IdempotencyStorePort;
  private readonly observability?: ObservabilityPort;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeFailbackLifecycle: () => void;
  private disposed = false;
  /** 当前 failback 尝试锁：只拦用户 abort；关闭/删除/断连走强制路径。 */
  private failbackAttemptId: string | null = null;
  /** abort 超时/失败后标记：底层可能仍在运行，拒绝复用（避免旧事件混入新任务）。 */
  private poisoned = false;
  /** abort 进行中：adapter.abort() 等待期间到达的事件仍可见（abort 前的部分输出）。 */
  private aborting = false;
  /** 最近一次 agent_end 的最终 assistant stopReason（结果权威：stop/error/aborted/length/toolUse）。 */
  private lastStopReason: string | null = null;
  private lastErrorMessage: string | null = null;
  /** 当前 turn 的时间统计。 */
  private turnStartTime: number | null = null;
  private turnFirstTokenTime: number | null = null;
  /** 当前 turn 的工具错误（isError）计数：达到上限后中止，避免无限工具循环。 */
  private toolErrorCount = 0;
  private toolErrorLimitReached = false;
  /** 当前 turn 的工具调用总次数（成功与失败都算一次）与是否已超 maxToolCallsPerTurn。 */
  private toolCallCount = 0;
  private toolCallLimitReached = false;
  /** 当前 turn 是否已因墙钟超限中止（由本 turn 的 deadline timer 置位）。 */
  private turnDeadlineExceeded = false;
  /** 当前 turn 的墙钟 deadline timer；settle / dispose 必须清除，绝不泄漏。 */
  private turnDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  /** 本 turn 墙钟计时的起点（首次武装时记录）；收紧上限时据此算剩余额度，null 表示本 turn 未计时。 */
  private turnDeadlineStartedAt: number | null = null;
  /** 同 requestId 的并发提交去重：共享同一 in-flight promise（避免 processing 占位与状态机竞态）。
   * 同时记录载荷指纹：不同载荷重用同一 requestId 时拒绝，绝不把旧执行结果返回给新输入。 */
  private readonly inFlightSubmits = new Map<string, { fingerprint: string; promise: Promise<SubmitDecision> }>();

  private taskState: TaskState = "idle";
  private currentTaskId: string | null = null;
  private currentKey: string | null = null;
  private currentRequestId: string | null = null;
  /** 当前任务的载荷指纹（settle 时随终态一并落账，供进程内载荷冲突识别）。 */
  private currentFingerprint: string | null = null;
  private readonly pending = new Map<string, PendingTask>();
  /**
   * 同步轮次（runTurn）的 per-request 等待者与文本累计，键为 `${sessionId}:${requestId}`。
   * 文本只在当前 task 的 key 命中该表时累计，settle 只结算同 key 的等待者：旧请求的事件
   * 绝不会串入新请求，且 submit 异步窗口期间到达的旧事件也不会被误归属。
   */
  private readonly turnWaiters = new Map<string, TurnWaiter[]>();
  private readonly turnStates = new Map<string, TurnState>();

  constructor(options: SessionRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.ownerKey = options.ownerKey;
    this.concurrency = options.concurrency;
    this.adapter = options.adapter;
    this.now = options.now;
    this.onEvent = options.onEvent;
    this.idempotencyRepo = options.idempotencyRepo;
    this.observability = options.observability;
    this.unsubscribe = this.adapter.subscribe((event) => this.handleSdkEvent(event));
    this.unsubscribeFailbackLifecycle = this.adapter.subscribeFailbackLifecycle?.((event) =>
      this.handleFailbackLifecycle(event),
    ) ?? (() => {});
  }

  /** 释放资源：退订事件 + 释放并发槽位/清理排队 + dispose 底层 adapter（幂等，重复调用安全）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.unsubscribeFailbackLifecycle();
    this.failbackAttemptId = null;
    // 清除本 turn 的墙钟 deadline timer，绝不泄漏。
    this.clearTurnDeadline();
    // 释放 active 任务占用的并发槽位（触发 drain 接续其他会话）；不依赖调用方先 abort
    if (this.currentTaskId !== null) {
      this.continuePromoted(this.concurrency.finish(this.currentTaskId));
      this.currentTaskId = null;
    }
    this.currentKey = null;
    this.currentRequestId = null;
    this.currentFingerprint = null;
    // 清理排队任务：取消占位、释放幂等重试资格、清注册表
    for (const [taskId, task] of this.pending) {
      this.idempotency.fail(task.key);
      this.concurrency.cancelQueued(taskId);
      RESUME_REGISTRY.delete(taskId);
      EXPIRY_REGISTRY.delete(taskId);
    }
    this.pending.clear();
    // 资源释放时同步终结未结算的同步轮次（如尚未 settle 的 runTurn），避免插件请求永久挂起。
    for (const key of [...this.turnWaiters.keys()]) {
      this.resolveTurnWaiters(key, { status: "aborted" });
    }
    this.adapter.dispose();
  }

  /** 当前任务状态（idle/queued/streaming/terminal）。 */
  get state(): TaskState {
    return this.taskState;
  }

  /** POST /v1/sessions/:id/messages：同 requestId 并发去重 → 幂等 → 状态机 → 并发控制 → Agent 执行。
   * run 路径立即返回决策，流式在后台执行（事件经 onEvent 推送）；HTTP 层因此可快速返回。 */
  async submitMessage(input: SubmitInput): Promise<SubmitDecision> {
    if (this.disposed) throw new SessionDeletedError(this.sessionId);
    if (this.poisoned) {
      // abort 超时后的会话不可复用（旧底层调用可能仍产生事件）
      return { kind: "conflict", reason: "poisoned" };
    }
    const key = `${this.sessionId}:${input.requestId}`;
    const fingerprint = payloadFingerprint(input);
    // 同 requestId 并发提交：共享同一 in-flight promise，得到相同结果（不重复执行、无占位竞态）；
    // 但载荷不同的并发重放是冲突，不共享 promise。
    const inFlight = this.inFlightSubmits.get(key);
    if (inFlight) {
      return inFlight.fingerprint === fingerprint
        ? inFlight.promise
        : { kind: "conflict", reason: "payload-mismatch" };
    }
    const promise = this.doSubmit(input, fingerprint);
    this.inFlightSubmits.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      this.inFlightSubmits.delete(key);
    }
  }

  /**
   * 同步执行一轮并返回该 requestId 专属结果（插件宿主专用）。
   *
   * 与 submitMessage 不同，它不使用 session 级事件流，而是在 runtime 内部按
   * 当前 task 的 key（即本 requestId）累计助手文本并在 settle 时结算，因此
   * submit 异步窗口内到达的旧请求事件绝不会串入本请求，也不需要靠“微小窗口”去猜。
   *
   * - session 正忙 / 排队 / 限流 → busy，并撤销本轮排队，不留后台任务；
   * - 同一 requestId 以不同 prompt 重放（进程内可识别）→ busy（不返回旧结果）；
   * - signal 触发只终止本 key 对应的 task（currentKey 不匹配则绝不误杀其他 task）；
   * - 助手文本超过 maxAssistantTextLength 时中止本轮并返回 error；
   * - 工具调用次数超过 maxToolCallsPerTurn、或本轮耗时超过 maxTurnDurationMs 时同样中止本轮并返回 error；
   *   超限 error 都带稳定的 `code`（见 {@link TURN_ERROR_CODES}），多个预算同时置位时按
   *   工具次数 > 墙钟 > 助手文本的固定优先级取 code；
   * - 三个上限都是 runTurn 专属预算，不传时为无限制（与不引入预算时逐字节等价）。
   *
   * 已知限制：跨进程重启后，持久化幂等表不保存载荷指纹（见 src/core/payload-fingerprint.ts），
   * 因此同一 requestId 以不同 prompt 重放会命中旧终态并返回 busy/旧结果；本任务不引入 schema 变更。
   */
  async runTurn(input: RunTurnInput): Promise<SessionTurnResult> {
    if (this.disposed) throw new SessionDeletedError(this.sessionId);
    const key = `${this.sessionId}:${input.requestId}`;
    const signal = input.signal;
    // 已 aborted：不提交、不产生任何任务。
    if (signal?.aborted) return { status: "aborted" };

    let resolveWaiter: (result: SessionTurnResult) => void = () => {};
    const settled = new Promise<SessionTurnResult>((resolve) => {
      resolveWaiter = resolve;
    });
    const waiter: TurnWaiter = { resolve: resolveWaiter };
    const waiters = this.turnWaiters.get(key);
    if (waiters) waiters.push(waiter);
    else this.turnWaiters.set(key, [waiter]);
    const maxText = input.maxAssistantTextLength ?? Number.POSITIVE_INFINITY;
    const maxToolCalls = input.maxToolCallsPerTurn ?? Number.POSITIVE_INFINITY;
    // 墙钟上限只接受有限非负值：负数/NaN 不是「更严的上限」，若直接参与下面的 Math.min 与
    // 重武装判断，会把已有 deadline 撤销掉（clear 后因非法值提前 return），反而变成无限制。
    // 非法值一律视为「未提供」，绝不因此放宽已有预算。
    const requestedDuration = input.maxTurnDurationMs;
    const maxDurationMs =
      typeof requestedDuration === "number" && Number.isFinite(requestedDuration) && requestedDuration >= 0
        ? requestedDuration
        : Number.POSITIVE_INFINITY;
    const existingState = this.turnStates.get(key);
    if (existingState) {
      // 同一 requestId 重复登记：取更严的上限（与 maxText 一致）。
      existingState.maxText = Math.min(existingState.maxText, maxText);
      existingState.maxToolCalls = Math.min(existingState.maxToolCalls, maxToolCalls);
      const tightenedDuration = maxDurationMs < existingState.maxDurationMs;
      existingState.maxDurationMs = Math.min(existingState.maxDurationMs, maxDurationMs);
      // 收紧 duration 时必须重武装 timer：否则已武装的 timer 仍按旧（更宽松）额度计时，
      // 「取更严上限」对墙钟不生效。仅在收紧且本 key 正是当前 streaming 任务时重算剩余额度。
      if (tightenedDuration && this.currentKey === key && this.taskState === "streaming") {
        this.armTurnDeadline(key);
      }
    } else {
      this.turnStates.set(key, {
        text: "",
        maxText,
        overflow: false,
        maxToolCalls,
        maxDurationMs,
      });
    }

    // 只终止本 requestId 对应的 task：先校验 currentKey，再 abort；否则绝不误杀其他 task。
    const abortOwnTask = () => {
      if (this.currentKey !== key) return;
      if (this.taskState !== "streaming") return;
      void this.abortInternal(undefined, true).catch(() => {});
    };
    const onSignalAbort = () => abortOwnTask();
    if (signal) signal.addEventListener("abort", onSignalAbort, { once: true });

    try {
      const decision = await this.submitMessage({
        requestId: input.requestId,
        userId: this.ownerKey,
        prompt: input.prompt,
      });
      if (decision.kind === "conflict" || decision.kind === "rejected") return { status: "busy" };
      if (decision.kind === "queued") {
        // 全局/用户队列繁忙：撤销本轮排队，不留后台任务；abort 在 queued 时取消排队。
        await this.abort().catch(() => {});
        return { status: "busy" };
      }
      if (decision.kind === "done") {
        // 同一 requestId 已处理：返回值只保存状态，没有可重放的助手文本。
        const previous = decision.result as { status?: unknown; message?: unknown; code?: unknown } | null;
        if (previous !== null && typeof previous === "object" && previous.status === "aborted") {
          return { status: "aborted" };
        }
        if (previous !== null && typeof previous === "object" && previous.status === "error") {
          const message = typeof previous.message === "string" ? previous.message : "任务失败";
          // code 为 additive 可选字段：旧记录无 code 时保持原样（不凭空补 code）。
          return typeof previous.code === "string"
            ? { status: "error", message, code: previous.code }
            : { status: "error", message };
        }
        return { status: "error", message: "本轮已完成，助手文本不可重放" };
      }
      // decision.kind === "run"：等待本 key 的 settle。
      // signal 可能在 submit 异步窗口内已触发（当时 task 尚未成为 current）：补查一次。
      if (signal?.aborted) abortOwnTask();
      return await settled;
    } finally {
      if (signal) signal.removeEventListener("abort", onSignalAbort);
      this.removeTurnWaiter(key, waiter);
    }
  }

  /** 结算某 key 的全部同步轮次等待者；清空该 key 的等待者与文本累计。 */
  private resolveTurnWaiters(key: string, result: SessionTurnResult): void {
    const waiters = this.turnWaiters.get(key);
    this.turnWaiters.delete(key);
    this.turnStates.delete(key);
    if (!waiters) return;
    for (const waiter of waiters) waiter.resolve(result);
  }

  /** 移除尚未结算的等待者；若该 key 已无等待者则同时清理文本累计。 */
  private removeTurnWaiter(key: string, waiter: TurnWaiter): void {
    const waiters = this.turnWaiters.get(key);
    if (!waiters) return;
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    if (waiters.length === 0) {
      this.turnWaiters.delete(key);
      this.turnStates.delete(key);
    }
  }

  private async doSubmit(input: {
    requestId: string;
    userId: string;
    prompt: string;
    parentId?: string;
    images?: ImageInput[];
  }, fingerprint: string): Promise<SubmitDecision> {
    const key = `${this.sessionId}:${input.requestId}`;
    const idem = this.idempotency.check(key, fingerprint);
    if (idem.status === "payload-conflict") {
      // 同 requestId 不同载荷（进程内可识别）：拒绝，不返回旧结果，也不重复执行。
      return { kind: "conflict", reason: "payload-mismatch" };
    }
    if (idem.status === "done") {
      // 已处理过：返回原结果，不重复执行
      return { kind: "done", result: idem.result };
    }
    // 重启恢复：内存 miss 时查持久化，命中则加载并返回 done 不重复执行
    if (idem.status === "new" && this.idempotencyRepo) {
      try {
        const persisted = await this.idempotencyRepo.get(this.sessionId, input.requestId);
        if (this.disposed) throw new SessionDeletedError(this.sessionId); // 查库期间被删除
        if (persisted !== null) {
          this.idempotency.complete(key, persisted, fingerprint);
          return { kind: "done", result: persisted };
        }
      } catch (error) {
        this.idempotency.fail(key); // 查询失败：释放 processing 占位，允许重试
        throw error;
      }
    }
    if (idem.status === "processing") {
      // 同 requestId 正在处理（运行期重试，如丢失 202 后）：返回「已接受」语义，不重复执行
      // 省略 position：真实队列位置由全局队列决定，不伪造为固定值
      if (this.taskState === "queued") {
        return { kind: "queued" };
      }
      // streaming 或 terminal（abort 中，客户端经 SSE 收到 aborted）：都表示任务已被接受
      return { kind: "run" };
    }

    // 状态机：仅 idle 可 submit（idle+submit → queued）；否则 409
    const afterSubmit = transition(this.taskState, "submit");
    if (afterSubmit === null) {
      this.idempotency.fail(key);
      return { kind: "conflict", reason: "active" };
    }
    this.taskState = afterSubmit;

    const taskId = key; // taskId 与会话+请求一一对应，全局唯一
    const decision = this.concurrency.submit(taskId, input.userId, this.now());
    if (decision.kind === "run") {
      this.taskState = transition(this.taskState, "dequeue")!; // queued → streaming
      this.currentTaskId = taskId;
      this.currentKey = key;
      this.currentRequestId = input.requestId;
      this.currentFingerprint = fingerprint;
      // 清空上一任务的终态，避免旧 error/aborted 污染本任务
      this.lastStopReason = null;
      this.lastErrorMessage = null;
      this.turnStartTime = null;
      this.turnFirstTokenTime = null;
      // 流式后台执行，不阻塞提交决策（HTTP 立即返回，事件经 onEvent → SSE 推送）
      this.launchStreamingTask({
        requestId: input.requestId,
        userId: input.userId,
        prompt: input.prompt,
        parentId: input.parentId,
        images: input.images,
        key,
        fingerprint,
      });
      return { kind: "run" };
    }
    if (decision.kind === "queue") {
      const task: PendingTask = {
        requestId: input.requestId,
        userId: input.userId,
        prompt: input.prompt,
        parentId: input.parentId,
        images: input.images,
        key,
        fingerprint,
      };
      this.pending.set(taskId, task);
      RESUME_REGISTRY.set(taskId, (id) => this.startQueuedTask(id));
      EXPIRY_REGISTRY.set(taskId, () => this.handleExpired(taskId));
      this.emitEvent({ type: "queued", position: decision.position, requestId: input.requestId });
      this.observe({
        type: "queue",
        sessionId: this.sessionId,
        requestId: input.requestId,
        position: decision.position,
      });
      return { kind: "queued", position: decision.position };
    }
    // reject（429 语义）：任务未执行，状态回 idle（queued→abort→idle），解除幂等占位
    this.taskState = transition(this.taskState, "abort")!;
    this.idempotency.fail(key);
    return { kind: "rejected", reason: decision.reason };
  }

  /** POST /v1/sessions/:id/steer：仅 streaming 合法，转发给 adapter。 */
  async steer(text: string): Promise<ControlDecision> {
    if (this.disposed) throw new SessionDeletedError(this.sessionId);
    const key = this.currentKey;
    if (transition(this.taskState, "steer") === null) return { kind: "conflict" };
    await this.adapter.steer(text);
    // await 期间可能被删除/中止：失权返回 conflict（不误报 ok）
    if (this.disposed) throw new SessionDeletedError(this.sessionId);
    if (this.currentKey !== key || this.taskState !== "streaming") return { kind: "conflict" };
    return { kind: "ok" };
  }

  /** GET /v1/sessions/:id/export：透传给 adapter 导出会话数据（快照读取，不改变任务状态）。 */
  async exportSession(): Promise<unknown> {
    if (this.disposed) throw new SessionDeletedError(this.sessionId);
    return this.adapter.exportSession();
  }

  /** 切换模型（透传 adapter；切换不影响任务状态机）。 */
  async setModel(provider: string, modelId: string): Promise<void> {
    if (this.disposed) throw new SessionDeletedError(this.sessionId);
    await this.adapter.setModel(provider, modelId);
  }

  /** 切换思考级别（透传 adapter）。 */
  async setThinkingLevel(level: string): Promise<void> {
    if (this.disposed) throw new SessionDeletedError(this.sessionId);
    await this.adapter.setThinkingLevel(level);
  }

  /** 清理过期的幂等记录（内存），返回清理条数（供 TTL 调度）。 */
  pruneIdempotency(before: number): number {
    return this.idempotency.prune(before);
  }

  /** POST /v1/sessions/:id/follow-ups：仅 streaming 合法，转发给 adapter。 */
  async followUp(text: string): Promise<ControlDecision> {
    if (this.disposed) throw new SessionDeletedError(this.sessionId);
    const key = this.currentKey;
    if (transition(this.taskState, "followUp") === null) return { kind: "conflict" };
    await this.adapter.followUp(text);
    // await 期间可能被删除/中止：失权返回 conflict（不误报 ok）
    if (this.disposed) throw new SessionDeletedError(this.sessionId);
    if (this.currentKey !== key || this.taskState !== "streaming") return { kind: "conflict" };
    return { kind: "ok" };
  }

  /**
   * POST /v1/sessions/:id/abort：queued 取消排队；streaming 中止并释放槽位；其余 409。
   * 提供 expectedRequestId 时，必须匹配 queued/streaming/aborting 中的当前任务；不匹配时
   * 在任何状态变更、adapter.abort 或 aborted 事件之前返回 conflict。
   */
  async abort(expectedRequestId?: string): Promise<ControlDecision> {
    return this.abortInternal(expectedRequestId, false);
  }

  /** 删除/关闭/连接撤销的强制中止入口：永不被 failback 用户控制锁拦截。 */
  async abortForLifecycle(): Promise<void> {
    await this.abortInternal(undefined, true).catch(() => {});
  }

  private async abortInternal(expectedRequestId: string | undefined, force: boolean): Promise<ControlDecision> {
    if (this.disposed) throw new SessionDeletedError(this.sessionId);
    if (!force && this.failbackAttemptId !== null) return { kind: "conflict", reason: "failback-in-progress" };
    const queuedTaskId = this.taskState === "queued" ? this.firstPendingTaskId() : null;
    const activeRequestId = queuedTaskId === null
      ? this.currentRequestId
      : this.pending.get(queuedTaskId)?.requestId ?? null;
    if (expectedRequestId !== undefined && expectedRequestId !== activeRequestId) {
      return { kind: "conflict" };
    }
    if (this.taskState === "queued") {
      const taskId = queuedTaskId;
      // 排队取消也要绑定被取消任务的 requestId（从 pending 取出，可能与后续任务不同）。
      let canceledRequestId: string | undefined;
      if (taskId !== null) {
        const canceled = this.concurrency.cancelQueued(taskId);
        if (!canceled) {
          // 已被其他会话 finish 出队（转 active）但尚未开始执行：归还槽位并接续其他排队任务
          this.continuePromoted(this.concurrency.finish(taskId));
        }
        const task = this.pending.get(taskId);
        if (task) {
          canceledRequestId = task.requestId;
          this.idempotency.fail(task.key);
        }
        this.pending.delete(taskId);
        RESUME_REGISTRY.delete(taskId);
        EXPIRY_REGISTRY.delete(taskId);
      }
      this.taskState = transition("queued", "abort")!; // → idle
      this.emitEvent({ type: "aborted", requestId: canceledRequestId });
      return { kind: "ok" };
    }
    if (this.taskState === "streaming") {
      this.taskState = transition("streaming", "abort")!; // → terminal
      this.aborting = true;
      // 快照 abort 原因：避免 abort 等待期间新到达的事件改变共享标志，导致用户 abort 被误判为预算超限。
      // 优先级固定为 工具调用次数 > 墙钟 > 工具错误（与 settle 中的 code 优先级一致）。
      const dueToToolCallBudget = this.toolCallLimitReached;
      const dueToDurationBudget = this.turnDeadlineExceeded;
      const dueToToolBudget = this.toolErrorLimitReached;
      try {
        // abort 设超时，避免 SDK 永不返回时卡死并发槽位与优雅关闭
        await Promise.race([
          this.adapter.abort(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("abort 超时")), ABORT_TIMEOUT_MS),
          ),
        ]);
      } catch {
        // abort 抛错或超时：标记 poisoned，后续拒绝新任务（避免旧事件混入新任务）
        this.poisoned = true;
      } finally {
        this.aborting = false;
        // 预算触发的 abort 结算为 error（而非用户 abort），保留超限语义
        if (dueToToolCallBudget) {
          this.settle("error", "本轮工具调用次数超过上限", undefined, TURN_ERROR_CODES.toolBudget).catch(() => {
            // settle 异步失败不影响 abort 控制语义
          });
        } else if (dueToDurationBudget) {
          this.settle("error", "本轮耗时超过上限", undefined, TURN_ERROR_CODES.durationBudget).catch(() => {
            // settle 异步失败不影响 abort 控制语义
          });
        } else {
          this.settle(dueToToolBudget ? "error" : "aborted", dueToToolBudget ? "连续工具调用失败次数超限" : undefined).catch(() => {
            // settle 异步失败不影响 abort 控制语义
          });
        }
      }
      return { kind: "ok" };
    }
    return { kind: "conflict" };
  }

  // --- 内部实现 ---

  /**
   * 同一 adapter/loader 的扩展 EventBus 事件才会到这里；再以 active currentRequestId 与
   * attemptId 成对校验，拒绝 idle、迟到、跨尝试事件，避免把状态串到其它 session/request。
   */
  private handleFailbackLifecycle(event: FailbackLifecycleEvent): void {
    if (this.disposed || this.currentRequestId === null || this.taskState !== "streaming") return;
    if (event.phase === "start") {
      if (this.failbackAttemptId !== null) return;
      this.failbackAttemptId = event.attemptId;
      this.emitEvent({ type: "model_failback", phase: "start", attemptId: event.attemptId, requestId: this.currentRequestId });
      return;
    }
    if (this.failbackAttemptId !== event.attemptId) return;
    this.emitEvent({
      type: "model_failback",
      phase: "end",
      attemptId: event.attemptId,
      ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
      ...(event.from !== undefined ? { from: event.from } : {}),
      ...(event.to !== undefined ? { to: event.to } : {}),
      ...(event.reason !== undefined ? { reason: event.reason } : {}),
      requestId: this.currentRequestId,
    });
    // extension 已在 emit end 前完成/拒绝 continuation；此处才允许用户 abort。
    this.failbackAttemptId = null;
  }

  /** SDK 事件翻译后输出；agent_end 缓存终态，prompt resolve 后按 stopReason 判定 completed/error/aborted。 */
  private handleSdkEvent(event: AgentSdkEvent): void {
    // 仅在活动期处理：streaming（正常）或 aborting（abort 等待期间的部分输出仍可见）
    const active = this.taskState === "streaming" || this.aborting;
    if (!active) return; // 忽略 stray 事件
    // agent_end 携带最终 assistant 的 stopReason/errorMessage，缓存供 prompt resolve 后判定
    if (event.type === "agent_end") {
      const final = extractFinalStop(event.messages);
      this.lastStopReason = final.stopReason;
      this.lastErrorMessage = final.errorMessage;
    }
    const translated = translateSdkEvent(event);
    if (translated === null) return;
    // 工具预算（两类）：
    // - 工具错误预算：tool_end isError 计数，超限中止，避免模型无限循环请求失败/未授权工具；
    // - 工具调用次数预算：runTurn 专属的 maxToolCallsPerTurn，成功与失败都算一次调用。
    // 同时置位时优先级固定为 工具调用次数 > 工具错误（abortInternal 快照处同样按此顺序）。
    let budgetAbort = false;
    if (translated.type === "tool_end") {
      this.toolCallCount++;
      const turnState = this.currentKey !== null ? this.turnStates.get(this.currentKey) : undefined;
      const maxToolCalls = turnState?.maxToolCalls ?? Number.POSITIVE_INFINITY;
      if (this.toolCallCount > maxToolCalls && !this.toolCallLimitReached) {
        this.toolCallLimitReached = true;
        budgetAbort = true;
      }
      if (translated.isError) {
        this.toolErrorCount++;
        if (this.toolErrorCount > MAX_TOOL_ERRORS_PER_TURN && !this.toolErrorLimitReached) {
          this.toolErrorLimitReached = true;
          budgetAbort = true;
        }
      }
    }
    // 首个 text_delta 计算 TTFT
    if (translated.type === "text_delta" || translated.type === "thinking_delta") {
      if (this.turnStartTime !== null && this.turnFirstTokenTime === null) {
        this.turnFirstTokenTime = this.now();
      }
    }
    // 同步轮次（runTurn）文本累计：只累计当前 task（currentKey）对应的 requestId 状态；
    // 旧请求的事件绝不会写入新请求的状态，从而隔离 session 级事件流。
    if (translated.type === "text_delta" && this.currentKey !== null) {
      const turnState = this.turnStates.get(this.currentKey);
      if (turnState !== undefined) {
        turnState.text += translated.text;
        if (!turnState.overflow && turnState.text.length > turnState.maxText) {
          turnState.overflow = true;
          // 超限：中止本轮，避免继续消耗模型资源；settle 时按 overflow 返回 error。
          void this.abortInternal(undefined, true).catch(() => {});
        }
      }
    }
    // 所有 turn 相关事件都携带当前 requestId（P7b）：客户端据此把同轮事件归组，
    // 并把迟到/补发的旧事件与新请求隔离。仅在活动窗口（streaming/aborting）处理，
    // 因此 stray 事件与 settle 遗落事件绝不会绑到下一个 request。
    this.emitEvent({ ...translated, requestId: this.currentRequestId ?? undefined });
    // 当前事件先发出再调度自动中止：避免 abort 同步触发的事件在本次 tool_end 之前进入 SSE（顺序倒置）
    if (budgetAbort) {
      void this.abortInternal(undefined, true).catch(() => {
        // 预算中止失败不阻断事件流（abort 内部已做超时/poison 处理）
      });
    }
  }

  /** 任务所有权检查：未 dispose、仍在 streaming、且 key 仍是当前任务。 */
  private ownsTask(key: string): boolean {
    return !this.disposed && this.taskState === "streaming" && this.currentKey === key;
  }

  /**
   * 为本 turn 建立墙钟 deadline timer（仅当 runTurn 显式传了有限的 maxTurnDurationMs）。
   *
   * 采用真实 timer（而非在事件上比对注入的 `now()`）：事件驱动的退路无法捕获完全静默的
   * 挂起（模型/provider 不产生任何事件），而真实 timer 可以。timer 已 unref，不会阻止
   * 进程退出；settle / dispose 必定清除，绝不泄漏。超时走与工具预算完全相同的
   * abortInternal(undefined, true) 路径。
   */
  private armTurnDeadline(key: string): void {
    // 只清 timer，**不**清起点：收紧上限重武装时必须保留本 turn 已消耗的时间。
    this.clearTurnDeadlineTimer();
    const turnState = this.turnStates.get(key);
    const maxDurationMs = turnState?.maxDurationMs ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(maxDurationMs) || maxDurationMs < 0) return;
    // 首次武装时记录本 turn 的起点，后续同一 requestId 收紧上限时据此计算剩余额度，
    // 而不是用新上限重新计时（那会变相放宽已消耗的时间）。
    if (this.turnDeadlineStartedAt === null) this.turnDeadlineStartedAt = this.now();
    const remainingMs = maxDurationMs - (this.now() - this.turnDeadlineStartedAt);
    if (remainingMs <= 0) {
      // 收紧后的上限已被消耗完：立即按超时处理，不再等待。
      this.expireTurnDeadline(key);
      return;
    }
    // 是否需要分段：仅当剩余额度超过 Node 定时器上限时才可能被截断。
    // 未超限时到点即真正超时（不重算），避免在冻结/回拨时钟下 remaining 恒不变而无限重武装。
    const clamped = remainingMs > MAX_TIMER_DELAY_MS;
    const timer = setTimeout(() => {
      this.turnDeadlineTimer = null;
      if (this.currentKey !== key || this.taskState !== "streaming") return;
      if (!clamped) {
        this.expireTurnDeadline(key);
        return;
      }
      // 被截断过：到点后按当前剩余额度重新武装下一段（此时 remaining 已减小）。
      this.armTurnDeadline(key);
    }, clampTimerDelay(remainingMs));
    timer.unref?.();
    this.turnDeadlineTimer = timer;
  }

  /** deadline 到点（或收紧后已过期）时的统一处理：只中止仍属本 key 且仍 streaming 的任务。 */
  private expireTurnDeadline(key: string): void {
    if (this.currentKey !== key || this.taskState !== "streaming") return;
    this.turnDeadlineExceeded = true;
    void this.abortInternal(undefined, true).catch(() => {
      // 超时中止失败不阻断事件流（abort 内部已做超时/poison 处理）
    });
  }

  /** 只清 deadline timer（保留计时起点），供重武装使用。 */
  private clearTurnDeadlineTimer(): void {
    if (this.turnDeadlineTimer === null) return;
    clearTimeout(this.turnDeadlineTimer);
    this.turnDeadlineTimer = null;
  }

  /** 清除本 turn 的墙钟计时（timer + 起点；幂等）。settle / dispose / 新 turn 开始时调用。 */
  private clearTurnDeadline(): void {
    this.clearTurnDeadlineTimer();
    this.turnDeadlineStartedAt = null;
  }

  /** 后台启动流式任务，兜底捕获未处理拒绝（任务内部已 settle + finally 释放槽位）。 */
  private launchStreamingTask(task: PendingTask): void {
    void this.runStreamingTask(task).catch(() => {
      // 兜底：避免未处理 Promise 拒绝升级为进程级 unhandledRejection。
    });
  }

  /** 执行一个处于 streaming 的流式任务：先导航到历史节点（若指定 parentId），再跑 adapter.prompt。 */
  private async runStreamingTask(task: PendingTask): Promise<void> {
    // 任务取得所有权：重置本 turn 的工具错误/工具调用次数预算与墙钟 deadline
    // （在导航前，避免导航期间沿用上一任务的超限标志或残留 timer）。
    this.toolErrorCount = 0;
    this.toolErrorLimitReached = false;
    this.toolCallCount = 0;
    this.toolCallLimitReached = false;
    this.turnDeadlineExceeded = false;
    // 新 turn 必须先重置计时起点（clearTurnDeadline 同时清 timer 与起点），
    // 否则上一 turn 的残留起点会让本轮可用额度偏小。
    this.clearTurnDeadline();
    this.armTurnDeadline(task.key);
    try {
      if (task.parentId !== undefined) {
        await this.adapter.navigateTree(task.parentId);
        // 导航期间失去所有权（abort/dispose 已 settle 本任务）：直接退出，不再启动模型
        if (!this.ownsTask(task.key)) return;
      }
      if (!this.ownsTask(task.key)) return;
      this.turnStartTime = this.now();
      this.turnFirstTokenTime = null;
      await this.adapter.prompt(task.prompt, { images: task.images });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 只有仍是当前任务且未 settle 才结算（避免误结算后继任务）
      if (this.taskState === "streaming" && this.currentKey === task.key) {
        await this.settle("error", message, task.key);
      }
      return;
    }
    // 事件流自然结束：按最终 stopReason 判定（prompt resolve 是运行结束权威；失败不 reject，见 SDK agent-core）
    if (this.taskState === "streaming" && this.currentKey === task.key) {
      if (this.lastStopReason === "error") {
        await this.settle("error", this.lastErrorMessage ?? "模型调用失败", task.key);
      } else if (this.lastStopReason === "aborted") {
        await this.settle("aborted", undefined, task.key);
      } else if (this.lastStopReason === "length") {
        // maxTokens 截断：不完整回答，不应表现为成功
        await this.settle("error", "回答被 token 上限截断", task.key);
      } else {
        await this.settle("completed", undefined, task.key);
      }
    }
  }

  /** 排队任务出队接续执行（queue 时注册到 RESUME_REGISTRY，被任意 runtime 的 finish 唤醒）。 */
  private startQueuedTask(taskId: string): void {
    const task = this.pending.get(taskId);
    if (!task || this.taskState !== "queued") return;
    this.pending.delete(taskId);
    RESUME_REGISTRY.delete(taskId);
    EXPIRY_REGISTRY.delete(taskId);
    this.taskState = transition(this.taskState, "dequeue")!; // queued → streaming
    this.currentTaskId = taskId;
    this.currentKey = task.key;
    this.currentRequestId = task.requestId;
    this.currentFingerprint = task.fingerprint;
    // 清空上一任务的终态，避免旧 error/aborted 污染本任务
    this.lastStopReason = null;
    this.lastErrorMessage = null;
    this.turnStartTime = null;
    this.turnFirstTokenTime = null;
    // 出队即已占用并发槽位（concurrency.finish 的 drain 已把任务写入 active）
    this.launchStreamingTask(task);
  }

  /** 排队超时：释放占位、回 idle、合成 error 事件（由调度器触发）。 */
  private handleExpired(taskId: string): void {
    const task = this.pending.get(taskId);
    if (!task || this.taskState !== "queued") return;
    this.pending.delete(taskId);
    RESUME_REGISTRY.delete(taskId);
    EXPIRY_REGISTRY.delete(taskId);
    this.idempotency.fail(task.key);
    this.taskState = transition("queued", "abort")!; // → idle
    // 排队超时用**该排队任务自己的** requestId（而非当前/下一个任务）。
    this.emitEvent({ type: "error", message: "排队超时", requestId: task.requestId });
    this.observe({
      type: "queue_expired",
      sessionId: this.sessionId,
      requestId: task.requestId,
    });
  }

  /** 终态收尾：terminal→release 回 idle、幂等落账、合成 usage + 终态事件、释放槽位并接续排队任务。
   * taskKey 绑定：指定时不匹配当前任务则不结算，避免失权的旧任务误结算后继任务。 */
  private async settle(
    outcome: "completed" | "error" | "aborted",
    message?: string,
    taskKey?: string,
    code?: string,
  ): Promise<void> {
    if (taskKey !== undefined && this.currentKey !== taskKey) return;
    // 无论本 turn 以何种方式结束，都先清除墙钟 deadline timer（绝不泄漏）。
    this.clearTurnDeadline();
    if (this.taskState === "streaming") {
      const event: TaskEvent =
        outcome === "completed" ? "complete" : outcome === "error" ? "fail" : "abort";
      this.taskState = transition(this.taskState, event)!; // → terminal
    }
    // 注意：不在此时 release→idle；保持 terminal 直到 finally 释放槽位，
    // 避免统计期间新 submit 误判会话空闲导致同会话并发执行。

    const taskId = this.currentTaskId;
    const key = this.currentKey;
    const requestId = this.currentRequestId;
    const fingerprint = this.currentFingerprint;
    // 在清空 currentKey 前捕获本 key 专属的同步轮次文本/超限状态。
    const turnState = key !== null ? this.turnStates.get(key) : undefined;
    const turnText = turnState?.text ?? "";
    const turnOverflow = turnState?.overflow ?? false;
    this.currentTaskId = null;
    this.currentKey = null;
    this.currentRequestId = null;
    this.currentFingerprint = null;
    // 无论 extension 是否漏发 end，终态都释放锁，避免异常路径永久 409。
    this.failbackAttemptId = null;
    // 终态结果先用参数确定，保证即使后续 usage/事件异常也会在 finally 中结算等待者。
    // 预算优先级（固定，测试固定）：显式 code（由 abortInternal 在进入 streaming 分支时
    // **快照**，因此 abort 等待期间新置位的预算绝不会篡改本次 abort 的原因）> 助手文本
    // overflow（既有路径，不经 abort 快照）。abortInternal 内部的快照顺序为
    // 工具调用次数 > 墙钟 > 工具错误。
    const turnResult: SessionTurnResult =
      code !== undefined
        ? { status: "error", message: message ?? "任务失败", code }
        : turnOverflow
          ? { status: "error", message: "助手输出超过宿主上限", code: TURN_ERROR_CODES.assistantTextBudget }
          : outcome === "completed"
            ? { status: "completed", text: turnText }
            : outcome === "aborted"
              ? { status: "aborted" }
              : { status: "error", message: message ?? "任务失败" };

    try {
      // 读取 usage 并发送 timing 统计（仅当存在有效数据时才推送，避免测试/空跑时产生无意义事件）
      let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
      let durationMs = 0;
      let ttftMs = 0;
      if (this.turnStartTime !== null) {
        usage = await this.readUsageWithTimeout();
        durationMs = this.now() - this.turnStartTime;
        ttftMs = this.turnFirstTokenTime !== null ? this.turnFirstTokenTime - this.turnStartTime : durationMs;
        if (durationMs > 0 || usage !== null) {
          this.emitEvent({
            type: "usage",
            promptTokens: usage?.promptTokens ?? 0,
            completionTokens: usage?.completionTokens ?? 0,
            totalTokens: usage?.totalTokens ?? 0,
            durationMs,
            ttftMs,
            // requestId 已在清空 currentRequestId 之前捕获：终态系列永远归属本请求。
            requestId: requestId ?? undefined,
          });
        }
        // 观测埋点：调用耗时 + usage（脱敏，独立于 SSE 事件流）
        if (requestId) {
          this.observe({
            type: "turn",
            sessionId: this.sessionId,
            requestId,
            outcome,
            durationMs,
            ttftMs,
          });
          this.observe({
            type: "usage",
            sessionId: this.sessionId,
            requestId,
            promptTokens: usage?.promptTokens ?? 0,
            completionTokens: usage?.completionTokens ?? 0,
            totalTokens: usage?.totalTokens ?? 0,
          });
        }
      }
      this.turnStartTime = null;
      this.turnFirstTokenTime = null;

      if (outcome === "error" && requestId) {
        this.observe({
          type: "error",
          sessionId: this.sessionId,
          requestId,
          message: message ?? "任务失败",
        });
      }

      if (key !== null) {
        // 终态都落幂等账，重试同一 requestId 返回同一终态，不重复执行（needs.md §4.2）。
        // 只有「尚未产生副作用」的路径（reject/conflict/排队取消）才 fail 释放重试资格。
        // 幂等记录必须保存**已经算好的 turnResult 的可持久化形式**，而不是按 outcome 重新分支：
        // 助手文本 overflow 走的是 aborted outcome（abortInternal 触发）却要落 error+code，
        // 按 outcome 分支会把首次返回的 error+code 错记为 aborted，导致重放结果与首次不一致。
        const result: unknown =
          turnResult.status === "completed"
            ? { status: "completed" }
            : turnResult.status === "aborted"
              ? { status: "aborted" }
              : turnResult.code !== undefined
                ? { status: "error", message: turnResult.message, code: turnResult.code }
                : { status: "error", message: turnResult.message };
        this.idempotency.complete(key, result, fingerprint ?? undefined);
        // 持久化终态（fire-and-forget 但捕获拒绝），重启后重复 requestId 返回同一结果不重复执行
        if (this.idempotencyRepo && requestId) {
          void this.idempotencyRepo
            .put(this.sessionId, requestId, result)
            .catch(() => {
              // 持久化失败仅影响重启后的幂等去重，不阻塞当前响应；已在内存落账
            });
        }
      }

      // 终态事件使用清空 currentRequestId 之前捕获的 requestId，绝不归属后继请求。
      if (outcome === "completed") this.emitEvent({ type: "completed", requestId: requestId ?? undefined });
      else if (outcome === "error") {
        this.emitEvent({ type: "error", message: message ?? "任务失败", requestId: requestId ?? undefined });
      } else this.emitEvent({ type: "aborted", requestId: requestId ?? undefined });
    } finally {
      // 释放并发槽位必须在 finally：即使统计/事件/观测异常也不泄漏；
      // 返回的出队 taskId 依次接续执行（dequeue）
      if (taskId !== null) {
        this.continuePromoted(this.concurrency.finish(taskId));
      }
      // 槽位释放后才回 idle：期间会话保持 terminal，拒绝新任务，避免同会话并发
      if (this.taskState === "terminal") {
        this.taskState = transition("terminal", "release")!; // → idle
      }
      // 只结算该 key 的同步轮次等待者；其他请求的等待者不受影响。
      if (key !== null) this.resolveTurnWaiters(key, turnResult);
    }
  }

  /** 读取 usage，带超时兜底：getLastUsage 挂起时不影响槽位释放。 */
  private async readUsageWithTimeout(): Promise<{ promptTokens: number; completionTokens: number; totalTokens: number } | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.adapter.getLastUsage(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), USAGE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch {
      return null;
    } finally {
      // race 提前完成时清理 timer，避免高吞吐下累积无用定时器
      if (timer) clearTimeout(timer);
    }
  }

  private continuePromoted(promoted: readonly string[]): void {
    for (const id of promoted) {
      const resume = RESUME_REGISTRY.get(id);
      if (resume) resume(id);
    }
  }

  private firstPendingTaskId(): string | null {
    for (const id of this.pending.keys()) return id;
    return null;
  }

  private emitEvent(event: SseEvent): void {
    this.onEvent(event);
  }

  /** 观测推送（best-effort）：观测是非关键副作用，异常不得影响业务结果。 */
  private observe(event: ObservabilityEvent): void {
    try {
      this.observability?.observe(event);
    } catch {
      // 忽略观测异常，不得中断状态机/幂等/终态事件
    }
  }
}