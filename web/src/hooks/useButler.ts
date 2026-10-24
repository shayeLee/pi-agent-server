import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, SseHttpError, createChatStore, createSseConnection, type ApiClient, type ChatState, type SessionRecord, type SseEvent } from "pi-agent-server/client";
import { projectExportTimeline, projectLegacyHistory } from "./history-projection.js";
import { zhCN } from "../i18n/zh-CN.js";

/**
 * `unavailable`: not an admin, or a server without butlers (403/404); the panel shows only the
 * activity lists. `ready` with no session: nobody has talked to the butler yet.
 */
export type ButlerAvailability = "loading" | "ready" | "unavailable";
/** `busy`: the server refused another stream (429); the panel says so instead of retrying. */
export type ButlerConnection = "idle" | "connecting" | "open" | "reconnecting" | "busy";

export type Butler = {
  availability: ButlerAvailability;
  session: SessionRecord | null;
  state: ChatState;
  connection: ButlerConnection;
  /** A failed send or reset, in words for the panel. */
  error: string | null;
  send: (text: string) => Promise<boolean>;
  abort: () => void;
  reset: () => Promise<void>;
};

const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const messageOf = (error: unknown) => error instanceof Error && error.message ? error.message : zhCN.butler.sendFailed;

/**
 * The butler conversation beside the page (docs/companion-butler.md §12.6): its own chat store
 * and its own event stream, connected only while the panel is open, so a closed panel keeps the
 * page at its usual two streams.
 */
export function useButler(options: { api: ApiClient; open: boolean; authGeneration?: number; onAuthExpired?: () => void }): Butler {
  const { api, open, authGeneration, onAuthExpired } = options;
  const [availability, setAvailability] = useState<ButlerAvailability>("loading");
  const [session, setSession] = useState<SessionRecord | null>(null);
  const storeRef = useRef(createChatStore());
  const [state, setState] = useState<ChatState>(() => storeRef.current.getState());
  const [connection, setConnection] = useState<ButlerConnection>("idle");
  const [error, setError] = useState<string | null>(null);
  /** Made here just now: no history to load, and its stream starts from the first event. */
  const freshRef = useRef<string | null>(null);
  const asked = useRef(false);

  useEffect(() => storeRef.current.subscribe(setState), []);

  // Who the butler is, asked the first time the panel opens (and again after a new login).
  useEffect(() => { asked.current = false; setAvailability("loading"); setSession(null); storeRef.current.reset(); }, [authGeneration]);
  useEffect(() => {
    if (!open || asked.current) return;
    asked.current = true;
    api.getButler().then(
      result => { setSession(result.session); setAvailability("ready"); },
      failure => {
        if (failure instanceof ApiError && (failure.status === 403 || failure.status === 404)) setAvailability("unavailable");
        else { asked.current = false; setAvailability("ready"); setError(messageOf(failure)); }
      });
  }, [open, api, authGeneration]);

  const sessionId = session?.id ?? null;
  useEffect(() => {
    if (!open || !sessionId) return;
    const store = storeRef.current;
    let cancelled = false;
    let stream: { close: () => void } | null = null;
    setConnection("connecting");
    void (async () => {
      let cursor = 0;
      if (freshRef.current !== sessionId) {
        // Reopening reloads the conversation: it is short, and this keeps no stale cursor.
        store.reset();
        try {
          const data = await api.exportSession(sessionId) as { messages?: unknown; timeline?: unknown; lastEventId?: number };
          if (cancelled) return;
          const messages = Array.isArray(data?.messages) ? data.messages : [];
          const history = Array.isArray(data?.timeline) && data.timeline.length ? projectExportTimeline(data.timeline, messages) : projectLegacyHistory(messages);
          if (history.length) store.restoreHistory(history);
          if (typeof data?.lastEventId === "number") cursor = data.lastEventId;
        } catch (failure) {
          if (cancelled) return;
          if (failure instanceof ApiError && (failure.status === 403 || failure.status === 404)) { setSession(null); setConnection("idle"); return; }
        }
      }
      if (cancelled) return;
      stream = createSseConnection<SseEvent>({
        url: `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
        lastEventId: cursor,
        onOpen: () => { if (!cancelled) setConnection("open"); },
        onEvent: event => { if (!cancelled) store.applyEvent(event); },
        onDisconnect: () => { if (!cancelled) { store.markDisconnected(); setConnection("reconnecting"); } },
        onError: failure => {
          if (cancelled) return;
          if (failure instanceof SseHttpError && failure.status === 429) { stream?.close(); setConnection("busy"); }
          else setConnection("reconnecting");
        },
        onNoLiveStream: () => { if (!cancelled) setConnection("open"); },
        ...(onAuthExpired ? { onAuthExpired: () => { if (!cancelled) { setConnection("idle"); onAuthExpired(); } } } : {}),
      });
    })();
    return () => {
      cancelled = true;
      stream?.close();
      store.markDisconnected();
      setConnection("idle");
      if (freshRef.current === sessionId) freshRef.current = null;
    };
  }, [open, sessionId, api, authGeneration]);

  const send = useCallback(async (text: string) => {
    const prompt = text.trim();
    if (!prompt) return false;
    setError(null);
    let target = session;
    const store = storeRef.current;
    try {
      if (!target) {
        target = (await api.ensureButler()).session;
        freshRef.current = target.id;
        store.reset();
        setSession(target);
      }
      const requestId = newId();
      const messageId = `butler-${requestId}`;
      store.addUserMessage(prompt, messageId, requestId);
      try {
        await api.sendMessage(target.id, { requestId, prompt });
      } catch (failure) {
        store.rollbackUserMessage(messageId, messageOf(failure));
        throw failure;
      }
      return true;
    } catch (failure) {
      setError(messageOf(failure));
      return false;
    }
  }, [api, session]);

  const abort = useCallback(() => {
    if (!session) return;
    storeRef.current.clearModelOutput();
    api.abort(session.id).catch(failure => setError(messageOf(failure)));
  }, [api, session]);

  const reset = useCallback(async () => {
    setError(null);
    try {
      const next = (await api.ensureButler({ reset: true })).session;
      freshRef.current = next.id;
      storeRef.current.reset();
      setSession(next);
    } catch (failure) { setError(messageOf(failure)); }
  }, [api]);

  return { availability, session, state, connection, error, send, abort, reset };
}
