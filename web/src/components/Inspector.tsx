import type { ReactNode } from "react";
import { zhCN } from "../i18n/zh-CN.js";
import { useId, useState } from "react";
import type { SessionRecord } from "pi-agent-server/client";
import type { SessionStepsSnapshot } from "../../../src/shared/session-steps.js";
import type { SessionSystemPrompt } from "../../../src/shared/system-prompt.js";
import { Icon } from "./Icon.js";
import { EventLog } from "./EventLog.js";
import { SystemPromptPanel } from "./SystemPromptPanel.js";
import type { TraceNavigation } from "./step-navigation.js";
import { SessionSteps } from "./SessionSteps.js";
import type { EventLogEntry } from "../types.js";
import { useFollowBottom } from "../hooks/useFollowBottom.js";

export type InspectorTab = 'steps' | 'systemPrompt' | 'events' | 'subagents';
const TABS = [
  { id: "subagents", label: "子代理" },
  { id: "steps", label: zhCN.trace.title },
  { id: "systemPrompt", label: zhCN.trace.systemPrompt },
  { id: "events", label: zhCN.trace.events },
] as const;
export type InspectorProps = {
  subagents?: ReactNode;
  subagentCount?: number;
  session: SessionRecord | null;
  entries: EventLogEntry[];
  onClearEvents: () => void;
  onClose?: () => void;
  navigation?: TraceNavigation | null;
  steps?: SessionStepsSnapshot | null;
  stepsLoading?: boolean;
  stepsError?: string | null;
  systemPrompt?: SessionSystemPrompt | null;
  systemPromptLoading?: boolean;
  systemPromptError?: string | null;
  activeTab?: InspectorTab;
  onTabChange?: (tab: InspectorTab) => void;
};

export function Inspector({ subagents, subagentCount = 0, session, entries, onClearEvents, onClose, navigation, steps, stepsLoading, stepsError,
  systemPrompt, systemPromptLoading, systemPromptError, activeTab: controlledTab, onTabChange }: InspectorProps) {
  const [localTab, setLocalTab] = useState<InspectorTab>('steps');
  const activeTab = controlledTab ?? localTab;
  const id = useId();
  const snapshot = session && steps?.sessionId === session.id ? steps : null;
  const scroll = useFollowBottom(`${session?.id}:${activeTab}:${snapshot?.projectionId}`, snapshot, activeTab === 'steps', navigation);
  const select = (tab: InspectorTab) => { setLocalTab(tab); onTabChange?.(tab); };
  return <aside id="session-inspector" className="inspector" data-testid="inspector" onKeyDown={(event) => {
    if (event.key === 'Escape' && onClose && !(event.target instanceof Element && event.target.closest('dialog'))) { event.stopPropagation(); onClose(); }
  }}>
    {onClose && <button type="button" className="workbench-inspector-close" data-testid="inspector-close" aria-label={zhCN.sidebar.closeInspector} onClick={onClose}><Icon name="close" /></button>}
    <div className="inspector-tabs" role="tablist" aria-label={zhCN.trace.inspector}>
      {TABS.map((tab, index) => <button key={tab.id} type="button" role="tab"
        aria-label={tab.id === 'steps' ? zhCN.trace.count(snapshot?.steps.length ?? 0) : tab.label}
        title={tab.id === 'steps' ? zhCN.trace.provenance : undefined}
        id={`${id}-${tab.id}`} aria-controls={`${id}-panel`} aria-selected={activeTab === tab.id}
        tabIndex={activeTab === tab.id ? 0 : -1} className={activeTab === tab.id ? 'active' : ''}
        onClick={() => select(tab.id)} data-testid={`inspector-tab-${tab.id}`}
        onKeyDown={(event) => {
          const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault(); select(TABS[next].id);
          document.getElementById(`${id}-${TABS[next].id}`)?.focus();
        }}>
        {tab.label}{tab.id === "subagents" && subagentCount > 0 && <span className="tab-badge">{subagentCount}</span>}{tab.id === 'steps' && <span className="tab-badge">{snapshot?.steps.length ?? 0}</span>}
      </button>)}
    </div>
    <div className="inspector-body" ref={scroll.ref} onScroll={scroll.onScroll}
      onChangeCapture={scroll.pause}
      onClickCapture={(event) => { if ((event.target as Element).closest('.step-toggle, .step-content')) scroll.pause(); }}
      role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${activeTab}`}>
      {activeTab === 'subagents' && subagents}
      {activeTab === 'steps' && <SessionSteps key={`${session?.id}:${snapshot?.projectionId}`} sessionSelected={!!session} navigation={navigation} snapshot={snapshot} loading={stepsLoading} error={stepsError} />}
      {activeTab === 'systemPrompt' && <SystemPromptPanel session={session} systemPrompt={systemPrompt} loading={systemPromptLoading} error={systemPromptError} />}
      {activeTab === 'events' && <EventLog key={session?.id} entries={entries} onClear={onClearEvents} showHeader={false} />}
    </div>
  </aside>;
}
