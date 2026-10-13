import { memo } from "react";
import type { ChatState } from "pi-agent-server/client";
import { NotificationItem } from "./NotificationItem.js";
import { MessageItem } from "./MessageItem.js";
import { ToolCallCard } from "./ToolCallCard.js";

/** Reducer preserves unchanged item identities, so only live/changed rows render. */
export const Timeline = memo(function Timeline({ timeline }: { timeline: ChatState["timeline"] }) {
  return <div className="timeline" data-testid="message-list">
    {timeline.filter(item => item.kind !== "thinking" || item.text.trim()).map(item => <div key={item.id} data-timeline-id={item.id} data-timeline-kind={item.kind === "message" ? item.role === "user" ? "user" : "assistant_text" : item.kind === "tool" ? "tool_call" : item.kind} data-tool-call-id={item.kind === "tool" ? item.call.toolCallId : undefined} className="timeline-entry" tabIndex={-1}>{item.kind === "notification"
      ? <NotificationItem key={item.id} item={item} />
      : item.kind === "tool"
        ? <ToolCallCard key={item.id} call={item.call} />
        : <MessageItem key={item.id} item={item} />}</div>)}
  </div>;
});
