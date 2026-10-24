import { useId, useLayoutEffect, useState } from "react";
import { ApiError, type ApiClient, type AuthAccount } from "pi-agent-server/client";
import { zhCN } from "../i18n/zh-CN.js";
import { readThemeMode, resolveTheme } from "../theme-preference.js";

export type LoginNotice = "expired" | "signed-out";

/**
 * Message for a failed login or password change; `null` means show the generic fallback.
 * `csrf_rejected` means the page is open on an address the server does not trust (e.g. localhost
 * when PI_PUBLIC_URL is 127.0.0.1): the password was never checked, so it must not read as wrong.
 */
export function authErrorMessage(error: unknown, publicOrigin?: string): string | null {
  if (!(error instanceof ApiError)) return zhCN.auth.unreachable;
  if (error.status === 429) {
    if (error.code === "login_backoff" && error.retryAfter) return zhCN.auth.backoff(error.retryAfter);
    return zhCN.auth.busy;
  }
  if (error.code === "invalid_credentials") return zhCN.auth.invalidCredentials;
  if (error.code === "invalid_current_password") return zhCN.auth.invalidCurrent;
  if (error.code === "cookie_required") return zhCN.auth.cookieRequired;
  if (error.code === "csrf_rejected") return publicOrigin ? zhCN.auth.wrongOrigin(publicOrigin) : zhCN.auth.wrongOriginUnknown;
  return null;
}

export function LoginPage({ api, publicOrigin, notice, onSignedIn }: {
  api: ApiClient;
  publicOrigin: string;
  notice: LoginNotice | null;
  onSignedIn: (account: AuthAccount) => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The app sets the theme when it is mounted; the login page may be all there is.
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", resolveTheme(readThemeMode()));
  }, []);
  const otherOrigin = window.location.origin !== publicOrigin;

  async function submit() {
    if (busy || !name.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const { account } = await api.login(name.trim(), password);
      setPassword("");
      onSignedIn(account);
    } catch (failure) {
      setError(authErrorMessage(failure, publicOrigin) ?? zhCN.auth.invalidCredentials);
    } finally {
      setBusy(false);
    }
  }

  return <div className="auth-page" data-testid="login-page">
    <form className="auth-card" aria-labelledby={`${id}-title`} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="auth-brand ledger-brand" aria-hidden="true">pi<span>/</span>agent</div>
      <h1 id={`${id}-title`} className="auth-title">{zhCN.auth.title}</h1>
      {notice && <p className="auth-notice" role="status" data-testid="login-notice">{notice === "expired" ? zhCN.auth.expired : zhCN.auth.signedOut}</p>}
      <label className="auth-field">
        <span>{zhCN.auth.name}</span>
        <input data-testid="login-name" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          autoFocus required value={name} disabled={busy} onChange={event => setName(event.target.value)} />
      </label>
      <label className="auth-field">
        <span>{zhCN.auth.password}</span>
        <input data-testid="login-password" type="password" name="password" autoComplete="current-password" required
          value={password} disabled={busy} onChange={event => setPassword(event.target.value)} />
      </label>
      {error && <p className="auth-error" role="alert" data-testid="login-error">{error}</p>}
      <button type="submit" className="auth-primary" data-testid="login-submit" disabled={busy || !name.trim() || !password}>
        {busy ? zhCN.auth.submitting : zhCN.auth.submit}
      </button>
      {otherOrigin && <p className="auth-hint" data-testid="login-origin-hint">
        {zhCN.auth.publicOriginHint} <a href={publicOrigin}>{publicOrigin}</a>
      </p>}
    </form>
  </div>;
}
