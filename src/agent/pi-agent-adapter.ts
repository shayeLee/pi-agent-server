// PiAgentAdapter：把真实 Pi SDK 的 AgentSession 适配为 AgentAdapter 接口（docs/pi-sdk-api.md §3）。
// 这是接入真实 SDK 的唯一位置；单元测试用 AgentSessionLike 结构（fake），不碰真实 SDK；
// 真实 AgentSession 的验证走独立的慢速集成测试（docs/architecture.md §3.2）。

import type { AgentAdapter, ImageInput, UsageInfo } from "./agent-adapter.js";
import type { AgentSdkEvent } from "./events.js";
import {
  createExportImageProjectionState,
  projectExportImagesForMessage,
  type NormalizedImage,
} from "./image-input.js";

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
    return projectExportMessages(this.session.messages);
  }
}

/** 导出投影的消息条目：role + 文本，user 消息可选携带受支持图片（与活会话导出完全同一形状）。 */
export type ExportMessage = {
  role: string;
  text: string;
  /** 仅 user 消息且确有受支持图片时出现；通过验证的图片逐字节保留 base64。 */
  images?: readonly NormalizedImage[];
};

/**
 * 会话导出投影（唯一实现点）：SDK AgentMessage[] → { role, text, images? }[]。
 * 只保留 user/assistant，提取 text 块（忽略 thinking/toolResult）；
 * user 消息里的受支持 image 块（`{type:"image",data,mimeType}`）经 {@link projectExportImagesForMessage}
 * 重新验证后投影为 `images:[{mediaType,base64}]`，assistant 消息永远只有文本。
 * 只读路径（PiJsonlConversationStorage）必须与活会话导出（PiAgentAdapter.exportSession）共用本函数，
 * 保证两类导出返回逐字节一致的投影。
 */
export function projectExportMessages(messages: readonly unknown[]): ExportMessage[] {
  const state = createExportImageProjectionState();
  return (messages as Array<{ role?: string; content?: unknown }>)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const text = extractText(m.content);
      if (m.role !== "user") return { role: m.role as string, text };
      const images = projectExportImagesForMessage(m.content, state);
      return images.length > 0
        ? { role: m.role as string, text, images }
        : { role: m.role as string, text };
    });
}

/** 从 SDK 消息 content（string 或 content blocks 数组）提取文本。 */
export function extractText(content: unknown): string {
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
