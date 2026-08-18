// PiAgentAdapter：把真实 Pi SDK 的 AgentSession 适配为 AgentAdapter 接口（docs/pi-sdk-api.md §3）。
// 这是接入真实 SDK 的唯一位置；单元测试用 AgentSessionLike 结构（fake），不碰真实 SDK；
// 真实 AgentSession 的验证走独立的慢速集成测试（docs/architecture.md §3.2）。

import type { AgentAdapter, ImageInput, UsageInfo } from "./agent-adapter.js";
import type { AgentSdkEvent } from "./events.js";

/** SDK PromptOptions.images 元素结构（{ type:"image", source:{ type:"base64", mediaType, data } }，本地定义，避免 SDK 类型入接口）。 */
export type SdkImageContent = {
  type: "image";
  source: { type: "base64"; mediaType: string; data: string };
};

/** 真实 Pi SDK AgentSession 的最小结构（与方法签名对齐，便于 fake 测试与类型隔离）。 */
export type AgentSessionLike = {
  prompt(text: string, options?: { images?: SdkImageContent[] }): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  navigateTree(targetId: string): Promise<void>;
  subscribe(listener: (event: AgentSdkEvent) => void): () => void;
  dispose(): void;
  setModel(model: unknown): Promise<void>;
  setThinkingLevel(level: unknown): void;
  /** 会话消息列表（导出用；SDK 为 AgentMessage[]，此处用 unknown[] 保持类型隔离）。 */
  messages: unknown[];
};

/** 按 provider + modelId 取模型（Model 结构隔离，避免 SDK 类型入接口）。 */
export type GetModel = (provider: string, modelId: string) => unknown;

export class PiAgentAdapter implements AgentAdapter {
  constructor(
    private readonly session: AgentSessionLike,
    private readonly getModel?: GetModel,
  ) {}

  /** abort 后置真：丢弃底层 run 的残余事件（如迟到的 agent_end），避免串扰下一次 prompt；prompt 开始恢复。 */
  private discard = false;

  async prompt(text: string, options?: { images?: ImageInput[] }): Promise<void> {
    this.discard = false; // 新 run 开始：恢复事件传递
    if (options?.images === undefined || options.images.length === 0) {
      await this.session.prompt(text);
      return;
    }
    // ImageInput（接口层轻量结构）→ SDK ImageContent（base64），只在适配层转换
    await this.session.prompt(text, {
      images: options.images.map((image): SdkImageContent => ({
        type: "image",
        source: { type: "base64", mediaType: image.mediaType, data: image.base64 },
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
    await this.session.abort();
    this.discard = true; // 中止后丢弃残余事件（迟到 agent_end/text/tool）
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
    this.session.dispose();
  }

  subscribe(listener: (event: AgentSdkEvent) => void): () => void {
    return this.session.subscribe((event) => {
      if (this.discard) return; // 丢弃 abort 后的残余事件，避免串扰下一次 prompt
      listener(event);
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

  /** 导出会话：把 SDK AgentMessage[] 扁平化为 { role, text }[]（提取 text 块，忽略 thinking/toolResult）。 */
  async exportSession(): Promise<unknown> {
    const messages = this.session.messages as Array<{ role?: string; content?: unknown }>;
    return messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, text: extractText(m.content) }));
  }
}

/** 从 SDK 消息 content（string 或 content blocks 数组）提取文本。 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
      )
      .map((b) => b.text ?? "")
      .join("");
  }
  return "";
}
