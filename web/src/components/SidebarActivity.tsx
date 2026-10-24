import type { ActivityResult, ActivityRun } from "pi-agent-server/client";
import { zhCN } from "../i18n/zh-CN.js";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu.js";
import { Icon } from "./Icon.js";
import type { NotifyPermission } from "../hooks/useRunNotifications.js";

/** Rows per list in the menu. */
const MENU_ROWS = 5;

export type SidebarActivityProps = {
  running: ReadonlyMap<string, ActivityRun>;
  recent: readonly ActivityResult[];
  onOpen: (projectId: string, sessionId: string) => void;
  notify: { enabled: boolean; permission: NotifyPermission; toggle: (next: boolean) => void };
};

/**
 * Runs across sessions at the sidebar's foot (docs/companion-butler.md §6.1): how many run now,
 * and a menu with what runs, how recent runs ended, and the notification switch. The companion
 * itself stays at the composer, where it also says when another session ends.
 */
export function SidebarActivity({ running, recent, onOpen, notify }: SidebarActivityProps) {
  const count = running.size;
  const runs = [...running.values()].sort((a, b) => b.startedAt - a.startedAt);
  const title = (value: string) => value || zhCN.companion.untitled;
  const label = zhCN.companion.activity(count);

  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" className="sidebar-activity-toggle" data-testid="sidebar-activity-toggle" data-running={count > 0 ? "true" : undefined}
        aria-label={label} title={label}>
        <Icon name="activity" />
        <span className="sidebar-activity-label">{count > 0 ? zhCN.companion.runningCount(count) : zhCN.companion.activityIdle}</span>
        {count > 0 && <span className="sidebar-activity-count" data-testid="sidebar-activity-count" aria-hidden="true">{count}</span>}
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="end" className="sidebar-activity-menu" aria-label={zhCN.companion.activityIdle}>
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
  </DropdownMenu>;
}
