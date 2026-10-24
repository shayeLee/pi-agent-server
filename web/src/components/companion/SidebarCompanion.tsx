import { useEffect, useRef, useState } from "react";
import type { ActivityEvent, ActivityResult, ActivityRun } from "pi-agent-server/client";
import { zhCN } from "../../i18n/zh-CN.js";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { CompanionFigure } from "./CompanionFigure.js";
import type { CompanionPersona } from "./companion-lines.js";
import type { NotifyPermission } from "../../hooks/useRunNotifications.js";

/** How long the sidebar companion's word on another session stays up; long enough to click. */
export const SIDEBAR_BUBBLE_MS = 6000;
/** Rows per list in the menu. */
const MENU_ROWS = 5;

type Ended = ActivityResult & { kind: "completed" | "failed" };

function pageVisible(): boolean {
  try { return document.visibilityState === "visible"; } catch { return true; }
}

/**
 * Another session just completed or failed while this page is in front: say so for
 * SIDEBAR_BUBBLE_MS. The session on screen already shows its own end, so it is skipped.
 */
function useElsewhereBubble(latest: ActivityEvent | null, activeSessionId: string | null): [Ended | null, () => void] {
  const [bubble, setBubble] = useState<Ended | null>(null);
  // A run starting elsewhere must not cut the word short, so the timer outlives `latest`.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!latest || (latest.kind !== "completed" && latest.kind !== "failed") || latest.sessionId === activeSessionId || !pageVisible()) return;
    setBubble(latest as Ended);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setBubble(null), SIDEBAR_BUBBLE_MS);
  }, [latest]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [bubble, () => { clearTimeout(timer.current); setBubble(null); }];
}

export type SidebarCompanionProps = {
  persona: CompanionPersona;
  running: ReadonlyMap<string, ActivityRun>;
  recent: readonly ActivityResult[];
  latest: ActivityEvent | null;
  activeSessionId: string | null;
  onOpen: (projectId: string, sessionId: string) => void;
  notify: { enabled: boolean; permission: NotifyPermission; toggle: (next: boolean) => void };
};

/**
 * The companion at the sidebar's foot (docs/companion-butler.md §6.1): busy while any session the
 * person can see is running, with the count; a word when another one ends, which opens it. Its
 * menu lists what is running and how recent runs ended, and holds the notification switch.
 */
export function SidebarCompanion({ persona, running, recent, latest, activeSessionId, onOpen, notify }: SidebarCompanionProps) {
  const [bubble, dismiss] = useElsewhereBubble(latest, activeSessionId);
  const voice = zhCN.companion.voices[persona.style];
  const count = running.size;
  const mood = bubble ? (bubble.kind === "completed" ? "happy" : "sad") : count > 0 ? "working" : "idle";
  const runs = [...running.values()].sort((a, b) => b.startedAt - a.startedAt);
  const title = (value: string) => value || zhCN.companion.untitled;
  const line = bubble && voice.elsewhere[bubble.kind](title(bubble.title));

  return <div className="sidebar-companion" data-testid="sidebar-companion">
    {bubble && line && <button type="button" key={bubble.id} className="sidebar-companion-bubble" data-testid="sidebar-companion-bubble" data-kind={bubble.kind}
      aria-label={zhCN.companion.openBubble(line)} onClick={() => { dismiss(); onOpen(bubble.projectId, bubble.sessionId); }}>
      {line}
    </button>}
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={persona.docked ? "sidebar-companion-figure" : "sidebar-companion-figure is-away"} data-testid="sidebar-companion-toggle"
          data-mood={mood} aria-label={zhCN.companion.activity(persona.name, count)} title={zhCN.companion.activity(persona.name, count)}>
          {persona.docked ? <CompanionFigure mood={mood} size={32} /> : <span className="companion-dock-dot" />}
          {count > 0 && <span className="sidebar-companion-count" data-testid="sidebar-companion-count" aria-hidden="true">{count}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="sidebar-companion-menu" aria-label={persona.name}>
        <DropdownMenuLabel>{zhCN.companion.runningTitle}</DropdownMenuLabel>
        {runs.length === 0 && <DropdownMenuItem disabled>{zhCN.companion.nothingRunning}</DropdownMenuItem>}
        {runs.slice(0, MENU_ROWS).map(run => <DropdownMenuItem key={run.sessionId} data-testid={`activity-running-${run.sessionId}`}
          onSelect={() => onOpen(run.projectId, run.sessionId)}>
          <span className="activity-row-title">{title(run.title)}</span>
          <span className="activity-row-state">{zhCN.run.running}</span>
        </DropdownMenuItem>)}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{zhCN.companion.recentTitle}</DropdownMenuLabel>
        {recent.length === 0 && <DropdownMenuItem disabled>{zhCN.companion.nothingRecent}</DropdownMenuItem>}
        {recent.slice(0, MENU_ROWS).map(result => <DropdownMenuItem key={result.id} data-testid={`activity-recent-${result.id}`} data-kind={result.kind}
          title={result.message} onSelect={() => onOpen(result.projectId, result.sessionId)}>
          <span className="activity-row-title">{title(result.title)}</span>
          <span className="activity-row-state" data-kind={result.kind}>{zhCN.companion.outcome[result.kind]}</span>
        </DropdownMenuItem>)}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem data-testid="activity-notify" checked={notify.enabled}
          disabled={notify.permission === "unsupported" || (notify.permission === "denied" && !notify.enabled)}
          onSelect={event => event.preventDefault()} onCheckedChange={checked => notify.toggle(checked === true)}>
          {zhCN.companion.notify}
        </DropdownMenuCheckboxItem>
        {notify.permission === "denied" && <p className="activity-notify-hint">{zhCN.companion.notifyDenied}</p>}
        {notify.permission === "unsupported" && <p className="activity-notify-hint">{zhCN.companion.notifyUnsupported}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}
