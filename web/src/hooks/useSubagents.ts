import { useEffect, useState } from "react";
import type { ApiClient, SubagentSnapshot } from "pi-agent-server/client";

/** Sequential polling also covers children finishing while the parent is idle. */
export function useSubagents(api: ApiClient, sessionId: string | null, runId: string | null, visible: boolean) {
  const [state, setState] = useState<{ sessionId: string | null; runId: string | null; data: SubagentSnapshot | null; error: string | null }>({ sessionId: null, runId: null, data: null, error: null });
  useEffect(() => {
    let disposed = false, busy = false;
    let cached: SubagentSnapshot | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      if (disposed || busy || !sessionId || document.hidden) return;
      busy = true;
      try {
        let data = await api.getSubagents(sessionId);
        if (data.sessionId !== sessionId) throw new Error("子代理记录与当前会话不匹配");
        const run = data.runs.find(r => r.id === runId);
        const old = cached?.conversation?.run;
        if (run && (!old || old.id !== run.id || old.revision !== run.revision || old.streamRevision !== run.streamRevision || old.status !== run.status)) {
          data = await api.getSubagents(sessionId, runId!);
          if (data.sessionId !== sessionId || (data.conversation && data.conversation.run.id !== runId)) throw new Error("子代理记录与当前会话不匹配");
        } else if (run && cached?.conversation) data = { ...data, conversation: cached.conversation };
        cached = data;
        if (!disposed) setState({ sessionId, runId, data, error: null });
      } catch (error) {
        if (!disposed) setState(old => ({ sessionId, runId, data: old.sessionId === sessionId && old.runId === runId ? old.data : null,
          error: error instanceof Error ? error.message : String(error) }));
      } finally {
        busy = false;
        if (!disposed) timer = setTimeout(() => void read(), visible || runId ? 1000 : 5000);
      }
    };
    const wake = () => { clearTimeout(timer); if (!document.hidden) void read(); };
    void read(); document.addEventListener("visibilitychange", wake);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", wake); };
  }, [api, sessionId, runId, visible]);
  const matches = state.sessionId === sessionId;
  return { runs: matches ? state.data?.runs ?? [] : [],
    conversation: matches && state.runId === runId ? state.data?.conversation ?? null : null,
    loading: !matches || state.runId !== runId || (!state.data && !state.error), error: matches ? state.error : null };
}
