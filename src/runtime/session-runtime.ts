// SessionRuntime：把状态机 / 并发控制 / 幂等 / Agent 适配器串成会话任务生命周期（README §4.2、docs/architecture.md §1 数据流 ④⑤⑥⑦⑧）。
// - 外部依赖全部注入（ConcurrencyController / AgentAdapter / now / onEvent），单元测试一律用 MockAgentAdapter，不碰真实 Pi SDK。
// - SDK 事件经 translateSdkEvent 翻译后输出；queued / completed / aborted / error 由本编排层合成。
// - 返回决策为判别联合类型（run / queued / rejected / conflict / done；控制接口 ok / conflict）。

import { transition, type TaskState, type TaskEvent } from "../core/task-state-machine.js";
import type { ConcurrencyController } from "../core/concurrency-control.js";
import { IdempotencyStore } from "../core/idempotency.js";
import type { AgentAdapter, ImageInput } from "../agent/agent-adapter.js";
import type { AgentSdkEvent, SseEvent } from "../agent/events.js";
import { translateSdkEvent } from "../agent/translate.js";
import { extractFinalStop } from "../agent/events.js";
import type {
  IdempotencyStorePort,
  ManagedSessionRuntimePort,
  ObservabilityEvent,
  ObservabilityPort,
  SubmitDecision,
  ControlDecision,
  SubmitInput,
} from "../application/ports/index.js";

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
  private disposed = false;
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
  /** 同 requestId 的并发提交去重：共享同一 in-flight promise（避免 processing 占位与状态机竞态）。 */
  private readonly inFlightSubmits = new Map<string, Promise<SubmitDecision>>();

  private taskState: TaskState = "idle";
  private currentTaskId: string | null = null;
  private currentKey: string | null = null;
  private currentRequestId: string | null = null;
  private readonly pending = new Map<string, PendingTask>();

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
  }

  /** 释放资源：退订事件 + 释放并发槽位/清理排队 + dispose 底层 adapter（幂等，重复调用安全）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    // 释放 active 任务占用的并发槽位（触发 drain 接续其他会话）；不依赖调用方先 abort
    if (this.currentTaskId !== null) {
      this.continuePromoted(this.concurrency.finish(this.currentTaskId));
      this.currentTaskId = null;
    }
    this.currentKey = null;
    this.currentRequestId = null;
    // 清理排队任务：取消占位、释放幂等重试资格、清注册表
    for (const [taskId, task] of this.pending) {
      this.idempotency.fail(task.key);
      this.concurrency.cancelQueued(taskId);
      RESUME_REGISTRY.delete(taskId);
      EXPIRY_REGISTRY.delete(taskId);
    }
    this.pending.clear();
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
    // 同 requestId 并发提交：共享同一 in-flight promise，得到相同结果（不重复执行、无占位竞态）
    const inFlight = this.inFlightSubmits.get(key);
    if (inFlight) return inFlight;
    const promise = this.doSubmit(input);
    this.inFlightSubmits.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlightSubmits.delete(key);
    }
  }

  private async doSubmit(input: {
    requestId: string;
    userId: string;
    prompt: string;
    parentId?: string;
    images?: ImageInput[];
  }): Promise<SubmitDecision> {
    const key = `${this.sessionId}:${input.requestId}`;
    const idem = this.idempotency.check(key);
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
          this.idempotency.complete(key, persisted);
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

  /** POST /v1/sessions/:id/abort：queued 取消排队；streaming 中止并释放槽位；其余 409。 */
  async abort(): Promise<ControlDecision> {
    if (this.disposed) throw new SessionDeletedError(this.sessionId);
    if (this.taskState === "queued") {
      const taskId = this.firstPendingTaskId();
      if (taskId !== null) {
        const canceled = this.concurrency.cancelQueued(taskId);
        if (!canceled) {
          // 已被其他会话 finish 出队（转 active）但尚未开始执行：归还槽位并接续其他排队任务
          this.continuePromoted(this.concurrency.finish(taskId));
        }
        const task = this.pending.get(taskId);
        if (task) this.idempotency.fail(task.key);
        this.pending.delete(taskId);
        RESUME_REGISTRY.delete(taskId);
        EXPIRY_REGISTRY.delete(taskId);
      }
      this.taskState = transition("queued", "abort")!; // → idle
      this.emitEvent({ type: "aborted" });
      return { kind: "ok" };
    }
    if (this.taskState === "streaming") {
      this.taskState = transition("streaming", "abort")!; // → terminal
      this.aborting = true;
      // 快照 abort 原因：避免 abort 等待期间新到达的工具错误事件改变共享标志，导致用户 abort 被误判为预算超限
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
        // 工具错误预算触发的 abort 结算为 error（而非用户 abort），保留超限语义
        this.settle(dueToToolBudget ? "error" : "aborted", dueToToolBudget ? "连续工具调用失败次数超限" : undefined).catch(() => {
          // settle 异步失败不影响 abort 控制语义
        });
      }
      return { kind: "ok" };
    }
    return { kind: "conflict" };
  }

  // --- 内部实现 ---

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
    // 工具错误预算：tool_end isError 计数，超限中止，避免模型无限循环请求失败/未授权工具
    let budgetAbort = false;
    if (translated.type === "tool_end" && translated.isError) {
      this.toolErrorCount++;
      if (this.toolErrorCount > MAX_TOOL_ERRORS_PER_TURN && !this.toolErrorLimitReached) {
        this.toolErrorLimitReached = true;
        budgetAbort = true;
      }
    }
    // 首个 text_delta 计算 TTFT
    if (translated.type === "text_delta" || translated.type === "thinking_delta") {
      if (this.turnStartTime !== null && this.turnFirstTokenTime === null) {
        this.turnFirstTokenTime = this.now();
      }
    }
    // status（agent_start/turn_start）附加当前 requestId，作为直跑路径的服务端确认信号
    if (translated.type === "status") {
      this.emitEvent({ ...translated, requestId: this.currentRequestId ?? undefined });
    } else {
      this.emitEvent(translated);
    }
    // 当前事件先发出再调度自动中止：避免 abort 同步触发的事件在本次 tool_end 之前进入 SSE（顺序倒置）
    if (budgetAbort) {
      void this.abort().catch(() => {
        // 预算中止失败不阻断事件流（abort 内部已做超时/poison 处理）
      });
    }
  }

  /** 任务所有权检查：未 dispose、仍在 streaming、且 key 仍是当前任务。 */
  private ownsTask(key: string): boolean {
    return !this.disposed && this.taskState === "streaming" && this.currentKey === key;
  }

  /** 后台启动流式任务，兜底捕获未处理拒绝（任务内部已 settle + finally 释放槽位）。 */
  private launchStreamingTask(task: PendingTask): void {
    void this.runStreamingTask(task).catch(() => {
      // 兜底：避免未处理 Promise 拒绝升级为进程级 unhandledRejection。
    });
  }

  /** 执行一个处于 streaming 的流式任务：先导航到历史节点（若指定 parentId），再跑 adapter.prompt。 */
  private async runStreamingTask(task: PendingTask): Promise<void> {
    // 任务取得所有权：重置本 turn 的工具错误预算（在导航前，避免导航期间沿用上一任务的超限标志）
    this.toolErrorCount = 0;
    this.toolErrorLimitReached = false;
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
    this.emitEvent({ type: "error", message: "排队超时" });
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
  ): Promise<void> {
    if (taskKey !== undefined && this.currentKey !== taskKey) return;
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
    this.currentTaskId = null;
    this.currentKey = null;
    this.currentRequestId = null;

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
        // 终态都落幂等账，重试同一 requestId 返回同一终态，不重复执行（README §4.2）。
        // 只有「尚未产生副作用」的路径（reject/conflict/排队取消）才 fail 释放重试资格。
        let result: unknown;
        if (outcome === "completed") {
          result = { status: "completed" };
        } else if (outcome === "aborted") {
          result = { status: "aborted" };
        } else {
          result = { status: "error", message: message ?? "任务失败" };
        }
        this.idempotency.complete(key, result);
        // 持久化终态（fire-and-forget 但捕获拒绝），重启后重复 requestId 返回同一结果不重复执行
        if (this.idempotencyRepo && requestId) {
          void this.idempotencyRepo
            .put(this.sessionId, requestId, result)
            .catch(() => {
              // 持久化失败仅影响重启后的幂等去重，不阻塞当前响应；已在内存落账
            });
        }
      }

      if (outcome === "completed") this.emitEvent({ type: "completed" });
      else if (outcome === "error") this.emitEvent({ type: "error", message: message ?? "任务失败" });
      else this.emitEvent({ type: "aborted" });
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