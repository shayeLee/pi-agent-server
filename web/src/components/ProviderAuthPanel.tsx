import { zhCN } from "../i18n/zh-CN.js";
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { ApiClient, ProviderAuthEntry, ProviderAuthList, ProviderAuthMethod, ProviderLogin, ProviderLoginPrompt, ProviderLoginStep } from "pi-agent-server/client";
import { Modal } from "./Modal.js";
import { errorMessage } from "./ProjectMcpPanel.js";

type ProviderAuthApi = Pick<ApiClient, "listProviderAuth" | "startProviderLogin" | "getProviderLogin" | "answerProviderLogin"
  | "cancelProviderLogin" | "removeProviderCredential">;

const text = zhCN.providerAuth;
const POLL_MS = 1000;

/**
 * 模型登录（Pi TUI 的 /login、/logout），入口在侧栏底部的“设置”菜单里。凭证写进 Pi 的 auth.json，
 * 整个服务共用，所以只有 admin 读得到列表；读不到时 `available` 为 false，菜单不显示这一项。
 */
export function useProviderAuth({ api }: { api: ProviderAuthApi }): { available: boolean; openPanel: () => void; dialog: ReactNode } {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let current = true;
    api.listProviderAuth().then(() => { if (current) setAvailable(true); }, () => {});
    return () => { current = false; };
  }, [api]);
  const openPanel = useCallback(() => setOpen(true), []);
  if (!available) return { available, openPanel, dialog: null };
  return { available, openPanel, dialog: <Modal open={open} onClose={() => setOpen(false)} title={text.title} className="project-mcp-dialog">
    {open && <ProviderAuthPanel api={api} />}
  </Modal> };
}

export function ProviderAuthPanel({ api }: { api: ProviderAuthApi }) {
  const [list, setList] = useState<ProviderAuthList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  /** 同一时间只在一行里展开登录过程。 */
  const [login, setLogin] = useState<ProviderLogin | null>(null);
  const load = useCallback(() => api.listProviderAuth().then(
    result => { setList(result); setLoadError(null); },
    error => setLoadError(errorMessage(error))), [api]);
  useEffect(() => { void load(); }, [load]);

  const running = login?.state === "running";
  const loginId = login?.id;
  useEffect(() => {
    if (!running || !loginId) return;
    let current = true;
    const timer = setTimeout(() => {
      api.getProviderLogin(loginId).then(next => {
        if (!current) return;
        setLogin(next);
        if (next.state === "succeeded") void load();
      }, error => { if (current) setLogin(previous => previous && { ...previous, state: "failed", error: errorMessage(error) }); });
    }, POLL_MS);
    return () => { current = false; clearTimeout(timer); };
  }, [api, load, login, loginId, running]);

  const providers = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched = (list?.providers ?? []).filter(provider => !needle
      || provider.id.toLowerCase().includes(needle) || provider.name.toLowerCase().includes(needle));
    // 已经能用的排在前面，其余按名称。
    return [...matched].sort((a, b) => Number(b.status.configured) - Number(a.status.configured) || a.name.localeCompare(b.name));
  }, [filter, list]);

  if (!list) {
    return <div className="project-mcp provider-auth" data-testid="provider-auth-panel">
      {loadError && <p className="project-mcp-error" role="alert">{text.loadFailed(loadError)}</p>}
    </div>;
  }
  return <div className="project-mcp provider-auth" data-testid="provider-auth-panel">
    <p className="project-mcp-intro">{text.intro}</p>
    <input className="project-mcp-input provider-auth-filter" type="search" value={filter} aria-label={text.filter} placeholder={text.filter}
      data-testid="provider-auth-filter" onChange={event => setFilter(event.target.value)} />
    {providers.length === 0
      ? <p className="project-mcp-empty">{text.empty}</p>
      : <ul className="project-mcp-list">
        {providers.map(provider => <ProviderRow key={provider.id} api={api} provider={provider}
          login={login?.provider === provider.id ? login : null} busy={running && login?.provider !== provider.id}
          onLogin={setLogin} onListChanged={setList} onDismiss={() => setLogin(null)} />)}
      </ul>}
  </div>;
}

function statusText(provider: ProviderAuthEntry): string {
  // 只在 auth.json 里有、服务却不认识的 provider：没有任何登录方式。
  if (!provider.oauth && !provider.apiKey) return text.status.notLoaded;
  if (!provider.status.configured) return provider.stored ? text.status.storedUnused : text.status.none;
  const kind = provider.status.type === "oauth" ? text.methods.oauth : text.methods.api_key;
  const source = provider.status.source;
  return source ? text.status.configuredFrom(kind, text.sources[source] ?? source) : text.status.configured(kind);
}

function ProviderRow({ api, provider, login, busy, onLogin, onListChanged, onDismiss }: {
  api: ProviderAuthApi; provider: ProviderAuthEntry; login: ProviderLogin | null; busy: boolean;
  onLogin: (login: ProviderLogin) => void; onListChanged: (list: ProviderAuthList) => void; onDismiss: () => void;
}) {
  const [state, setState] = useState<{ kind: "idle" | "starting" | "confirm" | "removing" } | { kind: "error"; message: string }>({ kind: "idle" });
  const running = login?.state === "running";
  async function start(method: ProviderAuthMethod) {
    setState({ kind: "starting" });
    try {
      onLogin(await api.startProviderLogin({ provider: provider.id, method }));
      setState({ kind: "idle" });
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error) });
    }
  }
  async function remove() {
    setState({ kind: "removing" });
    try {
      onListChanged(await api.removeProviderCredential(provider.id));
      setState({ kind: "idle" });
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error) });
    }
  }
  const disabled = busy || running || state.kind === "starting" || state.kind === "removing";
  const canApiKey = provider.apiKey?.interactive === true;
  return <li className={`project-mcp-row${provider.status.configured ? " is-enabled" : ""}`} data-testid="provider-auth-row" data-provider={provider.id}>
    <div className="project-mcp-head">
      <span className="project-mcp-name shared-mcp-name">{provider.name}</span>
      <span className="project-mcp-meta">
        {provider.id !== provider.name && <>{provider.id} · </>}
        <span className={provider.status.configured ? "provider-auth-ok" : ""}>{statusText(provider)}</span>
        {provider.oauth?.subscription && <> · {text.subscription}</>}
      </span>
    </div>
    <div className="project-mcp-line">
      {state.kind === "confirm" || state.kind === "removing"
        ? <>
          <span className="project-mcp-meta">{provider.stored === "oauth" ? text.confirmLogout : text.confirmRemoveKey}</span>
          <button type="button" className="project-mcp-action shared-mcp-danger" disabled={state.kind === "removing"} onClick={() => void remove()}>
            {state.kind === "removing" ? text.removing : text.confirm}</button>
          <button type="button" className="project-mcp-action" disabled={state.kind === "removing"} onClick={() => setState({ kind: "idle" })}>{text.cancel}</button>
        </>
        : <>
          {provider.oauth && <button type="button" className="project-mcp-action project-mcp-primary" disabled={disabled} data-testid="provider-auth-oauth"
            title={provider.oauth.loginLabel ?? provider.oauth.name} onClick={() => void start("oauth")}>
            {provider.stored === "oauth" ? text.relogin : text.signIn}</button>}
          {canApiKey && <button type="button" className="project-mcp-action" disabled={disabled} data-testid="provider-auth-api-key"
            title={provider.apiKey?.name} onClick={() => void start("api_key")}>
            {provider.stored === "api_key" ? text.replaceKey : text.enterKey}</button>}
          {provider.apiKey && !canApiKey && !provider.oauth && <span className="project-mcp-meta">{text.ambientOnly(provider.apiKey.name)}</span>}
          {provider.stored && <button type="button" className="project-mcp-action" disabled={disabled} data-testid="provider-auth-remove"
            onClick={() => setState({ kind: "confirm" })}>{provider.stored === "oauth" ? text.logout : text.removeKey}</button>}
        </>}
      {state.kind === "starting" && <span className="project-mcp-meta">{text.starting}</span>}
      {state.kind === "error" && <span className="project-mcp-error" role="alert">{text.failed(state.message)}</span>}
    </div>
    {login && <LoginProgress api={api} login={login} onChange={onLogin} onDismiss={onDismiss} />}
  </li>;
}

function LoginProgress({ api, login, onChange, onDismiss }: {
  api: ProviderAuthApi; login: ProviderLogin; onChange: (login: ProviderLogin) => void; onDismiss: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  async function cancel() {
    setCancelling(true);
    try {
      onChange(await api.cancelProviderLogin(login.id));
    } catch {
      onDismiss();
    } finally {
      setCancelling(false);
    }
  }
  const running = login.state === "running";
  return <div className="provider-auth-login" data-testid="provider-auth-login" data-state={login.state} aria-live="polite">
    {login.steps.map((step, index) => <LoginStep key={index} step={step} />)}
    {running && login.prompt && <PromptForm key={login.prompt.id} api={api} login={login} prompt={login.prompt} onChange={onChange} />}
    {running && !login.prompt && <p className="shared-mcp-hint">{login.steps.length === 0 ? text.waitingProvider : text.waiting}</p>}
    {login.state === "succeeded" && <p className="provider-auth-done" role="status">{login.method === "oauth" ? text.done.oauth : text.done.api_key}</p>}
    {login.state === "succeeded" && login.error && <p className="project-mcp-error" role="alert">{login.error}</p>}
    {login.state === "failed" && <p className="project-mcp-error" role="alert">{text.failed(login.error ?? "")}</p>}
    {login.state === "cancelled" && <p className="shared-mcp-hint">{text.cancelled}</p>}
    <div className="project-mcp-line">
      {running
        ? <button type="button" className="project-mcp-action" disabled={cancelling} data-testid="provider-auth-cancel" onClick={() => void cancel()}>{text.cancelLogin}</button>
        : <button type="button" className="project-mcp-action" onClick={onDismiss}>{text.dismiss}</button>}
    </div>
  </div>;
}

function LoginStep({ step }: { step: ProviderLoginStep }) {
  switch (step.type) {
    case "auth_url":
      return <div className="provider-auth-step">
        <a className="project-mcp-action project-mcp-primary" href={step.url} target="_blank" rel="noreferrer noopener" data-testid="provider-auth-url">{text.openAuthPage}</a>
        {step.instructions && <p className="shared-mcp-hint">{step.instructions}</p>}
        <p className="provider-auth-url">{step.url}</p>
      </div>;
    case "device_code":
      return <div className="provider-auth-step">
        <p className="shared-mcp-hint">{text.deviceCode}</p>
        <p className="provider-auth-code" data-testid="provider-auth-device-code">{step.userCode}</p>
        <a className="project-mcp-action project-mcp-primary" href={step.verificationUri} target="_blank" rel="noreferrer noopener">{step.verificationUri}</a>
      </div>;
    case "info":
      return <div className="provider-auth-step">
        <p className="project-mcp-desc">{step.message}</p>
        {step.links?.map(link => <a key={link.url} className="project-mcp-action" href={link.url} target="_blank" rel="noreferrer noopener">{link.label ?? link.url}</a>)}
      </div>;
    default:
      return <p className="shared-mcp-hint provider-auth-step">{step.message}</p>;
  }
}

function PromptForm({ api, login, prompt, onChange }: {
  api: ProviderAuthApi; login: ProviderLogin; prompt: ProviderLoginPrompt; onChange: (login: ProviderLogin) => void;
}) {
  const id = useId();
  const [value, setValue] = useState(prompt.options?.[0]?.id ?? "");
  const [state, setState] = useState<{ kind: "idle" | "sending" } | { kind: "error"; message: string }>({ kind: "idle" });
  async function submit(answer: string) {
    setState({ kind: "sending" });
    try {
      onChange(await api.answerProviderLogin(login.id, { promptId: prompt.id, value: answer }));
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error) });
    }
  }
  const sending = state.kind === "sending";
  return <form className="provider-auth-prompt" data-testid="provider-auth-prompt" data-prompt-type={prompt.type}
    onSubmit={event => { event.preventDefault(); void submit(value); }}>
    <label className="project-mcp-desc" htmlFor={`${id}-answer`}>{prompt.message}</label>
    {prompt.type === "manual_code" && <p className="shared-mcp-hint">{text.manualCodeHint}</p>}
    {prompt.type === "select"
      ? <div className="provider-auth-options" role="radiogroup" aria-label={prompt.message}>
        {prompt.options?.map(option => <label key={option.id} className="shared-mcp-check">
          <input type="radio" name={`${id}-option`} checked={value === option.id} disabled={sending} onChange={() => setValue(option.id)} />
          <span>{option.label}{option.description && <span className="shared-mcp-hint"> · {option.description}</span>}</span>
        </label>)}
      </div>
      : <input id={`${id}-answer`} className="project-mcp-input" autoFocus autoComplete="off" spellCheck={false} disabled={sending}
        type={prompt.type === "secret" ? "password" : "text"} value={value} placeholder={prompt.placeholder}
        data-testid="provider-auth-answer" onChange={event => setValue(event.target.value)} />}
    <div className="project-mcp-line">
      <button type="submit" className="project-mcp-action project-mcp-primary" disabled={sending}>{sending ? text.sending : text.submit}</button>
      {state.kind === "error" && <span className="project-mcp-error" role="alert">{text.failed(state.message)}</span>}
    </div>
  </form>;
}
