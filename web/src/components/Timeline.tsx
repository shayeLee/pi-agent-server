import { zhCN } from "../i18n/zh-CN.js";
import { memo, useRef, type ReactNode } from "react";
import type { ChatState, TimelineItem } from "pi-agent-server/client";
import { NotificationItem } from "./NotificationItem.js";
import { CommandOutputItem } from "./CommandOutputItem.js";
import { MessageItem } from "./MessageItem.js";
import { ToolCallCard } from "./ToolCallCard.js";
import { ThinkingRow } from "./ThinkingRow.js";
import { WorkBlock } from "./WorkBlock.js";
import { formatClock, groupLedger, type LedgerEntry } from "./ledger.js";

const kindOf = (item: TimelineItem) => item.kind === "message" ? item.role === "user" ? "user" : "assistant_text"
  : item.kind === "tool" ? "tool_call" : item.kind;

/** Navigation anchor kept for every item, so trace and minimap targets resolve unchanged. */
function Anchor({ item, children }: { item: TimelineItem; children: ReactNode }) {
  return <div data-timeline-id={item.id} data-timeline-kind={kindOf(item)}
    data-anchor-tool-call-id={item.kind === "tool" ? item.call.toolCallId : undefined} className="timeline-entry" tabIndex={-1}>{children}</div>;
}

function renderItem(item: TimelineItem) {
  return <Anchor key={item.id} item={item}>{item.kind === "notification"
    ? <NotificationItem item={item} />
    : item.kind === "command"
    ? <CommandOutputItem item={item} />
    : item.kind === "tool"
      ? <ToolCallCard call={item.call} />
      : <MessageItem item={item} />}</Anchor>;
}

const TAGS = {
  user: [zhCN.ledger.you, zhCN.ledger.youLabel],
  assistant: [zhCN.ledger.pi, zhCN.ledger.piLabel],
  system: [zhCN.ledger.sys, zhCN.ledger.sysLabel],
} as const;

/**
 * Ledger stream (DESIGN.md §4): time gutter, role tag, content. Grouping only changes
 * visibility; every item keeps its original order and navigation anchor.
 * Reducer preserves unchanged item identities, so only live/changed rows render.
 */
export const Timeline = memo(function Timeline({ timeline, live = false, ready = true, tail, pending }: {
  timeline: ChatState["timeline"];
  /**
   * What PI is doing before its first words (DESIGN.md §5.3). It joins the live PI entry, or opens
   * one where the reply will appear, so the reply later starts on the same line instead of below it.
   */
  pending?: ReactNode;
  /** Rendered at the end of the live assistant entry (e.g. the subagent panel). */
  tail?: ReactNode;
  /** A request is submitting, queued or streaming. */
  live?: boolean;
  /** History has settled; rows present at that moment are the untimed baseline. */
  ready?: boolean;
}) {
  // Live rows carry no recorded time; use the first time this view observed them.
  // Rows already present when history settles are history, not observations (unless live).
  const observed = useRef(new Map<string, string>()).current;
  const baseline = useRef<Set<string> | null>(null);
  // The PI entry opened by `pending` keeps its time when the reply's first item takes it over.
  const pendingSince = useRef<string | null>(null);
  if (ready) {
    const now = new Date().toISOString();
    const first = baseline.current === null;
    if (first) baseline.current = new Set();
    for (const item of timeline) {
      if (("timestamp" in item && item.timestamp) || observed.has(item.id) || baseline.current!.has(item.id)) continue;
      if (first && !live) baseline.current!.add(item.id);
      else observed.set(item.id, pendingSince.current && !(item.kind === "message" && item.role === "user") ? pendingSince.current : now);
    }
  }
  const entries = groupLedger(timeline, observed);
  const lastEntry = entries[entries.length - 1];
  const joinsEntry = lastEntry?.role === "assistant";
  // The opened PI entry is timed from when this view first showed it, like any live row.
  if (!pending || joinsEntry) pendingSince.current = null;
  else pendingSince.current ??= new Date().toISOString();
  const pendingClock = formatClock(pendingSince.current ?? undefined);
  const [piTag, piLabel] = TAGS.assistant;
  return <div className="timeline ledger" data-testid="message-list">
    {entries.map(entry => <LedgerRow key={entry.id} entry={entry} observed={observed}
      liveTail={live && entry === lastEntry} tail={live && entry === lastEntry && entry.role === "assistant" ? tail : undefined}
      pending={entry === lastEntry && joinsEntry ? pending : undefined} />)}
    {pending && !joinsEntry && <div className="ledger-entry" data-role="assistant">
      <div className="ledger-time">{pendingClock && <time dateTime={pendingSince.current!} title={pendingClock.title}>{pendingClock.text}</time>}</div>
      <div className="ledger-tag" aria-label={piLabel}>{piTag}</div>
      <div className="ledger-body">{pending}</div>
    </div>}
  </div>;
});

function LedgerRow({ entry, observed, liveTail, tail, pending }: { entry: LedgerEntry; observed: ReadonlyMap<string, string>; liveTail: boolean; tail?: ReactNode; pending?: ReactNode }) {
  const clock = formatClock(entry.timestamp);
  const first = entry.segments[0];
  // In a subagent conversation the host agent's turns carry their kind (initial task / steer).
  const hostInput = entry.role === "user" && first?.kind !== "work" && first?.item.kind === "message" ? first.item.hostInput : undefined;
  const host = hostInput ? zhCN.subagents.inputKind[hostInput] : null;
  const [tag, label] = host ? [zhCN.ledger.host, zhCN.ledger.hostLabel(host)] : TAGS[entry.role];
  const lastSegment = entry.segments[entry.segments.length - 1];
  return <div className="ledger-entry" data-role={entry.role}>
    <div className="ledger-time">{clock && <time dateTime={entry.timestamp} title={clock.title}>{clock.text}</time>}
      {host && <span className="ledger-note">{host}</span>}</div>
    <div className="ledger-tag" aria-label={label}>{tag}</div>
    <div className="ledger-body">
      {entry.segments.map(segment => segment.kind === "work"
        ? <WorkBlock key={segment.id} items={segment.items} observed={observed}
            active={segment.items.some(item => item.kind === "tool" && !item.call.done) || (liveTail && segment === lastSegment)}
            renderStep={(item, index) => <Anchor key={item.id} item={item}>{item.kind === "tool"
              ? <ToolCallCard call={item.call} index={index} />
              : <ThinkingRow thinking={item} step />}</Anchor>} />
        : renderItem(segment.item))}
      {tail}
      {pending}
    </div>
  </div>;
}
