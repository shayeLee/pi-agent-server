import type { ActivityRun } from "pi-agent-server/client";
import { zhCN } from "../i18n/zh-CN.js";
import { Icon } from "./Icon.js";

export type SidebarActivityProps = {
  running: ReadonlyMap<string, ActivityRun>;
  /** The butler panel is open. */
  open: boolean;
  onToggle: () => void;
};

/**
 * Runs across sessions at the sidebar's foot (docs/companion-butler.md §6.1, §12.6): how many run
 * now, and the switch for the right-hand panel with the lists and the butler.
 */
export function SidebarActivity({ running, open, onToggle }: SidebarActivityProps) {
  const count = running.size;
  const label = zhCN.companion.activity(count);
  return <button type="button" className="sidebar-activity-toggle" data-testid="sidebar-activity-toggle" data-running={count > 0 ? "true" : undefined}
    aria-label={label} title={label} aria-pressed={open} aria-controls="butler-panel" onClick={onToggle}>
    <Icon name="activity" />
    <span className="sidebar-activity-label">{count > 0 ? zhCN.companion.runningCount(count) : zhCN.companion.activityIdle}</span>
    {count > 0 && <span className="sidebar-activity-count" data-testid="sidebar-activity-count" aria-hidden="true">{count}</span>}
  </button>;
}
