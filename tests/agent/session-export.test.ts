import { describe, it, expect } from "vitest";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import {
  PiAgentAdapter,
  type AgentSessionLike,
  type SdkImageContent,
} from "../../src/agent/pi-agent-adapter.js";
import type { AgentSdkEvent } from "../../src/agent/events.js";

// 会话导出：AgentAdapter.exportSession() 返回会话消息列表（可序列化数据），
// HTTP GET /v1/sessions/:id/export 直接透传给客户端（README §4.2）。

/** 可设置 messages 的 fake session，用于断言 PiAgentAdapter.exportSession 透传。 */
class ExportFakeSession implements AgentSessionLike {
  messages: unknown[] = [];

  async prompt(_text: string, _options?: { images?: SdkImageContent[] }): Promise<void> {}
  async steer(_text: string): Promise<void> {}
  async followUp(_text: string): Promise<void> {}
  async abort(): Promise<void> {}
  async navigateTree(_targetId: string): Promise<void> {}
  subscribe(_listener: (event: AgentSdkEvent) => void): () => void {
    return () => {};
  }
  dispose(): void {}
}

describe("会话导出（AgentAdapter.exportSession）", () => {
  describe("MockAgentAdapter", () => {
    it("exportSession 返回可配置的导出数据（构造参数注入）", async () => {
      const messages = [
        { role: "user", content: [{ type: "text", text: "你好" }] },
        { role: "assistant", content: [{ type: "text", text: "你好！" }] },
      ];
      const adapter = new MockAgentAdapter([], messages);

      expect(await adapter.exportSession()).toBe(messages);
    });

    it("exportData 属性可运行期配置，exportSession 返回该数据", async () => {
      const adapter = new MockAgentAdapter();
      const data = { messages: ["a", "b"] };
      adapter.exportData = data;

      expect(await adapter.exportSession()).toBe(data);
    });

    it("未配置导出数据时返回默认空消息列表", async () => {
      const adapter = new MockAgentAdapter();

      expect(await adapter.exportSession()).toEqual([]);
    });
  });

  describe("PiAgentAdapter", () => {
    it("exportSession 把 session.messages 扁平化为 { role, text }[]（提取 text 块）", async () => {
      const messages = [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "忽略" },
            { type: "text", text: "hello" },
          ],
        },
        { role: "toolResult", content: [{ type: "text", text: "忽略工具结果" }] },
      ];
      const session = new ExportFakeSession();
      session.messages = messages;
      const adapter = new PiAgentAdapter(session);

      expect(await adapter.exportSession()).toEqual([
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ]);
    });
  });
});