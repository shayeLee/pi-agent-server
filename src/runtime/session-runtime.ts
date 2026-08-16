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
import type { IdempotencyRepository } from "../storage/idempotency-repository.js";

export type SubmitDecision =
  | { kind: "run" }
  | { kind: "queued"; position?: number }
  | { kind: "rejected"; reason: "user-queue-full" | "global-overload" }
  | { kind: "conflict"; reason?: "processing" | "active" | "poisoned" }
  | { kind: "done"; result: unknown };

export type ControlDecision = { kind: "ok" } | { kind: "conflict" };

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
  idempotencyRepo?: IdempotencyRepository;
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

export class SessionRuntime {
  readonly sessionId: string;
  readonly ownerKey: string;

  private readonly concurrency: ConcurrencyController;
  private readonly adapter: AgentAdapter;
  private readonly now: () => number;
  private readonly onEvent: (event: SseEvent) => void;
  private readonly idempotency = new IdempotencyStore();
  private readonly idempotencyRepo?: IdempotencyRepository;
  private readonly unsubscribe: () => void;
  private disposed = false;
  /** abort 超时/失败后标记：底层可能仍在运行，拒绝复用（避免旧事件混入新任务）。 */
  private poisoned = false;
  /** abort 进行中：adapter.abort() 等待期间到达的事件仍可见（abort 前的部分输出）。 */
  private aborting = false;
  /** 最近一次 agent_end 的最终 assistant stopReason（结果权威：stop/error/aborted/length/toolUse）。 */
  private lastStopReason: string | null = null;
  private lastErrorMessage: string | null = null;
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
  async submitMessage(input: {
    requestId: string;
    userId: string;
    prompt: string;
    parentId?: string;
    images?: ImageInput[];
  }): Promise<SubmitDecision> {
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
      // 流式后台执行，不阻塞提交决策（HTTP 立即返回，事件经 onEvent → SSE 推送）
      void this.runStreamingTask({
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
        this.settle("aborted");
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
    // status（agent_start/turn_start）附加当前 requestId，作为直跑路径的服务端确认信号
    if (translated.type === "status") {
      this.emitEvent({ ...translated, requestId: this.currentRequestId ?? undefined });
      return;
    }
    this.emitEvent(translated);
  }

  /** 任务所有权检查：未 dispose、仍在 streaming、且 key 仍是当前任务。 */
  private ownsTask(key: string): boolean {
    return !this.disposed && this.taskState === "streaming" && this.currentKey === key;
  }

  /** 执行一个处于 streaming 的流式任务：先导航到历史节点（若指定 parentId），再跑 adapter.prompt。 */
  private async runStreamingTask(task: PendingTask): Promise<void> {
    try {
      if (task.parentId !== undefined) {
        await this.adapter.navigateTree(task.parentId);
        // 导航期间失去所有权（abort/dispose 已 settle 本任务）：直接退出，不再启动模型
        if (!this.ownsTask(task.key)) return;
      }
      if (!this.ownsTask(task.key)) return;
      await this.adapter.prompt(task.prompt, { images: task.images });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 只有仍是当前任务且未 settle 才结算（避免误结算后继任务）
      if (this.taskState === "streaming" && this.currentKey === task.key) {
        this.settle("error", message, task.key);
      }
      return;
    }
    // 事件流自然结束：按最终 stopReason 判定（prompt resolve 是运行结束权威；失败不 reject，见 SDK agent-core）
    if (this.taskState === "streaming" && this.currentKey === task.key) {
      if (this.lastStopReason === "error") {
        this.settle("error", this.lastErrorMessage ?? "模型调用失败", task.key);
      } else if (this.lastStopReason === "aborted") {
        this.settle("aborted", undefined, task.key);
      } else if (this.lastStopReason === "length") {
        // maxTokens 截断：不完整回答，不应表现为成功
        this.settle("error", "回答被 token 上限截断", task.key);
      } else {
        this.settle("completed", undefined, task.key);
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
    // 出队即已占用并发槽位（concurrency.finish 的 drain 已把任务写入 active）
    void this.runStreamingTask(task);
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
  }

  /** 终态收尾：terminal→release 回 idle、幂等落账、合成终态事件、释放槽位并接续排队任务。
   * taskKey 绑定：指定时不匹配当前任务则不结算，避免失权的旧任务误结算后继任务。 */
  private settle(
    outcome: "completed" | "error" | "aborted",
    message?: string,
    taskKey?: string,
  ): void {
    if (taskKey !== undefined && this.currentKey !== taskKey) return;
    if (this.taskState === "streaming") {
      const event: TaskEvent =
        outcome === "completed" ? "complete" : outcome === "error" ? "fail" : "abort";
      this.taskState = transition(this.taskState, event)!; // → terminal
    }
    if (this.taskState === "terminal") {
      this.taskState = transition("terminal", "release")!; // → idle
    }

    const taskId = this.currentTaskId;
    const key = this.currentKey;
    const requestId = this.currentRequestId;
    this.currentTaskId = null;
    this.currentKey = null;
    this.currentRequestId = null;
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

    // 释放并发槽位；返回的出队 taskId 依次接续执行（dequeue）
    if (taskId !== null) {
      this.continuePromoted(this.concurrency.finish(taskId));
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
}