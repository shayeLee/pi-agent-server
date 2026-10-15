import type { TimelineItem } from "pi-agent-server/client";
import { formatDateTime } from "../i18n/format.js";

/** Ledger grouping (DESIGN.md §4.1, §4.5). Pure: visibility only, never reorders items. */
export type WorkItem = Extract<TimelineItem, { kind: "tool" | "thinking" }>;
export type LedgerSegment =
  | { kind: "item"; item: TimelineItem }
  | { kind: "work"; id: string; items: WorkItem[] };
export type LedgerEntry = {
  id: string;
  role: "user" | "assistant" | "system";
  /** Time of the first item that carries one; never inferred from neighbours. */
  timestamp?: string;
  segments: LedgerSegment[];
};

const visible = (item: TimelineItem) => item.kind !== "thinking" || Boolean(item.text.trim());
const itemTime = (item: TimelineItem): string | undefined =>
  "timestamp" in item && typeof item.timestamp === "string" && item.timestamp ? item.timestamp : undefined;

export function groupLedger(timeline: readonly TimelineItem[], observed?: ReadonlyMap<string, string>): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  const timeOf = (item: TimelineItem) => itemTime(item) ?? observed?.get(item.id);
  let run: WorkItem[] = [];
  const flush = (entry: LedgerEntry | undefined) => {
    if (!entry || run.length === 0) return;
    // A run becomes a work block only when it contains a tool call; lone thinking stays inline.
    if (run.some(item => item.kind === "tool")) entry.segments.push({ kind: "work", id: `work:${run[0].id}`, items: run });
    else for (const item of run) entry.segments.push({ kind: "item", item });
    run = [];
  };
  for (const item of timeline) {
    if (!visible(item)) continue;
    const current = entries[entries.length - 1];
    const role = item.kind === "message" && item.role === "user" ? "user" : item.kind === "notification" ? "system" : "assistant";
    if (role !== "assistant" || current?.role !== "assistant") {
      flush(current);
      entries.push({ id: `entry:${item.id}`, role, timestamp: timeOf(item), segments: [] });
    }
    const entry = entries[entries.length - 1];
    entry.timestamp ??= timeOf(item);
    if (item.kind === "tool" || item.kind === "thinking") run.push(item);
    else { flush(entry); entry.segments.push({ kind: "item", item }); }
  }
  flush(entries[entries.length - 1]);
  return entries;
}

/** Wall time of a work block, only when the first and last steps carry real times. */
export function workDurationMs(items: readonly WorkItem[], observed?: ReadonlyMap<string, string>): number | null {
  const first = items[0];
  const last = items[items.length - 1];
  const start = first && Date.parse(itemTime(first) ?? observed?.get(first.id) ?? "");
  const end = last && Date.parse(itemTime(last) ?? observed?.get(last.id) ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const tail = last.kind === "tool" && last.call.done && typeof last.call.durationMs === "number" ? last.call.durationMs : 0;
  const total = end - start + tail;
  return total >= 0 ? total : null;
}

export function formatClock(timestamp: string | undefined): { text: string; title: string } | null {
  const date = timestamp ? new Date(timestamp) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return { text: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`, title: formatDateTime(date) };
}

/** Whitespace-normalised preview; the full original text stays in the expanded body. */
export function previewText(text: string, limit = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Custom event that asks an enclosing collapsed work block to reveal a step. */
export const LEDGER_REVEAL_EVENT = "ledger-reveal";

