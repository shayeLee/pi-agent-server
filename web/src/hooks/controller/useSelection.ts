import { useEffect, useRef, useState } from "react";
import { writeRecentSelection } from "../../recent-selection.js";

export type PendingRestore = { projectId: string; sessionId: string; revision: number };

/** Active project/session selection plus the revision counters that guard restore and creation ownership. */
export function useSelection() {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // 项目列表加载前不选项目；默认项目完全由服务端 isDefault 字段推导。
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  // Restore is invalidated by edits too; creation ownership changes only on navigation.
  const selectionRevisionRef = useRef(0);
  const navigationGenerationRef = useRef(0);
  const restoreAttemptedRef = useRef(false);
  const pendingRestoreRef = useRef<PendingRestore | null>(null);
  function rememberSelection(projectId: string, sessionId: string | null): void {
    ++navigationGenerationRef.current;
    ++selectionRevisionRef.current;
    pendingRestoreRef.current = null;
    writeRecentSelection(projectId, sessionId);
  }
  /** Draft edits invalidate a pending restore without changing navigation ownership. */
  function invalidateRestore(): void {
    ++selectionRevisionRef.current;
    pendingRestoreRef.current = null;
  }

  const currentScope = activeSessionId ? `session:${activeSessionId}` : `new:${activeProjectId ?? "none"}`;

  const activeSessionIdRef = useRef<string | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  useEffect(() => { activeProjectIdRef.current = activeProjectId; }, [activeProjectId]);
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSessionIdRef.current;
    if (prev && prev !== activeSessionId) {
      cancelRetries(prev);
    }
    prevSessionIdRef.current = activeSessionId;
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const retryTimersRef = useRef(new Map<ReturnType<typeof setTimeout>, string>());
  function cancelRetries(sessionId: string): void {
    for (const [timer, owner] of retryTimersRef.current) {
      if (owner !== sessionId) continue;
      clearTimeout(timer);
      retryTimersRef.current.delete(timer);
    }
  }
  useEffect(() => {
    const timers = retryTimersRef.current;
    return () => {
      for (const timer of timers.keys()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return {
    activeSessionId,
    setActiveSessionId,
    activeProjectId,
    setActiveProjectId,
    activeSessionIdRef,
    activeProjectIdRef,
    selectionRevisionRef,
    navigationGenerationRef,
    restoreAttemptedRef,
    pendingRestoreRef,
    currentScope,
    rememberSelection,
    invalidateRestore,
    cancelRetries,
  };
}

export type Selection = ReturnType<typeof useSelection>;
