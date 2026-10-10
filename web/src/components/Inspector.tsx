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
    <aside className="inspector col-start-3 row-start-1 flex h-full min-w-0 flex-col overflow-hidden border-l border-border bg-sidebar text-sidebar-foreground max-[1439px]:fixed max-[1439px]:inset-y-0 max-[1439px]:right-0 max-[1439px]:z-[95] max-[1439px]:h-dvh max-[1439px]:w-[min(380px,100vw)] max-[1439px]:border-l-0 max-[1439px]:shadow-lg" data-testid="inspector">
      {onClose && <button type="button" className="workbench-inspector-close absolute right-2 top-2 z-[2] hidden size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent max-[1439px]:grid" data-testid="inspector-close" aria-label={t("inspector.close")} onClick={onClose}><Icon name="close" /></button>}
      <div className="inspector-tabs flex h-12 shrink-0 items-center gap-3 border-b border-border px-3 max-[1439px]:pr-12">
        {TAB_KEYS.map((tab) => (
          <button
            key={tab.id}
            className={activeTab === tab.id ? "active h-full border-0 bg-transparent px-1 text-[13px] text-primary shadow-[inset_0_-2px_0_var(--primary)]" : "h-full border-0 bg-transparent px-1 text-[13px] text-muted-foreground hover:text-foreground"}
            onClick={() => setActiveTab(tab.id)}
            data-testid={`inspector-tab-${tab.id}`}
          >
            {t(tab.labelKey)}
            {tab.id === "tools" && toolCalls.length > 0 && (
              <span className="tab-badge ml-1.5 rounded-md bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">{toolCalls.length}</span>
            )}
          </button>
        ))}
      </div>
      <div className="inspector-body min-h-0 flex-1 overflow-y-auto">
        {activeTab === "events" && (
          <EventLog entries={entries} onClear={onClearEvents} showHeader={false} />
        )}
        {activeTab === "tools" && (
          <div className="inspector-tools p-3" data-testid="inspector-tools">
            {toolCalls.length === 0 ? (
              <div className="empty-hint px-1 py-6 text-center text-[13px] text-muted-foreground">{t("inspector.emptyTools")}</div>
            ) : (
              <ul className="tool-summary-list flex list-none flex-col gap-1 p-0">
                {toolCalls.map((call) => {
                  const header = toolHeader(call);
                  return <li
                    key={call.toolCallId}
                    className={`tool-summary flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${call.done ? (call.isError ? "error text-destructive" : "done") : "running"}`}
                    tabIndex={0}
                  >
                    <Icon name={header.icon} className="tool-summary-category" />
                    <div className="tool-summary-content min-w-0 flex-1">
                      <span className="tool-summary-name block truncate font-medium">{call.toolName}</span>
                      {header.summary && <span className="tool-summary-description block truncate font-mono text-[12px] text-muted-foreground" title={header.summary}>{header.summary}</span>}
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
