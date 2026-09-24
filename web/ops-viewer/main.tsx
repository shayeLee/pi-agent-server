import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "../src/components/Markdown";
import "./style.css";

type IpEntry = { ip: string; count: number };
type Session = { id: string; ip: string; title: string; createdAt: number; updatedAt: number };
type Message = { role: "user" | "assistant"; text: string };
type Detail = { session: Session; systemPrompt: string | null; messages: Message[] };

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
  return response.json() as Promise<T>;
}
const formatDate = (time: number) => new Date(time).toLocaleString("zh-CN");

function App() {
  const [ips, setIps] = useState<IpEntry[]>([]);
  const [ip, setIp] = useState("");
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
    void getJson<{ ips: IpEntry[] }>("/api/ips").then((result) => setIps(result.ips)).catch(() => setError("IP 列表读取失败"));
  }, []);

  async function loadSessions(targetIp: string, offset: number, version: number) {
    setLoadingSessions(true);
    try {
      const result = await getJson<{ total: number; sessions: Session[] }>(`/api/sessions?ip=${encodeURIComponent(targetIp)}&offset=${offset}`);
      if (version !== request.current) return;
      setTotal(result.total);
      setSessions((previous) => offset === 0 ? result.sessions : [...previous, ...result.sessions]);
    } catch {
      if (version === request.current) setError("会话列表读取失败");
    } finally {
      if (version === request.current) setLoadingSessions(false);
    }
  }

  function chooseIp(value: string) {
    const version = ++request.current;
    selectedId.current = "";
    setIp(value); setSessions([]); setTotal(0); setSelected(""); setDetail(null); setShowPrompt(false); setError("");
    void loadSessions(value, 0, version);
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
    <header className="top"><h1>会话记录</h1><span>按 IP 浏览 · 只读 · 用户、助手及系统提示词</span></header>
    <main className="layout">
      <section className="sidebar" aria-label="IP 地址"><h2>IP 地址</h2>
        {ips.length === 0 && <p className="hint">暂无会话</p>}
        {ips.map((row) => <button className={`item ${ip === row.ip ? "active" : ""}`} key={row.ip} onClick={() => chooseIp(row.ip)}>
          <strong>{row.ip}</strong><small>{row.count} 个会话</small>
        </button>)}
      </section>
      <section className="sidebar" aria-label="会话列表"><h2>{ip || "会话"}</h2>
        {sessions.map((session) => <button className={`item ${selected === session.id ? "active" : ""}`} key={session.id} onClick={() => void chooseSession(session)}>
          <strong>{session.title || "未命名会话"}</strong><small>{formatDate(session.updatedAt)}</small>
        </button>)}
        {sessions.length < total && <button className="more" disabled={loadingSessions} onClick={() => void loadSessions(ip, sessions.length, request.current)}>加载更多</button>}
        {ip && !sessions.length && !loadingSessions && <p className="hint">此 IP 暂无会话</p>}
      </section>
      <section className="content" aria-label="聊天内容"><h2>{detail?.session.title || "聊天内容"}</h2>
        {error && <p className="notice error" role="alert">{error}</p>}
        {loadingDetail && <p className="notice">加载中…</p>}
        {!detail && !loadingDetail && !error && <p className="notice">选择 IP 和会话以查看内容。</p>}
        {detail && <div className="conversation">
          <div className="prompt-panel"><button className="prompt-toggle" aria-expanded={showPrompt} onClick={() => setShowPrompt(!showPrompt)}>
            系统提示词 {showPrompt ? "▾" : "▸"}{detail.systemPrompt === null ? "（无记录）" : ""}
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
