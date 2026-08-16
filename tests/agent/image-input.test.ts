import { describe, it, expect } from "vitest";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import {
  PiAgentAdapter,
  type AgentSessionLike,
  type SdkImageContent,
} from "../../src/agent/pi-agent-adapter.js";
import type { ImageInput } from "../../src/agent/agent-adapter.js";
import type { AgentSdkEvent } from "../../src/agent/events.js";

// 图片输入：HTTP/接口层用轻量 ImageInput（{ mediaType, base64 }），
// 只在 PiAgentAdapter 内转成 SDK PromptOptions.images 的 ImageContent 结构（type:"image" + base64 source）。
// AgentAdapter / Mock 不感知 SDK 类型（docs/architecture.md §2 类型隔离）。

/** 记录 prompt 调用与 options 的 fake session，用于断言传给 session.prompt 的图片结构。 */
class ImageFakeSession implements AgentSessionLike {
  readonly promptCalls: string[] = [];
  promptOptions?: { images?: SdkImageContent[] };
  messages: unknown[] = [];

  async prompt(text: string, options?: { images?: SdkImageContent[] }): Promise<void> {
    this.promptCalls.push(text);
    this.promptOptions = options;
  }
  async steer(_text: string): Promise<void> {}
  async followUp(_text: string): Promise<void> {}
  async abort(): Promise<void> {}
  async navigateTree(_targetId: string): Promise<void> {}
  subscribe(_listener: (event: AgentSdkEvent) => void): () => void {
    return () => {};
  }
  dispose(): void {}
}

describe("图片输入（ImageInput → SDK ImageContent）", () => {
  describe("MockAgentAdapter.prompt 记录 images", () => {
    it("prompt(text, { images }) 把 images 记入 calls", async () => {
      const adapter = new MockAgentAdapter();
      const images: ImageInput[] = [
        { mediaType: "image/png", base64: "aGVsbG8=" },
        { mediaType: "image/jpeg", base64: "d29ybGQ=" },
      ];

      await adapter.prompt("图片里的字是什么", { images });

      expect(adapter.calls).toEqual([{ method: "prompt", text: "图片里的字是什么", images }]);
    });

    it("不带 images 时 calls 的 prompt 条目不含 images 字段（既有行为不变）", async () => {
      const adapter = new MockAgentAdapter();

      await adapter.prompt("纯文本");

      expect(adapter.calls).toEqual([{ method: "prompt", text: "纯文本" }]);
    });
  });

  describe("PiAgentAdapter 图片转换", () => {
    it("把 ImageInput[] 转成 SDK ImageContent[] 传给 session.prompt", async () => {
      const session = new ImageFakeSession();
      const adapter = new PiAgentAdapter(session);
      const images: ImageInput[] = [
        { mediaType: "image/png", base64: "YQ==" },
        { mediaType: "image/jpeg", base64: "Yg==" },
      ];

      await adapter.prompt("这张图是什么", { images });

      expect(session.promptOptions).toEqual({
        images: [
          { type: "image", source: { type: "base64", mediaType: "image/png", data: "YQ==" } },
          { type: "image", source: { type: "base64", mediaType: "image/jpeg", data: "Yg==" } },
        ],
      });
      expect(session.promptCalls).toEqual(["这张图是什么"]);
    });

    it("不带 images 时只传 text（不构造 options 对象）", async () => {
      const session = new ImageFakeSession();
      const adapter = new PiAgentAdapter(session);

      await adapter.prompt("无图");

      expect(session.promptOptions).toBeUndefined();
      expect(session.promptCalls).toEqual(["无图"]);
    });
  });
});