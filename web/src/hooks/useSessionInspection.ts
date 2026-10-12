import { useEffect, useRef, useState } from "react";
import type { ApiClient, SessionStepsSnapshot, SessionSystemPrompt } from "pi-agent-server/client";
import type { InspectorTab } from "../components/Inspector.js";

type Result<T> = { sessionId: string | null; data: T | null; loading: boolean; error: string | null };

/** Read-only authority, separate from the chat store and its bounded event log. */
function useInspectionSnapshot<T>({ api, sessionId, enabled, refreshKey, interval, read, accept }: {
  api: ApiClient; sessionId: string | null; enabled: boolean; refreshKey: unknown; interval: number;
  read: (api: ApiClient, id: string) => Promise<T>;
  accept: (next: T, previous: T | null, id: string) => T;
}) {
  const [result, setResult] = useState<Result<T>>({ sessionId: null, data: null, loading: false, error: null });
  const authority = useRef<{ sessionId: string | null; data: T | null }>({ sessionId: null, data: null });
  // Even invalidated HTTP requests must finish before another request starts (no AbortClient required).
  const inFlight = useRef<Promise<void> | null>(null);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visibilityGeneration = 0;
    if (authority.current.sessionId !== sessionId) authority.current = { sessionId, data: null };
    setResult(previous => ({ sessionId, data: authority.current.data, loading: false,
      error: previous.sessionId === sessionId ? previous.error : null }));
    const valid = (generation: number) => current && generation === visibilityGeneration && !document.hidden;
    const run = async (generation: number) => {
      if (!sessionId || !enabled || !valid(generation)) return;
      if (inFlight.current) await inFlight.current;
      if (!valid(generation)) return;
      if (!authority.current.data) setResult(previous => ({ ...previous, loading: true }));
      const request = (async () => {
        try {
          const snapshot = await read(api, sessionId);
          if (!valid(generation)) return;
          const data = accept(snapshot, authority.current.data, sessionId);
          authority.current = { sessionId, data };
          setResult(previous => previous.data === data && !previous.error && !previous.loading ? previous
            : { sessionId, data, error: null, loading: false });
        } catch (error) {
          if (valid(generation)) setResult(previous => ({ ...previous, loading: false,
            error: error instanceof Error ? error.message : String(error) }));
        }
      })();
      inFlight.current = request;
      await request;
      if (inFlight.current === request) inFlight.current = null;
      if (valid(generation)) timer = setTimeout(() => void run(generation), interval);
    };
    const onVisibility = () => {
      ++visibilityGeneration;
      clearTimeout(timer);
      if (!document.hidden) void run(visibilityGeneration);
      else setResult(previous => previous.loading ? { ...previous, loading: false } : previous);
    };
    if (enabled && sessionId) {
      document.addEventListener("visibilitychange", onVisibility);
      void run(visibilityGeneration);
    }
    return () => {
      current = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [api, sessionId, enabled, refreshKey, interval, read, accept]);
  return result.sessionId === sessionId ? result : { sessionId, data: null, loading: false, error: null };
}

const readSteps = (api: ApiClient, id: string) => api.getSessionSteps(id);
const acceptSteps = (next: SessionStepsSnapshot, previous: SessionStepsSnapshot | null, id: string) => {
  if (next.sessionId !== id) throw new Error("步骤快照来源与当前会话不一致");
  if (previous?.projectionId === next.projectionId && next.revision <= previous.revision) return previous;
  return next;
};
const readPrompt = (api: ApiClient, id: string) => api.getSystemPrompt(id);
const acceptPrompt = (next: SessionSystemPrompt, previous: SessionSystemPrompt | null) =>
  previous?.source === next.source && previous.prompt === next.prompt ? previous : next;

export function useSessionInspection({ api, sessionId, visible, activeTab, refreshKey }: {
  api: ApiClient; sessionId: string | null; visible: boolean; activeTab: InspectorTab; refreshKey?: unknown;
}) {
  const steps = useInspectionSnapshot({ api, sessionId, enabled: visible && activeTab === "steps",
    refreshKey, interval: 500, read: readSteps, accept: acceptSteps });
  const prompt = useInspectionSnapshot({ api, sessionId, enabled: visible && activeTab === "systemPrompt",
    refreshKey, interval: 1000, read: readPrompt, accept: acceptPrompt });
  return { steps: steps.data, stepsLoading: steps.loading, stepsError: steps.error,
    systemPrompt: prompt.data, systemPromptLoading: prompt.loading, systemPromptError: prompt.error };
}
