import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ApiClient, ApiError } from "./lib/api.js";
import { createSseConnection } from "./lib/sse-client.js";
import { applySseEvent, addUserMessage, createChatState } from "./lib/chat-state.js";
import type { ChatState } from "./lib/chat-state.js";
import type { SessionRecord } from "./types.js";
import { SessionList } from "./components/SessionList.js";
import { Chat } from "./components/Chat.js";

/**
 * 顶层状态机：
 * 未填 token → token 输入（仅内存）→ 加载会话列表 → 选中会话进入聊天并订阅 SSE。
 */
export default function App() {
  // token 输入草稿与已提交值分离：只有提交后才创建 ApiClient。
  const [tokenDraft, setTokenDraft] = useState("");
  // token 为 null 表示「探测内网中」；探测成功置 ""（内网免登录）；失败进入 token 输入（公网）
  const [token, setToken] = useState<string | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [chatState, setChatState] = useState<ChatState>(createChatState);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 保存最新 activeSessionId 供异步回调比对，避免跨会话回滚/报错
  const activeSessionIdRef = useRef<string | null>(null);
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSessionIdRef.current;
    if (prev && prev !== activeSessionId) {
      // 离开旧会话：清理其确认前缀（旧 SSE 已关闭，终态不会再抵达）
      for (const key of [...confirmedRequestsRef.current]) {
        if (key.startsWith(`${prev}:`)) confirmedRequestsRef.current.delete(key);
      }
    }
    prevSessionIdRef.current = activeSessionId;
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  // 重试定时器集合：组件卸载时统一清理，避免卸载后继续发请求/ setState
  const retryTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = retryTimersRef.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // 已收到服务端确认的 `${sessionId}:${requestId}`（SSE queued/status 事件携带），
  // 用于区分本地乐观排队与服务端已确认，按会话隔离避免跨会话冲突
  const confirmedRequestsRef = useRef(new Set<string>());

  // token 只保存在内存（不落 localStorage）。
  const api = useMemo(() => (token !== null ? new ApiClient("", token) : null), [token]);

  // 探测内网：无 token 能访问会话列表则免登录；否则需要 token（公网）
  useEffect(() => {
    let cancelled = false;
    new ApiClient("", "")
      .listSessions()
      .then(() => {
        if (!cancelled) setToken("");
      })
      .catch(() => {
        if (!cancelled) setNeedToken(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshSessions(): Promise<void> {
    if (!api) return;
    try {
      setLoadError(null);
      setSessions(await api.listSessions());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  // token 确定后加载会话列表。
  useEffect(() => {
    if (api) void refreshSessions();
  }, [api]);

  // 选中会话后：先加载历史快照（含事件 cursor），再按 cursor 订阅增量，避免重复/覆盖。
  useEffect(() => {
    if (!api || !activeSessionId) return;
    setChatState(createChatState());
    let cancelled = false;
    let connection: { close: () => void } | null = null;

    void (async () => {
      // 先拉历史快照 + 事件 cursor（export 返回 { messages, lastEventId }）
      let cursor = 0;
      try {
        const data = (await api.exportSession(activeSessionId)) as {
          messages?: unknown;
          lastEventId?: number;
        };
        if (cancelled) return;
        const messages = data?.messages ?? data;
        const history = (Array.isArray(messages) ? messages : [])
          .filter(
            (m): m is { role: string; text: string } =>
              typeof m === "object" &&
              m !== null &&
              typeof (m as { text?: unknown }).text === "string",
          )
          .map((m, i) => ({
            id: `hist-${i}`,
            role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
            text: m.text,
          }));
        if (history.length > 0) {
          setChatState((prev) => ({ ...prev, messages: history }));
        }
        if (typeof data?.lastEventId === "number") cursor = data.lastEventId;
      } catch {
        // 导出失败仅影响历史展示，不阻塞后续 SSE 订阅
      }
      if (cancelled) return;

      // 按快照 cursor 订阅增量（> cursor），避免从头补发重复历史
      connection = createSseConnection({
        url: `/v1/sessions/${activeSessionId}/events`,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        lastEventId: cursor,
        onEvent: (event) => {
          // 服务端确认（queued/status 携带 requestId）：标记，避免其后 HTTP 响应丢失导致误回滚
          if ((event.type === "queued" || event.type === "status") && event.requestId) {
            confirmedRequestsRef.current.add(`${activeSessionId}:${event.requestId}`);
          }
          // 任务终态：清理本会话的确认记录（任务已结束，不再需要）
          if (event.type === "completed" || event.type === "error" || event.type === "aborted") {
            for (const key of [...confirmedRequestsRef.current]) {
              if (key.startsWith(`${activeSessionId}:`)) confirmedRequestsRef.current.delete(key);
            }
          }
          setChatState((prev) => applySseEvent(prev, event));
        },
      });
    })();

    return () => {
      cancelled = true;
      connection?.close();
    };
  }, [api, activeSessionId, token]);

  function handleTokenSubmit(e: FormEvent): void {
    e.preventDefault();
    const value = tokenDraft.trim();
    if (!value) return;
    setToken(value);
    setTokenDraft("");
  }

  function handleSelect(id: string): void {
    setActiveSessionId(id);
  }

  async function handleCreate(): Promise<void> {
    if (!api) return;
    const session = await api.createSession();
    setSessions((prev) => [...(prev ?? []), session]);
    setActiveSessionId(session.id);
  }

  async function handleDelete(id: string): Promise<void> {
    if (!api) return;
    await api.deleteSession(id);
    setSessions((prev) => (prev ?? []).filter((s) => s.id !== id));
    if (id === activeSessionId) setActiveSessionId(null);
    // 清理该会话的确认记录（无终态事件会再抵达）
    for (const key of [...confirmedRequestsRef.current]) {
      if (key.startsWith(`${id}:`)) confirmedRequestsRef.current.delete(key);
    }
  }

  async function handleRename(id: string, title: string): Promise<void> {
    if (!api) return;
    const updated = await api.renameSession(id, title);
    setSessions((prev) => (prev ?? []).map((s) => (s.id === id ? updated : s)));
  }

  /** 控制请求（steer/abort）失败：仅展示错误，不回滚 phase（服务端任务仍在运行，phase 保持）。 */
  function reportChatError(sid: string, err: unknown): void {
    if (activeSessionIdRef.current !== sid) return; // 已切换会话：不展示旧会话错误
    setChatState((prev) => ({
      ...prev,
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  /** 消息提交失败：仅当该消息仍是最后一条待确认乐观消息且服务端未确认时回滚；否则整体 no-op。 */
  function reportSendError(sid: string, requestId: string, messageId: string, err: unknown): void {
    if (activeSessionIdRef.current !== sid) return; // 已切换会话：不回滚新会话状态
    if (confirmedRequestsRef.current.has(`${sid}:${requestId}`)) return; // 服务端已确认：不回滚
    setChatState((prev) => {
      const last = prev.messages[prev.messages.length - 1];
      const isPending = last?.id === messageId && prev.phase === "queued";
      if (!isPending) {
        // 已非待确认消息：整体 no-op，不删消息也不写错误（旧请求错误不污染当前状态）
        return prev;
      }
      return {
        ...prev,
        messages: prev.messages.filter((m) => m.id !== messageId),
        phase: "idle",
        error: err instanceof Error ? err.message : String(err),
      };
    });
  }

  function handleSend(text: string): void {
    if (!api || !activeSessionId) return;
    const sid = activeSessionId;
    const messageId = `user-${crypto.randomUUID()}`;
    setChatState((prev) => addUserMessage(prev, text, messageId));
    const requestId = crypto.randomUUID();
    sendWithRetry(sid, requestId, messageId, text, 0);
  }

  /** 幂等重试确认：传输失败/5xx 用同一 requestId 重试（服务端幂等保证不重复执行）；
   * 4xx 表示明确拒绝（409=其他任务冲突或 poisoned，400/404/429=真拒绝）→ 回滚。 */
  function sendWithRetry(
    sid: string,
    requestId: string,
    messageId: string,
    text: string,
    attempt: number,
  ): void {
    api!.sendMessage(sid, { requestId, prompt: text }).catch((err) => {
      if (err instanceof ApiError && err.status < 500) {
        // 明确拒绝（4xx）→ 回滚
        reportSendError(sid, requestId, messageId, err);
        return;
      }
      // 网络传输失败或 5xx：幂等重试（已接受则返回 202/200；未收到则重试真正提交）
      if (attempt < 3) {
        const timer = setTimeout(
          () => sendWithRetry(sid, requestId, messageId, text, attempt + 1),
          1000,
        );
        retryTimersRef.current.add(timer);
      } else {
        reportSendError(sid, requestId, messageId, err);
      }
    });
  }

  function handleSteer(text: string): void {
    if (!api || !activeSessionId) return;
    const sid = activeSessionId;
    api.steer(sid, text).catch((err) => reportChatError(sid, err));
  }

  function handleAbort(): void {
    if (!api || !activeSessionId) return;
    const sid = activeSessionId;
    api.abort(sid).catch((err) => reportChatError(sid, err));
  }

  if (token === null && !needToken) {
    return (
      <main>
        <h1>pi-server 控制台</h1>
        <div data-testid="auth-probing">检测访问方式…</div>
      </main>
    );
  }

  if (!api) {
    return (
      <main>
        <h1>pi-server 控制台</h1>
        <form onSubmit={handleTokenSubmit}>
          <label htmlFor="token-input">token</label>
          <input
            id="token-input"
            data-testid="token-input"
            type="password"
            aria-label="token"
            placeholder="输入访问 token（仅保存在内存）"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
          />
          <button type="submit" data-testid="token-submit">
            进入
          </button>
        </form>
      </main>
    );
  }

  const activeSession = sessions?.find((s) => s.id === activeSessionId) ?? null;
  const streaming = chatState.phase === "streaming" || chatState.phase === "queued";
  const queued = chatState.phase === "queued";

  return (
    <main data-testid="app">
      <h1>pi-server 控制台</h1>
      {sessions === null ? (
        <div data-testid="sessions-loading">加载会话中…</div>
      ) : (
        <>
          <SessionList
            sessions={sessions}
            activeId={activeSessionId}
            onSelect={handleSelect}
            onCreate={handleCreate}
            onDelete={handleDelete}
            onRename={handleRename}
          />
          {loadError && <div data-testid="load-error">{loadError}</div>}
          {activeSession ? (
            <section data-testid="chat-view">
              <h2>{activeSession.title}</h2>
              {chatState.phase === "queued" && <div data-testid="phase-queued">排队中…</div>}
              {chatState.error && <div data-testid="phase-error">{chatState.error}</div>}
              <Chat
                messages={chatState.messages}
                toolCalls={chatState.toolCalls}
                streaming={streaming}
                queued={queued}
                onSend={handleSend}
                onSteer={handleSteer}
                onAbort={handleAbort}
              />
            </section>
          ) : (
            <div data-testid="no-session-hint">选择或新建一个会话开始聊天</div>
          )}
        </>
      )}
    </main>
  );
}