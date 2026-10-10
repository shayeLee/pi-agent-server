import { useState } from "react";
import { Icon } from "./Icon.js";
import { ToolStatusIcon } from "./ToolStatusIcon.js";
import { toolHeader } from "../tools/metadata.js";

import type { SessionRecord, TimelineItem } from "pi-agent-server/client";
import { EventLog } from "./EventLog.js";
import { SystemPromptPanel } from "./SystemPromptPanel.js";
import type { EventLogEntry } from "../types.js";

import { useI18n } from "../i18n/I18nProvider.js";

const TAB_KEYS = [
  { id: "events" as const, labelKey: "inspector.tab.events" as const },
  { id: "tools" as const, labelKey: "inspector.tab.tools" as const },
  { id: "systemPrompt" as const, labelKey: "inspector.tab.systemPrompt" as const },
];

export type InspectorProps = {
  session: SessionRecord | null;
  entries: EventLogEntry[];
  timeline: TimelineItem[];
  onClearEvents: () => void;
  onClose?: () => void;
};

/** 右侧 Inspector 面板：事件流 / 工具调用 / 系统提示词。 */
export function Inspector({
  session,
  entries,
  timeline,
  onClearEvents,
  onClose,
}: InspectorProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<(typeof TAB_KEYS)[number]["id"]>("events");

  const toolCalls = timeline.filter((item) => item.kind === "tool").map((item) => item.call);

  return (
    <aside className="inspector" data-testid="inspector">
      {onClose && <button type="button" className="workbench-inspector-close" data-testid="inspector-close" aria-label={t("inspector.close")} onClick={onClose}><Icon name="close" /></button>}
      <div className="inspector-tabs">
        {TAB_KEYS.map((tab) => (
          <button
            key={tab.id}
            className={activeTab === tab.id ? "active" : ""}
            onClick={() => setActiveTab(tab.id)}
            data-testid={`inspector-tab-${tab.id}`}
          >
            {t(tab.labelKey)}
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
              <div className="empty-hint">{t("inspector.emptyTools")}</div>
            ) : (
              <ul className="tool-summary-list">
                {toolCalls.map((call) => {
                  const header = toolHeader(call);
                  return <li
                    key={call.toolCallId}
                    className={`tool-summary ${call.done ? (call.isError ? "error" : "done") : "running"}`}
                    tabIndex={0}
                  >
                    <Icon name={header.icon} className="tool-summary-category" />
                    <div className="tool-summary-content">
                      <span className="tool-summary-name">{call.toolName}</span>
                      {header.summary && <span className="tool-summary-description" title={header.summary}>{header.summary}</span>}
                    </div>
                    <ToolStatusIcon done={call.done} isError={call.isError} />
                  </li>;
                })}
              </ul>
            )}
          </div>
        )}
        {activeTab === "systemPrompt" && <SystemPromptPanel session={session} />}
      </div>
    </aside>
  );
}
