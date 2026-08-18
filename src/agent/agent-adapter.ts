// AgentAdapter：把 Pi SDK 的 AgentSession 隔离为可 mock 接口（docs/architecture.md §2）。
// 方法签名对齐 pi-sdk-api.md §3：prompt / steer / followUp / abort / subscribe / exportSession。
// 单元测试一律用 MockAgentAdapter，绝不碰真实 Pi SDK。

import type { AgentSdkEvent } from "./events.js";

/** HTTP/接口层的图片输入（轻量结构，mediaType + base64；SDK ImageContent 只在 pi-agent-adapter 内转换）。 */
export type ImageInput = { mediaType: string; base64: string };

/** 模型用量信息（从 SDK assistant message 的 usage 提取）。 */
export type UsageInfo = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export interface AgentAdapter {
  /** 空闲时发送输入（README §4.2 的 POST /v1/sessions/:id/messages）；images 可选图片附件。 */
  prompt(text: string, options?: { images?: ImageInput[] }): Promise<void>;

  /** 流式生成中插入指令（POST /v1/sessions/:id/steer）。 */
  steer(text: string): Promise<void>;

  /** 流式生成中追加指令（POST /v1/sessions/:id/follow-ups）。 */
  followUp(text: string): Promise<void>;

  /** 中止当前生成或工具调用（POST /v1/sessions/:id/abort）。 */
  abort(): Promise<void>;

  /** 导航到历史树节点，之后 prompt 从该节点重新生成（README §4.2 从历史节点重跑）。 */
  navigateTree(targetId: string): Promise<void>;

  /** 切换模型（provider + modelId）。 */
  setModel(provider: string, modelId: string): Promise<void>;

  /** 切换思考级别（off/minimal/low/medium/high/xhigh/max）。 */
  setThinkingLevel(level: string): Promise<void>;

  /** 订阅 SDK 事件流；返回退订函数（SSE 事件源，README §4.2）。 */
  subscribe(listener: (event: AgentSdkEvent) => void): () => void;

  /** 导出会话消息列表或可序列化数据（GET /v1/sessions/:id/export）。 */
  exportSession(): Promise<unknown>;

  /** 读取最近一条 assistant 消息的 usage（用于 turn 结束后推送 stats）。 */
  getLastUsage(): Promise<UsageInfo | null>;

  /** 释放底层会话资源（退订监听、dispose SDK session）；删除会话/关闭时调用。 */
  dispose(): void;
}
