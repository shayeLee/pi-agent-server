import { useState } from "react";
import type { SessionRecord, TimelineItem } from "../types.js";
import { EventLog } from "./EventLog.js";
import { SystemPromptPanel } from "./SystemPromptPanel.js";
import type { EventLogEntry } from "../types.js";

const TABS = [
  { id: "events", label: "事件流" },
  { id: "tools", label: "工具" },
  { id: "systemPrompt", label: "系统提示词" },
] as const;

export type InspectorProps = {
  session: SessionRecord | null;
  entries: EventLogEntry[];
  timeline: TimelineItem[];
  onClearEvents: () => void;
};

/** 右侧 Inspector 面板：事件流 / 工具调用 / 系统提示词。 */
export function Inspector({
  session,
  entries,
  timeline,
  onClearEvents,
}: InspectorProps) {
  const [activeTab, setActiveTab] = useState<(typeof TABS)[number]["id"]>("events");

  const toolCalls = timeline.filter((item) => item.kind === "tool").map((item) => item.call);

  return (
    <aside className="inspector" data-testid="inspector">
      <div className="inspector-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={activeTab === tab.id ? "active" : ""}
            onClick={() => setActiveTab(tab.id)}
            data-testid={`inspector-tab-${tab.id}`}
          >
            {tab.label}
            {tab.id === "tools" && toolCalls.length > 0 && (
              <span className="tab-badge">{toolCalls.length}</span>
            )}
          </button>
        ))}
      </div>
      <div className="inspector-body">
        {activeTab === "events" && (
          <EventLog entries={entries} onClear={onClearEvents} showHeader={false} />
        )}
        {activeTab === "tools" && (
          <div className="inspector-tools" data-testid="inspector-tools">
            {toolCalls.length === 0 ? (
              <div className="empty-hint">暂无工具调用</div>
            ) : (
              <ul className="tool-summary-list">
                {toolCalls.map((call) => (
                  <li
                    key={call.toolCallId}
                    className={`tool-summary ${call.done ? (call.isError ? "error" : "done") : "running"}`}
                  >
                    <span className="tool-summary-name">{call.toolName}</span>
                    <span className="tool-summary-status">
                      {call.done ? (call.isError ? "失败" : "完成") : "运行中"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {activeTab === "systemPrompt" && <SystemPromptPanel session={session} />}
      </div>
    </aside>
  );
}
