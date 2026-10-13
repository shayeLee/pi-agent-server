import { projectSubagents, type SubagentLive } from "./subagent-transcript.js";
// PiAgentAdapter：把真实 Pi SDK 的 AgentSession 适配为 AgentAdapter 接口（docs/pi-sdk-api.md §3）。
// 这是接入真实 SDK 的唯一位置；单元测试用 AgentSessionLike 结构（fake），不碰真实 SDK；
// 真实 AgentSession 的验证走独立的慢速集成测试（docs/architecture.md §3.2）。

import { AsyncLocalStorage } from "node:async_hooks";
import { ResidentControlQueue, type ResidentQueueAgent } from "./resident-control-queue.js";
import type { ControlQueueItem, ControlIdentity } from "../shared/control-queue.js";
import type { SteeringConsumed, SteeringIdentity, SteeringInput } from "../shared/steering.js";
import type { AgentAdapter, AgentConfigurationSnapshot, ImageInput, UsageInfo } from "./agent-adapter.js";
import { FAILBACK_LIFECYCLE_EVENT, isFailbackLifecycleEvent, type FailbackLifecycleSource } from "./failback-lifecycle.js";
import { FAILBACK_HOST_TRANSPORT_EVENT, isFailbackHostTransportHandshake, type FailbackHostTransport } from "./failback-host-transport.js";
import type { AgentSdkEvent } from "./events.js";
import { SUBAGENT_HOST_TRANSPORT_EVENT, isSubagentHostTransportHandshake, type SubagentHostTransport, type ExtensionCustomMessage } from "./subagent-host-transport.js";
import { notificationFromEntry } from "./subagent-notification.js";
import { ModelOutputSampler, type ModelOutputProgress } from "./model-output-sampler.js";
import { cacheHitPercent, nonnegative, responseSpeed, type LastResponseUsage, type UsageSnapshot, type UsageTokens } from "../core/usage-snapshot.js";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { ExecutionMetrics } from "./execution-metrics.js";
import { SessionStepsProjector } from "./session-steps-projector.js";
import { projectExportMessages, projectExportSnapshot } from "./session-export.js";
export { extractText, projectExportMessages, type ExportMessage, type ExportSnapshot, type ExportTimelineItem } from "./session-export.js";

/**
 * SDK PromptOptions.images 元素结构：`{ type:"image", data, mimeType }`。
 * 形状依据当前依赖 `@earendil-works/pi-ai` 的 `ImageContent`（`types.d.ts`）以及
 * `pi-coding-agent` 的 `agent-session.js`（prompt 直接把该对象 push 进 user content）与
 * JSONL 持久化结构（`{"type":"image","data":...,"mimeType":...}`）。
 * 这里本地定义，避免把 SDK 类型引入接口层（docs/architecture.md §2 类型隔离）。
 */
export type SdkImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

/** 真实 Pi SDK AgentSession 的最小结构（与方法签名对齐，便于 fake 测试与类型隔离）。 */
export type AgentSessionLike = {
  prompt(text: string, options?: { images?: SdkImageContent[] }): Promise<void>;
  readonly isStreaming?: boolean;
  sendCustomMessage?(message: ExtensionCustomMessage, options: { deliverAs: "followUp"; triggerTurn: true }): Promise<void>;
  steer(text: string, images?: SdkImageContent[]): Promise<unknown>;
  followUp(text: string, images?: SdkImageContent[]): Promise<unknown>;
  abort(): Promise<void>;
  clearQueue?(): { steering: string[]; followUp: string[] };
  readonly pendingMessageCount?: number;
  getSteeringMessages?(): readonly string[];
  getFollowUpMessages?(): readonly string[];
  agent?: { streamFunction: (...args: any[]) => any; steer?(message: any): void;
    followUp?(message: any): void;
    steeringMode?: "all" | "one-at-a-time"; followUpMode?: "all" | "one-at-a-time";
    peekQueuedMessages?(): object[]; clearSteeringQueue?(): void; clearFollowUpQueue?(): void;
    prepareNextTurn?: (...args: any[]) => any;
    prepareNextTurnWithContext?: (...args: any[]) => any;
    subscribe?(listener: (event: any) => void): () => void;
  };
  bindExtensions?(bindings: { mode: "json"; onError: (error: Error) => void }): Promise<void>;
  navigateTree(targetId: string): Promise<void>;
  subscribe(listener: (event: AgentSdkEvent) => void): () => void;
  dispose(): void;
  setModel(model: unknown): Promise<void>;
  setThinkingLevel(level: unknown): void;
  /** 会话消息列表（导出用；SDK 为 AgentMessage[]，此处用 unknown[] 保持类型隔离）。 */
  messages: unknown[];
  /** Public SDK getter; includes effective changes not yet sent to the model. */
  readonly systemPrompt?: string | null;
  getSessionStats?(): { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; cost: number };
  getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  /** SDK public session manager gives the active JSONL branch and its stable entry ids. */
  sessionManager?: Pick<SessionManager, "getBranch"> & Partial<Pick<SessionManager, "getEntries" | "appendCustomEntry" | "getLeafId">>;
  /** SDK 当前状态；恢复时 transcript 解析后的值在这里可见。 */
  model?: { provider?: string; id?: string };
  thinkingLevel?: string;
};

/** 按 provider + modelId 取模型（Model 结构隔离，避免 SDK 类型入接口）。 */
export type GetModel = (provider: string, modelId: string) => unknown;

export class PiAgentAdapter implements AgentAdapter {
  constructor(
    private readonly session: AgentSessionLike,
    private readonly getModel?: GetModel,
    private readonly failbackLifecycleSource?: FailbackLifecycleSource,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {
    this.stepsProjector = new SessionStepsProjector(() => session.sessionManager?.getBranch() ?? []);
    const manager = session.sessionManager;
    this.executionMetrics = new ExecutionMetrics(manager?.getEntries && manager.appendCustomEntry ? {
      getEntries: () => manager.getEntries!(),
      appendCustomEntry: (type, data) => manager.appendCustomEntry!(type, data),
    } : undefined);
    this.outputSampler = new ModelOutputSampler(monotonicNow, progress => {
      for (const listener of this.outputListeners) listener(progress);
    });
    this.baseStreamFunction = session.agent?.streamFunction;
    const agent = session.agent;
    const enqueue = agent?.steer;
    const followUp = agent?.followUp;
    if (agent && enqueue) {
      if (followUp && agent.peekQueuedMessages && agent.clearSteeringQueue && agent.clearFollowUpQueue &&
          agent.steeringMode && agent.followUpMode) {
        this.residentQueue = new ResidentControlQueue(agent as ResidentQueueAgent,
          message => enqueue.call(agent, message), message => followUp.call(agent, message),
          error => this.poisonResidentQueue(error));
        this.installPublicQueueBoundary();
      }
      const wrap = (original: (message: object) => void) => (message: object) => {
        if (this.disposed || this.queueFailure) return;
        const pending = this.steeringContext.getStore();
        const legacyToken = this.legacyQueueContext.getStore();
        if (legacyToken && (legacyToken !== this.requestAbort || legacyToken.signal.aborted || this.disposed || this.session.isStreaming === false)) return;
        if (pending) {
          // Input extensions may await past cancellation, abort or a newer run. Never enqueue late work.
          if (pending.token !== this.requestAbort || pending.token.signal.aborted || this.disposed || this.session.isStreaming === false ||
              this.withdrawnControls.has(this.controlKey(pending.identity))) return;
          if ((message as { role?: string }).role === "user") {
            this.steeringMessages.set(message, pending);
            this.residentQueue?.track(message, pending.identity);
          }
        }
        original.call(agent, message);
        this.reconcileControlQueue();
      };
      this.overridePublic(agent, "steer", { value: wrap(enqueue), writable: true });
      if (followUp) this.overridePublic(agent, "followUp", { value: wrap(followUp), writable: true });
      // Entry reconciliation precedes potentially long SDK preparation awaits. First/secondary
      // drains are reconciled at the earliest public core event boundary, not atomically at drain.
      for (const key of ["prepareNextTurn", "prepareNextTurnWithContext"] as const) {
        const original = agent[key];
        if (original) this.overridePublic(agent, key, { writable: true, value: (...args: any[]) => {
          this.reconcileControlQueue(); return original.apply(agent, args);
        } });
      }
      this.unsubscribeCoreQueue = agent.subscribe?.(event => {
        // SDK can drain steering after abort while finishing a tool. Stop before message_end
        // commits any damaged resident user message (including the inspection marker).
        if (this.queueFailure && event.type === "message_start" &&
            (event as { message?: { role?: string } }).message?.role === "user") throw this.queueFailure;
        if (["agent_start", "message_start", "turn_start", "turn_end", "agent_end"].includes(event.type)) this.reconcileControlQueue();
      }) ?? (() => {});
    }
    this.installFailbackHostTransport();
    const observeTranscript = failbackLifecycleSource?.on("agent-team:transcript", (data: any) => {
      if (!data || data.version !== 1 || typeof data.id !== "string") return;
      if (data.kind === "start") this.subagentLive.active.add(data.id);
      if (data.kind === "message") this.subagentLive.partials.delete(data.id);
      if (data.kind === "end") { this.subagentLive.active.delete(data.id); this.subagentLive.partials.delete(data.id); }
    });
    const observePartial = failbackLifecycleSource?.on("agent-team:transcript-live", (data: any) => {
      if (data && this.subagentLive.active.has(data.id)) this.subagentLive.partials.set(data.id, data);
    });
    this.unsubscribeTranscript = () => { observeTranscript?.(); observePartial?.(); this.subagentLive.active.clear(); this.subagentLive.partials.clear(); };
    this.unsubscribeHostIdentity = failbackLifecycleSource?.on("agent-team:host-identity", data => {
      if (typeof data === "object" && data !== null && "accept" in data &&
          typeof data.accept === "function") data.accept({ version: 1, host: "pi-agent-server" });
    }) ?? (() => {});
    this.unsubscribeSubagentTransport = failbackLifecycleSource?.on(SUBAGENT_HOST_TRANSPORT_EVENT, data => {
      if (isSubagentHostTransportHandshake(data)) data.accept({ post: payload => {
        if (this.disposed) return Promise.resolve({ accepted: false, reason: "disposed" });
        return this.subagentTransport?.post(payload) ?? Promise.resolve({ accepted: false, reason: "notready" });
      } });
    }) ?? (() => {});
    // One internal observer, regardless of how many host SSE subscribers exist.
    this.unsubscribeMeasurement = session.subscribe((event) => {
      if (!this.discard) {
        this.stepsProjector.observe(event);
        // Public message_end listeners run BEFORE SDK appendMessage. Flush at the next
        // event (before its host translation), or the microtask after persistence.
        const token = this.requestAbort;
        this.flushConsumedSteering(token);
        if (this.discard) return;
        if (event.type === "message_end") queueMicrotask(() => this.flushConsumedSteering(token));
        if (event.type === "message_start" && typeof event.message === "object" && event.message !== null &&
            (event.message as { role?: string }).role === "user") {
          const pending = this.steeringMessages.get(event.message);
          if (pending) {
            this.steeringMessages.delete(event.message);
            if (pending.token === token && !token.signal.aborted) {
              if (session.sessionManager) this.consumedSteering.set(event.message, pending);
              else {
                try { for (const listener of this.steeringListeners) listener(pending.identity); }
                catch (error) { this.failSteering(error, pending.identity, token); }
              }
            }
          }
        }
        if (this.executionActive) this.executionMetrics.observe(event);
        this.measureResponse(event);
        const progress = this.outputSampler.sample(event);
        if (progress) for (const listener of this.outputListeners) listener(progress);
      }
    });
  }

  /** abort 后置真：丢弃底层 run 的残余事件（如迟到的 agent_end），避免串扰下一次 prompt；prompt 开始恢复。 */
  private readonly stepsProjector: SessionStepsProjector;
  getSessionSteps(sessionId: string): import("../shared/session-steps.js").SessionStepsSnapshot {
    if (this.disposed) throw new Error("Adapter disposed");
    return this.stepsProjector.snapshot(sessionId);
  }
  private discard = false;
  private readonly executionMetrics: ExecutionMetrics;
  private executionActive = false;
  getExecutionSnapshot(): import("../core/usage-snapshot.js").ExecutionSnapshot { return this.executionMetrics.snapshot(); }
  private subagentTransport: SubagentHostTransport | undefined;
  private readonly unsubscribeSubagentTransport: () => void;
  private subagentLive: SubagentLive = { active: new Set(), partials: new Map() };
  private unsubscribeTranscript: () => void = () => {};
  private readonly unsubscribeHostIdentity: () => void;
  bindSubagentHostTransport(transport: SubagentHostTransport): () => void {
    this.subagentTransport = transport;
    return () => { if (this.subagentTransport === transport) this.subagentTransport = undefined; };
  }
  isSdkStreaming(): boolean { return this.session.isStreaming === true; }
  queueCustomFollowUp(message: ExtensionCustomMessage): Promise<void> {
    if (this.disposed || !this.requestAbort || this.requestAbort.signal.aborted || !this.isSdkStreaming()) {
      return Promise.reject(new Error("Custom follow-up no longer owned"));
    }
    if (!this.session.sendCustomMessage) return Promise.reject(new Error("Custom messages unavailable"));
    // No await between streaming check and SDK enqueue: sendCustomMessage queues synchronously.
    return this.session.sendCustomMessage(message, { deliverAs: "followUp", triggerTurn: true });
  }
  async promptCustom(message: ExtensionCustomMessage): Promise<void> {
    await this.runMeasuredPrompt(async () => {
      if (!this.session.sendCustomMessage) throw new Error("Custom messages unavailable");
      await this.session.sendCustomMessage(message, { deliverAs: "followUp", triggerTurn: true });
    });
  }
  /** No historical fallback: only messages appended during this prompt qualify. */
  private usageStart: number | null = null;
  private usageBoundary: unknown;
  private readonly unsubscribeMeasurement: () => void;
  private readonly outputSampler: ModelOutputSampler;
  private readonly outputListeners = new Set<(progress: ModelOutputProgress) => void>();
  subscribeModelOutputProgress(listener: (progress: ModelOutputProgress) => void): () => void {
    this.outputListeners.add(listener);
    return () => { this.outputListeners.delete(listener); };
  }
  private lastResponse: LastResponseUsage | null = null;
  private responseOrdinal = 0;
  private firstDeltaAt: number | null = null;
  private responseActive = false;
  private sawAssistantEvent = false;
  /** A request-local token survives post-run retry/continue and gates the actual SDK stream function. */
  private requestAbort: AbortController | null = null;
  private failbackAttempt: string | null = null;
  /** 永远只调用 SDK 原始函数；每轮不得再包装上一轮 gate。 */
  private readonly baseStreamFunction: ((...args: any[]) => any) | undefined;
  private readonly configurationListeners = new Set<(snapshot: AgentConfigurationSnapshot) => void>();

  private installFailbackHostTransport(): void {
    const source = this.failbackLifecycleSource as (FailbackLifecycleSource & { on?: (channel: string, handler: (data: unknown) => void) => () => void }) | undefined;
    source?.on?.(FAILBACK_HOST_TRANSPORT_EVENT, (data) => {
      if (!isFailbackHostTransportHandshake(data)) return;
      data.accept(this.hostTransport());
    });
  }

  private hostTransport(): FailbackHostTransport {
    return {
      begin: (attemptId) => {
        if (!this.requestAbort || this.requestAbort.signal.aborted || this.failbackAttempt !== null) return false;
        this.failbackAttempt = attemptId;
        return true;
      },
      cancelled: () => this.requestAbort === null || this.requestAbort.signal.aborted,
      enqueue: async (text) => {
        if (!this.failbackAttempt || !this.requestAbort || this.requestAbort.signal.aborted) return false;
        await this.session.steer(text);
        if (!this.failbackAttempt || !this.requestAbort || this.requestAbort.signal.aborted) {
          this.session.clearQueue?.();
          return false;
        }
        return true;
      },
      end: (attemptId) => {
        if (this.failbackAttempt === attemptId) this.failbackAttempt = null;
      },
    };
  }

  private installStreamGate(token: AbortController): void {
    const agent = this.session.agent;
    if (!agent) return;
    const base = this.baseStreamFunction;
    if (!base) return;
    agent.streamFunction = (...args: any[]) => {
      if (token.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const options = args[2] as { signal?: AbortSignal } | undefined;
      const signal = options?.signal ? AbortSignal.any([options.signal, token.signal]) : token.signal;
      return base(...args.slice(0, 2), { ...options, signal });
    };
  }

  async prompt(text: string, options?: { images?: ImageInput[] }): Promise<void> {
    await this.runMeasuredPrompt(async () => {
      if (options?.images === undefined || options.images.length === 0) {
        await this.session.prompt(text);
        return;
      }
      await this.session.prompt(text, {
        images: options.images.map((image): SdkImageContent => ({
          type: "image", data: image.base64, mimeType: image.mediaType,
        })),
      });
    });
  }

  private async runMeasuredPrompt(run: () => Promise<void>): Promise<void> {
    if (this.queueFailure) throw this.queueFailure;
    this.executionMetrics.begin();
    this.executionActive = true;
    this.clearResponseMeasurement();
    this.usageStart = this.session.messages.length;
    this.usageBoundary = this.session.messages[this.usageStart - 1];
    this.discard = false; // 新 run 开始：恢复事件传递
    this.failbackAttempt = null;
    this.consumedSteering.clear(); // Cancel work owned by a previous lifecycle, never retry it.
    const token = this.requestAbort = new AbortController();
    this.installStreamGate(token);
    try {
      await run();
    } finally {
      this.reconcileControlQueue();
      this.executionActive = false;
      this.executionMetrics.end();
      this.outputSampler.reset(); // prompt resolution/rejection cannot leave a trailing timer
    }
  }

  private queueFailure: Error | undefined;
  private poisonResidentQueue(error: Error): void {
    this.queueFailure = error; // permanent: a later prompt must never execute an unknown/marker queue
    this.requestAbort?.abort();
    this.discard = true;
    this.outputSampler.reset();
    // SDK abort synchronously signals the core before waiting for idle. Clear only after
    // poisoning: queue_update reentrancy must not inspect the damaged resident queues.
    void this.session.abort().catch(abortError => {
      this.queueFailure = new AggregateError([error, abortError], "Resident queue abort failed");
    });
    try { this.session.clearQueue?.(); }
    catch (clearError) { this.queueFailure = new AggregateError([error, clearError], "Resident queue clear failed"); }
  }
  private readonly publicQueueListeners = new Set<(event: AgentSdkEvent) => void>();
  private readonly publicQueueRestorers: (() => void)[] = [];
  private publicQueueSignature = "";
  private publicQueueDispatching = false;
  private publicQueueEvent(): AgentSdkEvent {
    if (this.queueFailure) throw this.queueFailure;
    const queues = this.residentQueue!.pendingMessages();
    const text = (message: object): string => {
      const content = (message as { content?: unknown }).content;
      return typeof content === "string" ? content : Array.isArray(content)
        ? content.filter(block => block.type === "text").map(block => block.text).join("") : "";
    };
    return { type: "queue_update", steering: queues.steer.map(text), followUp: queues.followUp.map(text) } as AgentSdkEvent;
  }
  private overridePublic(target: object, key: string, descriptor: PropertyDescriptor): void {
    const own = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
    const installed = Object.getOwnPropertyDescriptor(target, key)!;
    this.publicQueueRestorers.push(() => {
      const current = Object.getOwnPropertyDescriptor(target, key);
      // Late disposal must not clobber another owner's replacement.
      if (current?.get !== installed.get || current?.value !== installed.value) return;
      if (own) Object.defineProperty(target, key, own);
      else Reflect.deleteProperty(target, key);
    });
  }
  private installPublicQueueBoundary(): void {
    // Instance-only public overrides. Preserve own descriptors exactly; never touch SDK prototypes.
    const install = (key: string, descriptor: PropertyDescriptor): void => this.overridePublic(this.session, key, descriptor);
    install("pendingMessageCount", { get: () => {
      if (this.queueFailure) throw this.queueFailure;
      const queues = this.residentQueue!.pendingMessages();
      return queues.steer.length + queues.followUp.length;
    } });
    install("getSteeringMessages", { value: () => (this.publicQueueEvent() as any).steering, writable: true });
    install("getFollowUpMessages", { value: () => (this.publicQueueEvent() as any).followUp, writable: true });
    const subscribe = this.session.subscribe;
    install("subscribe", { writable: true, value: (listener: (event: AgentSdkEvent) => void) => {
      this.publicQueueListeners.add(listener);
      const unsubscribe = subscribe.call(this.session, event => {
        // SDK emits BEFORE core enqueue, and its text mirrors can remain stale after edits.
        // Suppress that speculative event; emit authoritative updates at core boundaries instead.
        if (event.type === "queue_update") this.emitPublicQueue();
        else listener(event);
      });
      return () => { this.publicQueueListeners.delete(listener); unsubscribe(); };
    } });
  }
  private emitPublicQueue(): void {
    if (!this.residentQueue || this.disposed || this.queueFailure || this.publicQueueDispatching) return;
    this.publicQueueDispatching = true;
    try {
      // Reentrant mutations must not broadcast ahead of the remaining listeners.
      // Re-read after each pass, converging on authority without repeating unchanged updates.
      while (!this.disposed && !this.queueFailure) {
        const event = this.publicQueueEvent();
        const signature = JSON.stringify(event);
        if (signature === this.publicQueueSignature) break;
        this.publicQueueSignature = signature;
        for (const listener of this.publicQueueListeners) listener(event);
      }
    } finally {
      this.publicQueueDispatching = false;
    }
  }
  private restorePublicQueueBoundary(): void {
    for (const restore of this.publicQueueRestorers.splice(0).reverse()) restore();
    this.publicQueueListeners.clear();
  }

  private residentQueue: ResidentControlQueue | undefined;
  private unsubscribeCoreQueue: () => void = () => {};
  private readonly queueListeners = new Set<() => void>();
  private readonly withdrawnControls = new Set<string>();
  private readonly pendingControls = new Set<string>();
  private pendingLegacyInputs = 0;
  private queueSignature = "[]";
  private controlKey(identity: ControlIdentity): string { return JSON.stringify([identity.requestId, identity.controlId, identity.acknowledgementId]); }
  getControlQueueItems(): ControlQueueItem[] {
    if (this.queueFailure) throw this.queueFailure;
    return this.residentQueue?.snapshot() ?? [];
  }
  subscribeControlQueue(listener: () => void): () => void {
    this.queueListeners.add(listener); return () => { this.queueListeners.delete(listener); };
  }
  private reconcileControlQueue(): void {
    if (this.disposed || this.queueFailure) return;
    const signature = JSON.stringify(this.getControlQueueItems());
    this.emitPublicQueue();
    if (signature === this.queueSignature) return;
    this.queueSignature = signature;
    for (const listener of this.queueListeners) listener();
  }
  mutateControlQueue(identity: ControlIdentity, operation: "delete" | "promote"): boolean {
    if (this.queueFailure) throw this.queueFailure;
    const key = this.controlKey(identity);
    const changed = this.residentQueue?.mutate(identity, operation) ?? false;
    if (!changed && !(operation === "delete" && this.pendingControls.has(key))) return false;
    if (operation === "delete") this.withdrawnControls.add(key);
    this.reconcileControlQueue();
    return true;
  }

  private readonly legacyQueueContext = new AsyncLocalStorage<AbortController>();
  private readonly steeringContext = new AsyncLocalStorage<{ identity: SteeringIdentity; token: AbortController }>();
  private readonly steeringMessages = new WeakMap<object, { identity: SteeringIdentity; token: AbortController }>();
  private readonly consumedSteering = new Map<object, { identity: SteeringIdentity; token: AbortController }>();
  private readonly requestErrorListeners = new Set<(error: Error, requestId: string) => void>();
  subscribeRequestError(listener: (error: Error, requestId: string) => void): () => void {
    this.requestErrorListeners.add(listener);
    return () => { this.requestErrorListeners.delete(listener); };
  }

  private failSteering(error: unknown, identity: SteeringIdentity, token: AbortController): void {
    if (this.disposed || token !== this.requestAbort || token.signal.aborted) return;
    token.abort(); // Revoke the captured run before any error subscriber can reenter.
    this.discard = true;
    this.outputSampler.reset();
    try { this.session.clearQueue?.(); } catch { /* Already revoked; runtime remains poisoned. */ }
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const listener of this.requestErrorListeners) {
      try { listener(failure, identity.requestId); } catch { /* Error reporting must not recursively throw. */ }
    }
  }
  private readonly steeringListeners = new Set<(identity: SteeringConsumed) => void>();
  private flushConsumedSteering(token: AbortController | null): void {
    if (this.disposed || this.discard || !token || token !== this.requestAbort || token.signal.aborted || !this.consumedSteering.size) return;
    for (const [message, pending] of this.consumedSteering) {
      if (pending.token !== token) continue;
      const { identity } = pending;
      try {
        const branch = this.session.sessionManager?.getBranch() ?? [];
        const entry = branch.find(entry => entry.type === "message" && entry.message === message);
        if (!entry || entry.type !== "message") continue;
        const projected = projectExportMessages([], [entry])[0];
        if (!projected || projected.role !== "user") continue;
        // Metadata only, after the actual user entry; no second prompt/message.
        const manager = this.session.sessionManager;
        if (!manager?.appendCustomEntry) throw new Error("Steering consumption persistence unavailable");
        manager.appendCustomEntry("pi-agent-server.steering-consumed",
          { version: 1, ...identity, sourceId: entry.id });
        this.consumedSteering.delete(message); // Never acknowledge a failed durable append.
        const consumed: SteeringConsumed = { ...identity, message: { sourceId: entry.id,
          text: projected.text, ...(projected.images ? { images: projected.images } : {}) } };
        for (const listener of this.steeringListeners) listener(consumed);
      } catch (error) {
        this.failSteering(error, identity, token);
        return; // No retry/requeue: the user message may already be model-visible and durable.
      }
    }
  }
  subscribeSteeringConsumed(listener: (identity: SteeringConsumed) => void): () => void {
    this.steeringListeners.add(listener);
    return () => { this.steeringListeners.delete(listener); };
  }

  async steer(text: string, input?: SteeringInput): Promise<void> {
    if (!input) { await this.enqueueLegacy("steer", text); return; }
    // Async-local context survives input extension awaits and isolates concurrent equal-text submissions.
    const token = this.requestAbort;
    if (!token || token.signal.aborted || this.disposed) throw new Error("Steering request no longer owned");
    await this.enqueueCorrelated("steer", text, input, token);
  }

  private async enqueueCorrelated(kind: "steer" | "followUp", text: string, input: SteeringInput, token: AbortController): Promise<void> {
    const identity = { controlId: input.controlId, acknowledgementId: input.acknowledgementId, requestId: input.requestId };
    const key = this.controlKey(identity);
    this.pendingControls.add(key);
    try {
      await this.steeringContext.run({ identity, token }, () => this.session[kind](text,
        input.images?.map(image => ({ type: "image", data: image.base64, mimeType: image.mediaType }))));
    } finally {
      this.pendingControls.delete(key);
      if (this.disposed) {
        // An awaited input extension may append the SDK text mirror after dispose.
        // Core enqueue remains fenced; clear the disposed session before restoring descriptors.
        this.session.clearQueue?.();
        if (!this.pendingControls.size && !this.pendingLegacyInputs) this.restorePublicQueueBoundary();
      } else this.reconcileControlQueue();
    }
  }

  private async enqueueLegacy(kind: "steer" | "followUp", text: string): Promise<void> {
    if (this.disposed) throw new Error("Adapter disposed");
    if (this.queueFailure) throw this.queueFailure;
    const token = this.requestAbort;
    this.pendingLegacyInputs++;
    try {
      if (token) await this.legacyQueueContext.run(token, () => this.session[kind](text));
      else await this.session[kind](text);
    } finally {
      this.pendingLegacyInputs--;
      if (this.disposed) {
        this.session.clearQueue?.();
        if (!this.pendingControls.size && !this.pendingLegacyInputs) this.restorePublicQueueBoundary();
      }
    }
  }

  async followUp(text: string, input?: SteeringInput): Promise<void> {
    if (!input) { await this.enqueueLegacy("followUp", text); return; }
    const token = this.requestAbort;
    if (!token || token.signal.aborted || this.disposed) throw new Error("Follow-up request no longer owned");
    await this.enqueueCorrelated("followUp", text, input, token);
  }

  async abort(): Promise<void> {
    // The order is intentional: synchronously revoke this request and discard queued continuation
    // before the SDK observes abort; finally repeats clearQueue for queue_update reentrancy.
    this.outputSampler.reset();
    const token = this.requestAbort;
    token?.abort();
    this.session.clearQueue?.();
    this.reconcileControlQueue();
    try {
      await this.session.abort();
      if (this.requestAbort === token) this.discard = true; // Only discard the captured lifecycle.
    } finally {
      if (this.requestAbort === token) {
        this.outputSampler.reset();
        this.session.clearQueue?.();
        this.reconcileControlQueue();
        this.failbackAttempt = null;
      }
    }
  }

  async navigateTree(targetId: string): Promise<void> {
    this.clearResponseMeasurement();
    this.usageStart = null;
    await this.session.navigateTree(targetId);
    this.stepsProjector.reset();
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const model = this.getModel?.(provider, modelId);
    if (!model) throw new Error(`模型不可用：${provider}/${modelId}`);
    await this.session.setModel(model);
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.session.setThinkingLevel(level);
  }

  private disposed = false;

  subscribeNotifications(listener: (event: import("./subagent-notification.js").NotificationEvent) => void): () => void {
    return this.session.subscribe((event) => {
      if (this.disposed) return;
      const raw = event as unknown as { type: string; entry?: unknown };
      if (raw.type !== "entry_appended") return;
      const notification = notificationFromEntry(raw.entry);
      if (notification) listener(notification);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stepsProjector.dispose();
    this.subagentTransport = undefined;
    this.unsubscribeSubagentTransport();
    this.unsubscribeHostIdentity();
    this.unsubscribeTranscript();
    this.requestAbort?.abort();
    this.session.clearQueue?.();
    this.unsubscribeMeasurement();
    this.unsubscribeCoreQueue();
    this.queueListeners.clear();
    this.outputListeners.clear();
    this.steeringListeners.clear();
    this.requestErrorListeners.clear();
    this.consumedSteering.clear();
    this.clearResponseMeasurement();
    this.session.dispose();
    if (!this.pendingControls.size && !this.pendingLegacyInputs) this.restorePublicQueueBoundary();
  }

  subscribe(listener: (event: AgentSdkEvent) => void): () => void {
    return this.session.subscribe((event) => {
      if (this.discard) return; // 丢弃 abort 后的残余事件，避免串扰下一次 prompt
      listener(event);
      // Pi.setModel()/setThinkingLevel() append JSONL entries and then emit entry_appended.
      // Read the session state rather than trusting entry payload so extension and SDK versions share one shape.
      const eventType = (event as { type: string }).type;
      if (eventType === "entry_appended" || eventType === "thinking_level_changed") this.emitConfigurationSnapshot();
    });
  }

  getConfigurationSnapshot(): AgentConfigurationSnapshot {
    const model = this.session.model;
    return {
      modelProvider: typeof model?.provider === "string" ? model.provider : null,
      modelId: typeof model?.id === "string" ? model.id : null,
      thinkingLevel: typeof this.session.thinkingLevel === "string" ? this.session.thinkingLevel : null,
    };
  }

  subscribeConfigurationSnapshot(listener: (snapshot: AgentConfigurationSnapshot) => void): () => void {
    this.configurationListeners.add(listener);
    return () => this.configurationListeners.delete(listener);
  }

  private emitConfigurationSnapshot(): void {
    const snapshot = this.getConfigurationSnapshot();
    for (const listener of this.configurationListeners) listener(snapshot);
  }

  subscribeFailbackLifecycle(listener: (event: import("./failback-lifecycle.js").FailbackLifecycleEvent) => void): () => void {
    if (!this.failbackLifecycleSource) return () => {};
    return this.failbackLifecycleSource.on(FAILBACK_LIFECYCLE_EVENT, (data) => {
      if (!isFailbackLifecycleEvent(data)) return;
      listener(data);
      // The original extension emits end only after pi.setModel and continuation acknowledgement.
      if (data.phase === "end" && data.outcome === "switched") this.emitConfigurationSnapshot();
    });
  }

  private clearResponseMeasurement(): void {
    this.outputSampler.reset();
    this.lastResponse = null;
    this.responseOrdinal = 0;
    this.firstDeltaAt = null;
    this.responseActive = false;
    this.sawAssistantEvent = false;
  }

  private measureResponse(event: AgentSdkEvent): void {
    if (this.usageStart === null) return;
    if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") return;
    const message = event.message as { role?: string; usage?: Usage } | undefined;
    if (message?.role !== "assistant") return;
    this.sawAssistantEvent = true;
    if (event.type === "message_start") {
      this.responseOrdinal++;
      this.responseActive = true;
      this.firstDeltaAt = null;
      this.lastResponse = null;
    } else if (event.type === "message_update" && this.responseActive) {
      const delta = event.assistantMessageEvent;
      if ((delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "toolcall_delta") && delta.delta.length > 0 && this.firstDeltaAt === null) {
        this.firstDeltaAt = this.monotonicNow();
      }
    } else if (event.type === "message_end") {
      const duration = this.responseActive && this.firstDeltaAt !== null
        ? nonnegative(this.monotonicNow() - this.firstDeltaAt) : null;
      this.lastResponse = this.projectResponse(message.usage, this.responseOrdinal || null, duration);
      this.responseActive = false;
      this.firstDeltaAt = null;
    }
  }

  private projectTokens(usage: Partial<Usage> | undefined): UsageTokens {
    return {
      input: nonnegative(usage?.input), output: nonnegative(usage?.output),
      cacheRead: nonnegative(usage?.cacheRead), cacheWrite: nonnegative(usage?.cacheWrite),
      totalTokens: nonnegative(usage?.totalTokens), costUsdEstimate: nonnegative(usage?.cost?.total),
    };
  }

  private projectResponse(usage: Usage | undefined, ordinal: number | null, duration: number | null): LastResponseUsage {
    const tokens = this.projectTokens(usage);
    return { ...tokens, ordinal, cacheHitPercent: cacheHitPercent(tokens.input, tokens.cacheRead, tokens.cacheWrite),
      speed: responseSpeed(tokens.output, duration) };
  }

  async getUsageSnapshot(): Promise<UsageSnapshot> {
    // No caching: navigation, compaction and model changes must never reuse old context.
    let sessionTotals: UsageSnapshot["sessionTotals"] = null;
    let context: UsageSnapshot["context"] = null;
    try {
      const stats = this.session.getSessionStats?.();
      if (stats) sessionTotals = { scope: "allEntries", input: nonnegative(stats.tokens.input),
        output: nonnegative(stats.tokens.output), cacheRead: nonnegative(stats.tokens.cacheRead),
        cacheWrite: nonnegative(stats.tokens.cacheWrite), totalTokens: nonnegative(stats.tokens.total),
        costUsdEstimate: nonnegative(stats.cost) };
    } catch { /* unavailable is unknown, not zero */ }
    try {
      const usage = this.session.getContextUsage?.();
      if (usage) {
        const window = nonnegative(usage.contextWindow);
        context = { tokens: nonnegative(usage.tokens), window: window !== null && window > 0 ? window : null,
          percent: window !== null && window > 0 && nonnegative(usage.tokens) !== null ? nonnegative(usage.percent) : null,
          estimate: true };
      }
    } catch { /* unavailable is unknown */ }
    let lastResponse = this.lastResponse;
    if (!this.sawAssistantEvent) {
      const message = this.latestPromptAssistant();
      if (message) lastResponse = this.projectResponse(message.usage, null, null);
    }
    return { lastResponse, sessionTotals, context, execution: this.getExecutionSnapshot() };
  }

  private latestPromptAssistant(): { usage?: Usage } | null {
    if (this.usageStart === null) return null;
    const messages = this.session.messages as Array<{ role?: string; usage?: Usage }>;
    if (this.usageStart > 0 && messages[this.usageStart - 1] !== this.usageBoundary) return null;
    for (let i = messages.length - 1; i >= this.usageStart; i--) {
      if (messages[i]?.role === "assistant") return messages[i]!;
    }
    return null;
  }

  async getLastUsage(): Promise<UsageInfo | null> {
    if (this.sawAssistantEvent) {
      const response = this.lastResponse;
      return response && response.input !== null && response.output !== null && response.totalTokens !== null
        ? { promptTokens: response.input, completionTokens: response.output, totalTokens: response.totalTokens } : null;
    }
    if (this.usageStart === null) return null;
    const messages = this.session.messages as Array<{ role?: string; usage?: Usage }>;
    // Compaction/navigation may replace the prefix. Never treat a shifted historical message as current.
    if (this.usageStart > 0 && messages[this.usageStart - 1] !== this.usageBoundary) return null;
    for (let i = messages.length - 1; i >= this.usageStart; i--) {
      const m = messages[i];
      if (m?.role !== "assistant") continue;
      // A missing/invalid latest measurement is unknown, not an earlier assistant's usage.
      const usage = m.usage;
      if (!usage || ![usage.input, usage.output, usage.totalTokens].every(
        (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
      )) return null;
      return { promptTokens: usage.input, completionTokens: usage.output, totalTokens: usage.totalTokens };
    }
    return null;
  }

  /** Additive snapshot: legacy messages plus stable, block-ordered tool timeline. */
  getEffectiveSystemPrompt(): string | null {
    return this.session.systemPrompt ?? null;
  }

  private subagentBranch?: { leaf: string | null; entries: import("@earendil-works/pi-coding-agent").SessionEntry[] };
  getSubagents(sessionId: string, runId?: string) {
    const manager = this.session.sessionManager;
    const leaf = manager?.getLeafId?.();
    if (leaf === undefined || this.subagentBranch?.leaf !== leaf) {
      this.subagentBranch = { leaf: leaf ?? null, entries: (manager?.getBranch() ?? []).filter(e =>
        (e.type === "custom" && e.customType === "agent-team:transcript") ||
        (e.type === "message" && e.message.role === "toolResult" && ["subagent", "subagent_wait"].includes(e.message.toolName))) };
    }
    return projectSubagents(sessionId, this.subagentBranch?.entries ?? [], this.subagentLive, runId);
  }

  async exportSession(): Promise<unknown> {
    return { ...projectExportSnapshot(this.session.messages, this.session.sessionManager?.getBranch() ?? []),
      usageSnapshot: await this.getUsageSnapshot() };
  }
}
