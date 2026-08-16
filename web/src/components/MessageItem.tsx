import type { ChatMessage } from "../types.js";

/** 单条消息：user 右对齐、assistant 左对齐。 */
export function MessageItem({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div
      data-testid="message-item"
      data-role={message.role}
      style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}
    >
      <div className={`msg-bubble ${isUser ? "msg-user" : "msg-assistant"}`}>{message.text}</div>
    </div>
  );
}