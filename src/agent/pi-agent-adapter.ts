// PiAgentAdapter：把真实 Pi SDK 的 AgentSession 适配为 AgentAdapter 接口（docs/pi-sdk-api.md §3）。
// 这是接入真实 SDK 的唯一位置；单元测试用 AgentSessionLike 结构（fake），不碰真实 SDK；
// 真实 AgentSession 的验证走独立的慢速集成测试（docs/architecture.md §3.2）。

import type { AgentAdapter, AgentConfigurationSnapshot, ImageInput, UsageInfo } from "./agent-adapter.js";
import { FAILBACK_LIFECYCLE_EVENT, isFailbackLifecycleEvent, type FailbackLifecycleSource } from "./failback-lifecycle.js";
import { FAILBACK_HOST_TRANSPORT_EVENT, isFailbackHostTransportHandshake, type FailbackHostTransport } from "./failback-host-transport.js";
import type { AgentSdkEvent } from "./events.js";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { projectExportSnapshot } from "./session-export.js";
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
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  clearQueue?(): { steering: string[]; followUp: string[] };
  agent?: { streamFunction: (...args: any[]) => any };
  bindExtensions?(bindings: { mode: "json"; onError: (error: Error) => void }): Promise<void>;
  navigateTree(targetId: string): Promise<void>;
  subscribe(listener: (event: AgentSdkEvent) => void): () => void;
  dispose(): void;
  setModel(model: unknown): Promise<void>;
  setThinkingLevel(level: unknown): void;
  /** 会话消息列表（导出用；SDK 为 AgentMessage[]，此处用 unknown[] 保持类型隔离）。 */
  messages: unknown[];
  /** SDK public session manager gives the active JSONL branch and its stable entry ids. */
  sessionManager?: Pick<SessionManager, "getBranch">;
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
  ) {
    this.baseStreamFunction = session.agent?.streamFunction;
    this.installFailbackHostTransport();
  }

  /** abort 后置真：丢弃底层 run 的残余事件（如迟到的 agent_end），避免串扰下一次 prompt；prompt 开始恢复。 */
  private discard = false;
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
    this.discard = false; // 新 run 开始：恢复事件传递
    this.failbackAttempt = null;
    const token = this.requestAbort = new AbortController();
    this.installStreamGate(token);
    if (options?.images === undefined || options.images.length === 0) {
      await this.session.prompt(text);
      return;
    }
    // ImageInput（接口层轻量结构）→ SDK ImageContent（base64），只在适配层转换；
    // data 逐字节透传（不重新编码），保证客户端提交的图片内容原样进入 SDK。
    await this.session.prompt(text, {
      images: options.images.map((image): SdkImageContent => ({
        type: "image",
        data: image.base64,
        mimeType: image.mediaType,
      })),
    });
  }

  async steer(text: string): Promise<void> {
    await this.session.steer(text);
  }

  async followUp(text: string): Promise<void> {
    await this.session.followUp(text);
  }

  async abort(): Promise<void> {
    // The order is intentional: synchronously revoke this request and discard queued continuation
    // before the SDK observes abort; finally repeats clearQueue for queue_update reentrancy.
    const token = this.requestAbort;
    token?.abort();
    this.session.clearQueue?.();
    try {
      await this.session.abort();
      this.discard = true; // 中止后丢弃残余事件（迟到 agent_end/text/tool）
    } finally {
      this.session.clearQueue?.();
      this.failbackAttempt = null;
    }
  }

  async navigateTree(targetId: string): Promise<void> {
    await this.session.navigateTree(targetId);
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const model = this.getModel?.(provider, modelId);
    if (!model) throw new Error(`模型不可用：${provider}/${modelId}`);
    await this.session.setModel(model);
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.session.setThinkingLevel(level);
  }

  dispose(): void {
    this.requestAbort?.abort();
    this.session.clearQueue?.();
    this.session.dispose();
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

  async getLastUsage(): Promise<UsageInfo | null> {
    const messages = this.session.messages as Array<{
      role?: string;
      usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
    }>;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== "assistant" || !m.usage) continue;
      const promptTokens = m.usage.promptTokens ?? 0;
      const completionTokens = m.usage.completionTokens ?? 0;
      const totalTokens = m.usage.totalTokens ?? promptTokens + completionTokens;
      if (totalTokens > 0) {
        return { promptTokens, completionTokens, totalTokens };
      }
    }
    return null;
  }

  /** Additive snapshot: legacy messages plus stable, block-ordered tool timeline. */
  async exportSession(): Promise<unknown> {
    return projectExportSnapshot(this.session.messages, this.session.sessionManager?.getBranch() ?? []);
  }
}
