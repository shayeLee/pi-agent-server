import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Icon } from "../src/components/Icon.js";
import { Markdown } from "../src/components/Markdown";
import "./style.css";

/** `owner` is an opaque id; `label` is what people read (an IP, or an account name). */
type OwnerEntry = { owner: string; kind: "ip" | "account"; label: string; count: number };
type Session = { id: string; owner: string; title: string; createdAt: number; updatedAt: number };
type Message = { role: "user" | "assistant"; text: string };
type Detail = { session: Session; systemPrompt: string | null; messages: Message[] };

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
  return response.json() as Promise<T>;
}
const formatDate = (time: number) => new Date(time).toLocaleString("zh-CN");

function App() {
  const [owners, setOwners] = useState<OwnerEntry[]>([]);
  const [owner, setOwner] = useState<OwnerEntry | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [error, setError] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const request = useRef(0);

  useEffect(() => {
    void getJson<{ owners: OwnerEntry[] }>("/api/owners").then((result) => setOwners(result.owners)).catch(() => setError("用户列表读取失败"));
  }, []);

  async function loadSessions(target: string, offset: number, version: number) {
    setLoadingSessions(true);
    try {
      const result = await getJson<{ total: number; sessions: Session[] }>(`/api/sessions?owner=${encodeURIComponent(target)}&offset=${offset}`);
      if (version !== request.current) return;
      setTotal(result.total);
      setSessions((previous) => offset === 0 ? result.sessions : [...previous, ...result.sessions]);
    } catch {
      if (version === request.current) setError("会话列表读取失败");
    } finally {
      if (version === request.current) setLoadingSessions(false);
    }
  }

  function chooseOwner(value: OwnerEntry) {
    const version = ++request.current;
    selectedId.current = "";
    setOwner(value); setSessions([]); setTotal(0); setSelected(""); setDetail(null); setShowPrompt(false); setError("");
    void loadSessions(value.owner, 0, version);
  }

  async function chooseSession(session: Session) {
    selectedId.current = session.id;
    setSelected(session.id); setDetail(null); setShowPrompt(false); setLoadingDetail(true); setError("");
    const version = request.current;
    try {
      const result = await getJson<Detail>(`/api/sessions/${encodeURIComponent(session.id)}`);
      if (version === request.current && session.id === selectedId.current) setDetail(result);
    } catch {
      if (version === request.current && session.id === selectedId.current) setError("会话内容读取失败");
    } finally {
      if (version === request.current && session.id === selectedId.current) setLoadingDetail(false);
    }
  }
  const selectedId = useRef("");
  selectedId.current = selected;

  return <>
    <header className="top"><h1>会话记录</h1><span>按用户浏览 · 只读 · 用户、助手及系统提示词</span></header>
    <main className="layout">
      <section className="sidebar" aria-label="用户"><h2>用户</h2>
        {owners.length === 0 && <p className="hint">暂无会话</p>}
        {owners.map((row) => <button className={`item ${owner?.owner === row.owner ? "active" : ""}`} key={row.owner} title={row.owner} onClick={() => chooseOwner(row)}>
          <strong>{row.label}</strong><small>{row.kind === "account" ? "账号" : "IP"} · {row.count} 个会话</small>
        </button>)}
      </section>
      <section className="sidebar" aria-label="会话列表"><h2>{owner?.label || "会话"}</h2>
        {sessions.map((session) => <button className={`item ${selected === session.id ? "active" : ""}`} key={session.id} onClick={() => void chooseSession(session)}>
          <strong>{session.title || "未命名会话"}</strong><small>{formatDate(session.updatedAt)}</small>
        </button>)}
        {sessions.length < total && <button className="more" disabled={loadingSessions} onClick={() => owner && void loadSessions(owner.owner, sessions.length, request.current)}>加载更多</button>}
        {owner && !sessions.length && !loadingSessions && <p className="hint">此用户暂无会话</p>}
      </section>
      <section className="content" aria-label="聊天内容"><h2>{detail?.session.title || "聊天内容"}</h2>
        {error && <p className="notice error" role="alert">{error}</p>}
        {loadingDetail && <p className="notice">加载中…</p>}
        {!detail && !loadingDetail && !error && <p className="notice">选择用户和会话以查看内容。</p>}
        {detail && <div className="conversation">
          <div className="prompt-panel"><button className="prompt-toggle" aria-expanded={showPrompt} onClick={() => setShowPrompt(!showPrompt)}>
            系统提示词 <Icon name={showPrompt ? "down" : "chevron"} />{detail.systemPrompt === null ? "（无记录）" : ""}
          </button>
            {showPrompt && <div className="prompt-body">{detail.systemPrompt ? <Markdown text={detail.systemPrompt} /> : <p>该会话没有保存系统提示词。</p>}</div>}
          </div>
          {detail.messages.length === 0 && <p className="notice">此会话没有可展示的聊天文本。</p>}
          {detail.messages.map((message, index) => <article className={`message ${message.role}`} key={index}>
            <div className="speaker">{message.role === "user" ? "用户" : "助手"}</div>
            <Markdown text={message.text} />
          </article>)}
        </div>}
      </section>
    </main>
  </>;
}

createRoot(document.getElementById("root")!).render(<App />);
