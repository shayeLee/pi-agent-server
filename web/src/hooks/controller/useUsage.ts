import { useRef, useState } from "react";
import type { ChatState, UsageSnapshot } from "pi-agent-server/client";

/** Persisted usage snapshots and context invalidation layered over live chat stats. */
export function useUsage() {
  const [usageSnapshots, setUsageSnapshots] = useState<Record<string, UsageSnapshot | undefined>>({});
  const [invalidContexts, setInvalidContexts] = useState<ReadonlySet<string>>(new Set());
  const usageRevisionRef = useRef(new Map<string, number>());
  function invalidateContext(id: string): void {
    usageRevisionRef.current.set(id, (usageRevisionRef.current.get(id) ?? 0) + 1);
    setInvalidContexts(previous => new Set([...previous, id]));
    setUsageSnapshots(previous => ({ ...previous, [id]: undefined }));
  }
  function usageRevision(sessionId: string): number {
    return usageRevisionRef.current.get(sessionId) ?? 0;
  }
  function restoreExportedUsage(sessionId: string, snapshot: UsageSnapshot | undefined): void {
    setUsageSnapshots(previous => ({ ...previous, [sessionId]: snapshot ?? {} }));
    if (snapshot) setInvalidContexts(previous => { const next = new Set(previous); next.delete(sessionId); return next; });
  }
  /** Live usage supersedes the persisted snapshot; a usage event also re-validates context. */
  function supersedeSnapshot(sessionId: string, contextReported: boolean): void {
    setUsageSnapshots(previous => ({ ...previous, [sessionId]: undefined }));
    if (contextReported) setInvalidContexts(previous => { const next = new Set(previous); next.delete(sessionId); return next; });
  }
  function visibleChatState(rawChatState: ChatState, activeSessionId: string | null): ChatState {
    const snapshot = activeSessionId ? usageSnapshots[activeSessionId] : undefined;
    const visibleStats = snapshot ? {
      durationMs: NaN, ttftMs: NaN, promptTokens: null, completionTokens: null, totalTokens: null,
      ...snapshot,
      execution: rawChatState.stats?.execution ?? snapshot.execution,
    } : rawChatState.stats;
    return { ...rawChatState, stats: visibleStats && activeSessionId && invalidContexts.has(activeSessionId)
      ? { ...visibleStats, context: null } : visibleStats };
  }

  return { invalidateContext, usageRevision, restoreExportedUsage, supersedeSnapshot, visibleChatState };
}

export type Usage = ReturnType<typeof useUsage>;
