import type { TimelineItem } from "../types.js";
import { Markdown } from "./Markdown.js";
import { ThinkingRow } from "./ThinkingRow.js";

export type MessageItemProps = {
  item: Extract<TimelineItem, { kind: "message" | "thinking" }>;
};

export function MessageItem({ item }: MessageItemProps) {
  if (item.kind === "thinking") {
    return <ThinkingRow thinking={item} />;
  }

  if (item.role === "user") {
    return (
      <div className="message-row row-user" data-testid={`message-${item.id}`}>
        <div className="message-user">
          <div className="user-bubble">{item.text}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="message-row row-assistant" data-testid={`message-${item.id}`}>
      <div className="message-assistant">
        <div className="assistant-content">
          {item.text ? (
            <Markdown text={item.text} />
          ) : (
            <span className="streaming-cursor">▍</span>
          )}
          {item.streaming && <span className="streaming-cursor">▍</span>}
        </div>
      </div>
    </div>
  );
}
