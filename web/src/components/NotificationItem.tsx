import { zhCN } from "../i18n/zh-CN.js";
import { useState } from "react";
import type { TimelineItem } from "pi-agent-server/client";
import { Markdown } from "./Markdown.js";
import { DisplayModeToggle } from "./ToolResultText.js";

export function NotificationItem({ item }: { item: Extract<TimelineItem, { kind: "notification" }> }) {
  const [markdown, setMarkdown] = useState(true);
  return <section className="subagent-notification" data-testid="subagent-notification" aria-label={zhCN.notification.subagent}>
    <div className="subagent-notification-label">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z"/><path d="M10 21h4"/></svg>
      <span>{zhCN.notification.subagent}</span>
      <DisplayModeToggle markdown={markdown} onToggle={() => setMarkdown(value => !value)} />
    </div>
    {markdown ? <Markdown text={item.text} imagePolicy="link" /> : <pre className="tool-readable-value">{item.text}</pre>}
  </section>;
}
