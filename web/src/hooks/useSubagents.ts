import { useEffect, useRef, useState } from "react";
import type { ApiClient, SubagentConversation, SubagentSnapshot } from "pi-agent-server/client";
import { latestReply, recentActions, type LiveSubagent } from "./useLiveSubagents.js";

/** Running runs shown inline while the parent turn streams (DESIGN.md §4.7). */
const MAX_LIVE_RUNS = 3;

export type SubagentFeedOptions = {
  /** Run whose read-only conversation is open, if any. */
  runId: string | null;
  /** The Inspector's Subagents tab is on screen. */
  visible: boolean;
  /** The parent turn is streaming: feed the inline live panel too. */
  live: boolean;
  /** Latest `subagents_changed` position for this session (server push). */
  signal?: string | null;
};

/** A failed read is retried at this pace. */
export const RETRY_MS = 1000;
/**
 * Safety net for agent-team builds that emit no transcript events: while a child still runs and no
 * signal arrived for this long, read once. With current builds every change is signalled first.
 */
export const WATCHDOG_MS = 15_000;

/**
 * The one source of subagent data for a session: the Inspector list, the open read-only
 * conversation and the inline live panel share each list read and each per-run detail read.
 * Reads when the session, selected run, tab visibility or live state changes, and whenever the
 * server pushes `subagents_changed`; it never polls on a timer, apart from retrying a failed read
 * and the watchdog above.
 */
export function useSubagents(api: ApiClient, sessionId: string | null, { runId, visible, live, signal = null }: SubagentFeedOptions) {
  const [state, setState] = useState<{ sessionId: string | null; runId: string | null; data: SubagentSnapshot | null; live: LiveSubagent[]; error: string | null }>(
    { sessionId: null, runId: null, data: null, live: [], error: null });
  // Per-run detail survives signals (each signal re-runs the effect); it resets with the session.
  const detailCache = useRef<{ sessionId: string | null; details: Map<string, { key: string; conversation: SubagentConversation | null }> }>({ sessionId: null, details: new Map() });
  if (detailCache.current.sessionId !== sessionId) detailCache.current = { sessionId, details: new Map() };
  useEffect(() => {
    let disposed = false, busy = false;
    let latest: SubagentSnapshot | null = null;
    let timer: ReturnType<typeof setTimeout>;
    // Per-run detail, refetched only when the run's revision, stream revision or status moves.
    const details = detailCache.current.details;
    const detail = async (run: SubagentSnapshot["runs"][number]) => {
      const key = `${run.revision}:${run.streamRevision ?? ""}:${run.status}`;
      const cached = details.get(run.id);
      if (cached?.key === key) return cached.conversation;
      const data = await api.getSubagents(sessionId!, run.id);
      if (data.sessionId !== sessionId || (data.conversation && data.conversation.run.id !== run.id)) throw new Error("子代理记录与当前会话不匹配");
      details.set(run.id, { key, conversation: data.conversation ?? null });
      return data.conversation ?? null;
    };
    const read = async () => {
      if (disposed || busy || !sessionId || document.hidden) return;
      busy = true;
      try {
        const list = await api.getSubagents(sessionId);
        if (list.sessionId !== sessionId) throw new Error("子代理记录与当前会话不匹配");
        const selected = list.runs.find(r => r.id === runId);
        const conversation = selected ? await detail(selected) : null;
        const items: LiveSubagent[] = [];
        if (live) for (const run of list.runs.filter(r => r.status === "running").slice(0, MAX_LIVE_RUNS)) {
          const child = await detail(run);
          const reply = child ? latestReply(child.timeline) : undefined;
          items.push({ run, actions: child ? recentActions(child.timeline) : [], ...(reply ? { reply } : {}) });
        }
        latest = list;
        if (!disposed) setState({ sessionId, runId, data: conversation ? { ...list, conversation } : list, live: items, error: null });
      } catch (error) {
        latest = null;
        if (!disposed) setState(old => ({ sessionId, runId, data: old.sessionId === sessionId && old.runId === runId ? old.data : null,
          live: old.sessionId === sessionId ? old.live : [], error: error instanceof Error ? error.message : String(error) }));
      } finally {
        busy = false;
        if (disposed) return;
        if (latest === null) timer = setTimeout(() => void read(), RETRY_MS);
        else if (latest.runs.some(run => run.status === "running")) timer = setTimeout(() => void read(), WATCHDOG_MS);
      }
    };
    const wake = () => { clearTimeout(timer); if (!document.hidden) void read(); };
    void read(); document.addEventListener("visibilitychange", wake);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", wake); };
  }, [api, sessionId, runId, visible, live, signal]);
  const matches = state.sessionId === sessionId;
  return { runs: matches ? state.data?.runs ?? [] : [],
    conversation: matches && state.runId === runId ? state.data?.conversation ?? null : null,
    /** Running children for the inline panel; empty unless the parent turn is streaming. */
    live: matches && live ? state.live : [],
    loading: !matches || state.runId !== runId || (!state.data && !state.error), error: matches ? state.error : null };
}
