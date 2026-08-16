import type { ChatMessage, ToolCall } from "../types.js";
import { MessageItem } from "./MessageItem.js";
import { ToolCallCard } from "./ToolCallCard.js";
import { Composer } from "./Composer.js";

export type ChatProps = {
  messages: ChatMessage[];
  toolCalls: ToolCall[];
  /** 是否有请求在途（queued/streaming）。 */
  streaming: boolean;
  /** 是否排队等待（排队只可 abort，不接受 steer）。 */
  queued?: boolean;
  onSend: (text: string) => void;
  onSteer: (text: string) => void;
  onAbort: () => void;
};

/** 聊天区：消息列表 + 工具调用卡片 + 输入区。 */
export function Chat({ messages, toolCalls, streaming, queued, onSend, onSteer, onAbort }: ChatProps) {
  return (
    <section data-testid="chat">
      <div data-testid="message-list">
        {messages.map((m) => (
          <MessageItem key={m.id} message={m} />
        ))}
      </div>
      <div data-testid="tool-call-list">
        {toolCalls.map((t) => (
          <ToolCallCard key={t.toolCallId} call={t} />
        ))}
      </div>
      <Composer
        streaming={streaming}
        queued={queued}
        onSend={onSend}
        onSteer={onSteer}
        onAbort={onAbort}
      />
    </section>
  );
}