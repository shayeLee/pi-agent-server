import { useId, useState } from "react";
import type { SessionRecord } from "pi-agent-server/client";
import type { SessionStepsSnapshot } from "../../../src/shared/session-steps.js";
import type { SessionSystemPrompt } from "../../../src/shared/system-prompt.js";
import { Icon } from "./Icon.js";
import { EventLog } from "./EventLog.js";
import { SystemPromptPanel } from "./SystemPromptPanel.js";
import { SessionSteps } from "./SessionSteps.js";
import type { EventLogEntry } from "../types.js";

export type InspectorTab = 'steps' | 'systemPrompt' | 'events';
const TABS = [
  { id: "steps", label: "步骤" },
  { id: "systemPrompt", label: "系统提示词" },
  { id: "events", label: "事件流" },
] as const;
export type InspectorProps = {
  session: SessionRecord | null;
  entries: EventLogEntry[];
  onClearEvents: () => void;
  onClose?: () => void;
  steps?: SessionStepsSnapshot | null;
  stepsLoading?: boolean;
  stepsError?: string | null;
  systemPrompt?: SessionSystemPrompt | null;
  systemPromptLoading?: boolean;
  systemPromptError?: string | null;
  activeTab?: InspectorTab;
  onTabChange?: (tab: InspectorTab) => void;
};

export function Inspector({ session, entries, onClearEvents, onClose, steps, stepsLoading, stepsError,
  systemPrompt, systemPromptLoading, systemPromptError, activeTab: controlledTab, onTabChange }: InspectorProps) {
  const [localTab, setLocalTab] = useState<InspectorTab>('steps');
  const activeTab = controlledTab ?? localTab;
  const id = useId();
  const snapshot = session && steps?.sessionId === session.id ? steps : null;
  const select = (tab: InspectorTab) => { setLocalTab(tab); onTabChange?.(tab); };
  return <aside id="session-inspector" className="inspector" data-testid="inspector" onKeyDown={(event) => {
    if (event.key === 'Escape' && onClose) { event.stopPropagation(); onClose(); }
  }}>
    {onClose && <button type="button" className="workbench-inspector-close" data-testid="inspector-close" aria-label="关闭审查器" onClick={onClose}><Icon name="close" /></button>}
    <div className="inspector-tabs" role="tablist" aria-label="会话审查器">
      {TABS.map((tab, index) => <button key={tab.id} type="button" role="tab"
        aria-label={tab.id === 'steps' ? `步骤 ${snapshot?.steps.length ?? 0}` : tab.label}
        title={tab.id === 'steps' ? '历史按已保存记录顺序；实时按观察顺序。时间为记录时间或首次观察时间。' : undefined}
        id={`${id}-${tab.id}`} aria-controls={`${id}-panel`} aria-selected={activeTab === tab.id}
        tabIndex={activeTab === tab.id ? 0 : -1} className={activeTab === tab.id ? 'active' : ''}
        onClick={() => select(tab.id)} data-testid={`inspector-tab-${tab.id}`}
        onKeyDown={(event) => {
          const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
          if (next < 0) return;
          event.preventDefault(); select(TABS[next].id);
          document.getElementById(`${id}-${TABS[next].id}`)?.focus();
        }}>
        {tab.label}{tab.id === 'steps' && <span className="tab-badge">{snapshot?.steps.length ?? 0}</span>}
      </button>)}
    </div>
    <div className="inspector-body" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${activeTab}`}>
      {activeTab === 'steps' && <SessionSteps key={`${session?.id}:${snapshot?.projectionId}`} sessionSelected={!!session} snapshot={snapshot} loading={stepsLoading} error={stepsError} />}
      {activeTab === 'systemPrompt' && <SystemPromptPanel session={session} systemPrompt={systemPrompt} loading={systemPromptLoading} error={systemPromptError} />}
      {activeTab === 'events' && <EventLog entries={entries} onClear={onClearEvents} showHeader={false} />}
    </div>
  </aside>;
}
