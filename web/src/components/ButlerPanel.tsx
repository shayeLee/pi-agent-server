import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { ActivityResult, ActivityRun } from "pi-agent-server/client";
import { zhCN } from "../i18n/zh-CN.js";
import { Icon } from "./Icon.js";
import { Timeline } from "./Timeline.js";
import type { NotifyPermission } from "../hooks/useRunNotifications.js";
import type { Butler } from "../hooks/useButler.js";
import { accountScopedKey } from "../auth/storage-scope.js";

/** Rows per list; the butler can tell about the rest. */
const LIST_ROWS = 5;
const DRAFT_KEY = "pi:butler-draft";
const SESSION_LINK = /^\/p\/([^/]+)\/s\/([^/?#]+)$/;

export type ButlerPanelProps = {
  name: string;
  running: ReadonlyMap<string, ActivityRun>;
  recent: readonly ActivityResult[];
  onOpen: (projectId: string, sessionId: string) => void;
  notify: { enabled: boolean; permission: NotifyPermission; toggle: (next: boolean) => void };
  butler: Butler;
  onClose: () => void;
};

function readDraft(): string {
  try { return localStorage.getItem(accountScopedKey(DRAFT_KEY)) ?? ""; } catch { return ""; }
}
function writeDraft(text: string): void {
  try {
    if (text) localStorage.setItem(accountScopedKey(DRAFT_KEY), text);
    else localStorage.removeItem(accountScopedKey(DRAFT_KEY));
  } catch { /* Storage is optional. */ }
}

/**
 * The right-hand panel behind "运行动态" (docs/companion-butler.md §12.6): what runs and how recent
 * runs ended, then the conversation with the butler. Without a butler (not an admin, an older
 * server) it is the lists alone. It shares the trace's column; one closes the other.
 */
export function ButlerPanel({ name, running, recent, onOpen, notify, butler, onClose }: ButlerPanelProps) {
  const runs = [...running.values()].sort((a, b) => b.startedAt - a.startedAt);
  const title = (value: string) => value || zhCN.companion.untitled;
  const [text, setText] = useState(readDraft);
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { state } = butler;
  const live = state.phase === "submitting" || state.phase === "queued" || state.phase === "streaming";
  const notifyBlocked = notify.permission === "unsupported" || notify.permission === "insecure" || (notify.permission === "denied" && !notify.enabled);

  useEffect(() => { writeDraft(text); }, [text]);
  // Follow the reply while it is written.
  useEffect(() => { const body = bodyRef.current; if (body) body.scrollTop = body.scrollHeight; }, [state.timeline]);

  const submit = async () => {
    if (sending || live || !text.trim()) return;
    setSending(true);
    const sent = await butler.send(text);
    setSending(false);
    if (sent) setText("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
  };
  // Session links in replies open the session in the page instead of reloading it.
  const onBodyClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest("a");
    const match = anchor && SESSION_LINK.exec(anchor.getAttribute("href") ?? "");
    if (!match || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onOpen(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!));
  };

  return <aside id="butler-panel" className="inspector butler-panel" data-testid="butler-panel" aria-label={zhCN.butler.panel}>
    <header className="butler-head">
      <h2 className="butler-title">{zhCN.companion.activityIdle}</h2>
      <label className="butler-notify" title={zhCN.companion.notify}>
        <input type="checkbox" data-testid="activity-notify" checked={notify.enabled} disabled={notifyBlocked}
          onChange={event => notify.toggle(event.target.checked)} />
        <span>{zhCN.butler.notifyShort}</span>
      </label>
      <button type="button" className="btn-ghost btn-icon" data-testid="butler-close" aria-label={zhCN.butler.close} title={zhCN.butler.close} onClick={onClose}>
        <Icon name="close" />
      </button>
    </header>
    {notify.permission === "denied" && <p className="activity-notify-hint">{zhCN.companion.notifyDenied}</p>}
    {notify.permission === "unsupported" && <p className="activity-notify-hint">{zhCN.companion.notifyUnsupported}</p>}
    {notify.permission === "insecure" && <p className="activity-notify-hint">{zhCN.companion.notifyInsecure}</p>}

    <section className="butler-lists" aria-label={zhCN.companion.activityIdle}>
      <h3 className="butler-list-title">{zhCN.companion.runningTitle}</h3>
      {runs.length === 0 && <p className="butler-list-empty">{zhCN.companion.nothingRunning}</p>}
      <ul className="butler-list">
        {runs.slice(0, LIST_ROWS).map(run => <li key={run.sessionId}>
          <button type="button" className="butler-row" data-testid={`activity-running-${run.sessionId}`} onClick={() => onOpen(run.projectId, run.sessionId)}>
            <span className="activity-row-title">{title(run.title)}</span>
            <span className="activity-row-state">{zhCN.run.running}</span>
          </button>
        </li>)}
      </ul>
      <h3 className="butler-list-title">{zhCN.companion.recentTitle}</h3>
      {recent.length === 0 && <p className="butler-list-empty">{zhCN.companion.nothingRecent}</p>}
      <ul className="butler-list">
        {recent.slice(0, LIST_ROWS).map(result => <li key={result.id}>
          <button type="button" className="butler-row" data-testid={`activity-recent-${result.id}`} data-kind={result.kind}
            title={result.message} onClick={() => onOpen(result.projectId, result.sessionId)}>
            <span className="activity-row-title">{title(result.title)}</span>
            <span className="activity-row-state" data-kind={result.kind}>{zhCN.companion.outcome[result.kind]}</span>
          </button>
        </li>)}
      </ul>
    </section>

    {butler.availability === "ready" && <section className="butler-conversation" data-testid="butler-conversation" aria-label={zhCN.butler.conversation(name)}>
      <div className="butler-conversation-head">
        <h3 className="butler-list-title">{zhCN.butler.conversation(name)}</h3>
        {butler.session && <button type="button" className="btn-ghost butler-reset" data-testid="butler-reset" title={zhCN.butler.resetHint}
          disabled={live} onClick={() => void butler.reset()}>{zhCN.butler.reset}</button>}
      </div>
      <div className="butler-body" ref={bodyRef} onClick={onBodyClick}>
        {state.timeline.length === 0
          ? <p className="butler-empty">{zhCN.butler.empty(name)}</p>
          : <Timeline timeline={state.timeline} live={live} imagePolicy="link" assistantTag={[name.slice(0, 2), name]} />}
      </div>
      {butler.connection === "busy" && <p className="butler-notice" role="status">{zhCN.butler.busy}</p>}
      {butler.connection === "reconnecting" && <p className="butler-notice" role="status">{zhCN.butler.reconnecting}</p>}
      {(butler.error || state.error) && <p className="butler-notice" role="alert" data-testid="butler-error">{butler.error ?? state.error}</p>}
      <div className="butler-composer">
        <textarea data-testid="butler-input" rows={2} value={text} placeholder={zhCN.butler.placeholder(name)} aria-label={zhCN.butler.conversation(name)}
          onChange={event => setText(event.target.value)} onKeyDown={onKeyDown} />
        {live
          ? <button type="button" className="butler-send" data-testid="butler-stop" disabled={state.phase !== "streaming"} onClick={butler.abort}>{zhCN.butler.stop}</button>
          : <button type="button" className="butler-send" data-testid="butler-send" disabled={sending || !text.trim()} onClick={() => void submit()}>{zhCN.butler.send}</button>}
      </div>
    </section>}
  </aside>;
}
