// AgentAdapter：把 Pi SDK 的 AgentSession 隔离为可 mock 接口（docs/architecture.md §2）。
// 方法签名对齐 pi-sdk-api.md §3：prompt / steer / followUp / abort / subscribe / exportSession。
// 单元测试一律用 MockAgentAdapter，绝不碰真实 Pi SDK。

import type { UsageSnapshot } from "../core/usage-snapshot.js";
import type { AgentSdkEvent } from "./events.js";
import type { FailbackLifecycleEvent } from "./failback-lifecycle.js";

/** HTTP/接口层的图片输入（轻量结构，mediaType + base64；SDK ImageContent 只在 pi-agent-adapter 内转换）。 */
import type { ImageInput } from "../shared/api-types.js";
export type { ImageInput } from "../shared/api-types.js";

/** 模型用量信息（从 SDK assistant message 的 usage 提取）。 */
export type UsageInfo = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

/** SDK 当前实际生效的配置快照；用于把扩展自动切换同步回会话索引。 */
export type AgentConfigurationSnapshot = {
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
};

export interface AgentAdapter {
  getSubagents?(sessionId: string, runId?: string): import("../shared/subagents.js").SubagentSnapshot;
  /** Internal session-local extension capability, installed before SDK extension binding. */
  bindSubagentHostTransport?(transport: import("./subagent-host-transport.js").SubagentHostTransport): () => void;
  isSdkStreaming?(): boolean;
  queueCustomFollowUp?(message: import("./subagent-host-transport.js").ExtensionCustomMessage): Promise<void>;
  promptCustom?(message: import("./subagent-host-transport.js").ExtensionCustomMessage): Promise<void>;
  /** Optional live character estimate, separate from actual SDK usage. */
  subscribeModelOutputProgress?(listener: (progress: import("./model-output-sampler.js").ModelOutputProgress) => void): () => void;
  /** 空闲时发送输入（needs.md §4.2 的 POST /v1/sessions/:id/messages）；images 可选图片附件。 */
  prompt(text: string, options?: { images?: ImageInput[] }): Promise<void>;

  /** 流式生成中插入指令（POST /v1/sessions/:id/steer）。 */
  steer(text: string, input?: import("../shared/steering.js").SteeringInput): Promise<void>;
  subscribeSteeringConsumed?(listener: (identity: import("../shared/steering.js").SteeringConsumed) => void): () => void;
  /** Coalesced session-steps position changes; the listener then reads the snapshot. */
  subscribeStepsChanged?(listener: (position: { projectionId: string; revision: number }) => void): () => void;
  /** Coalesced subagent record / live-output changes; the listener then reads GET /subagents. */
  subscribeSubagentsChanged?(listener: (revision: number) => void): () => void;
  /** Deferred request-owned adapter failures; must never be routed to a later request. */
  subscribeRequestError?(listener: (error: Error, requestId: string) => void): () => void;

  /** 流式生成中追加指令（POST /v1/sessions/:id/follow-ups）。 */
  followUp(text: string, input?: import("../shared/steering.js").SteeringInput): Promise<void>;
  getControlQueueItems?(): import("../shared/control-queue.js").ControlQueueItem[];
  subscribeControlQueue?(listener: () => void): () => void;
  mutateControlQueue?(identity: import("../shared/control-queue.js").ControlIdentity, operation: "delete" | "promote"): boolean;

  /** 中止当前生成或工具调用（POST /v1/sessions/:id/abort）。 */
  abort(): Promise<void>;

  /** 导航到历史树节点，之后 prompt 从该节点重新生成（needs.md §4.2 从历史节点重跑）。 */
  navigateTree(targetId: string): Promise<void>;

  /** 切换模型（provider + modelId）。 */
  setModel(provider: string, modelId: string): Promise<void>;

  /** 切换思考级别（off/minimal/low/medium/high/xhigh/max）。 */
  setThinkingLevel(level: string): Promise<void>;

  /** 宿主命令（/compact、/reload）；仅在没有活动 prompt 时调用。 */
  runCommand?(input: import("../shared/commands.js").SessionCommandInput): Promise<import("../shared/commands.js").SessionCommandResult>;
  /** 取消进行中的命令（目前只有压缩可取消）。 */
  abortCommand?(): void;

  /** 订阅 SDK 事件流；返回退订函数（SSE 事件源，needs.md §4.2）。 */
  subscribe(listener: (event: AgentSdkEvent) => void): () => void;

  subscribeNotifications?(listener: (event: import("./subagent-notification.js").NotificationEvent) => void): () => void;

  /** 订阅同一 session ResourceLoader 的 model-failback 生命周期（可选扩展能力）。 */
  subscribeFailbackLifecycle?(listener: (event: FailbackLifecycleEvent) => void): () => void;

  /** SDK 配置改变（包括扩展自动 fallback）时发出实际快照。 */
  subscribeConfigurationSnapshot?(listener: (snapshot: AgentConfigurationSnapshot) => void): () => void;
  getConfigurationSnapshot?(): AgentConfigurationSnapshot;

  /** 导出会话消息列表或可序列化数据（GET /v1/sessions/:id/export）。 */
  exportSession(): Promise<unknown>;

  /** Read the existing SDK's public effective prompt; never creates a session. */
  getEffectiveSystemPrompt?(): string | null;
  getSessionSteps?(sessionId: string): import("../shared/session-steps.js").SessionStepsSnapshot;

  /** 读取最近一条 assistant 消息的 usage（用于 turn 结束后推送 stats）。 */
  getLastUsage(): Promise<UsageInfo | null>;

  /** Current authorized SDK instance only; additive to legacy usage. */
  getUsageSnapshot?(): Promise<UsageSnapshot>;
  /** O(1) event-driven durable loop/turn snapshot. */
  getExecutionSnapshot?(): import("../core/usage-snapshot.js").ExecutionSnapshot;

  /** 释放底层会话资源（退订监听、dispose SDK session）；删除会话/关闭时调用。 */
  dispose(): void;
}
