import { useRef, useState } from "react";
import type { SessionRecord } from "pi-agent-server/client";

/** The active project's session rows and the local title/first-prompt metadata merged into them. */
export function useSessionList() {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const firstPromptsRef = useRef(new Map<string, string>());
  // null/undefined DTO summaries mean unknown, never proof of empty history.
  const emptyHistoryIdsRef = useRef(new Set<string>());
  const explicitTitlesRef = useRef(new Map<string, string>());
  // 快速切换项目时，旧会话请求的响应/错误不得覆盖当前项目状态。
  const sessionsRequestSeqRef = useRef(0);

  function mergeTitleMetadata(record: SessionRecord, protectExplicitTitle = false): SessionRecord {
    // Persisted summaries supersede local accepted-send fallbacks.
    if (record.firstPrompt != null) firstPromptsRef.current.set(record.id, record.firstPrompt);
    return { ...record, firstPrompt: firstPromptsRef.current.get(record.id) ?? record.firstPrompt,
      title: protectExplicitTitle ? explicitTitlesRef.current.get(record.id) ?? record.title : record.title };
  }
  function rememberAcceptedPrompt(sessionId: string, prompt: string): void {
    if (!emptyHistoryIdsRef.current.delete(sessionId)) return;
    rememberFirstPrompt(sessionId, prompt);
  }
  function rememberFirstPrompt(sessionId: string, prompt: string | null): void {
    if (prompt === null || firstPromptsRef.current.has(sessionId)) return;
    firstPromptsRef.current.set(sessionId, prompt);
    setSessions((previous) => previous?.map((row) => row.id === sessionId ? mergeTitleMetadata(row) : row) ?? null);
  }

  return {
    sessions,
    setSessions,
    emptyHistoryIdsRef,
    explicitTitlesRef,
    sessionsRequestSeqRef,
    mergeTitleMetadata,
    rememberAcceptedPrompt,
    rememberFirstPrompt,
  };
}

export type SessionList = ReturnType<typeof useSessionList>;
