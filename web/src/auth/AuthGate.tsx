import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiClient, ApiError, type AuthAccount, type FetchLike } from "pi-agent-server/client";
import { zhCN } from "../i18n/zh-CN.js";
import { AuthContext, type AuthSession } from "./auth-context.js";
import { LoginPage, type LoginNotice } from "./LoginPage.js";
import { setStorageAccount } from "./storage-scope.js";

function startAtHome(): void {
  if (window.location.pathname !== "/" || window.location.search) window.history.replaceState(null, "", "/");
}

type GateState =
  | { kind: "loading" }
  | { kind: "unreachable" }
  | { kind: "ip" }
  | {
    kind: "accounts";
    publicOrigin: string;
    /** Signed in now; `null` shows the login page. */
    account: AuthAccount | null;
    /** The account whose app is mounted. It stays mounted (inert, under the login page) when the
     * login merely expired, so the same account signing back in keeps its drafts and view. */
    mounted: AuthAccount | null;
    notice: LoginNotice | null;
    generation: number;
  };

/**
 * Decides what the page shows before the app (docs/login-design.md §9: `web/`): ip mode renders the
 * app as before; accounts mode needs a login. Logging out, or another account signing in, unmounts
 * the previous account's app, which drops its session caches, event cursors, uploads and retries.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const api = useMemo(() => new ApiClient({ baseUrl: "" }), []);
  const [state, setState] = useState<GateState>({ kind: "loading" });
  const accountsMode = useRef(false);

  const boot = useCallback(async () => {
    setState({ kind: "loading" });
    let publicOrigin: string;
    try {
      // Only an explicit accounts answer asks for a login; any other successful answer is ip mode.
      const authState = await api.getAuthState() as Awaited<ReturnType<ApiClient["getAuthState"]>> | undefined;
      if (authState?.mode !== "accounts") { accountsMode.current = false; setStorageAccount(null); setState({ kind: "ip" }); return; }
      publicOrigin = authState.publicOrigin;
    } catch (error) {
      // A server from before login has no /v1/auth/state: it is ip mode.
      if (error instanceof ApiError && error.status === 404) { setStorageAccount(null); setState({ kind: "ip" }); return; }
      setState({ kind: "unreachable" });
      return;
    }
    accountsMode.current = true;
    try {
      const { account } = await api.getAuthMe();
      setStorageAccount(account.id);
      setState({ kind: "accounts", publicOrigin, account, mounted: account, notice: null, generation: 0 });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setStorageAccount(null);
        setState({ kind: "accounts", publicOrigin, account: null, mounted: null, notice: null, generation: 0 });
        return;
      }
      setState({ kind: "unreachable" });
    }
  }, [api]);

  useEffect(() => { void boot(); }, [boot]);

  const expire = useCallback(() => {
    setState(previous => previous.kind === "accounts" && previous.account
      ? { ...previous, account: null, notice: "expired" }
      : previous);
  }, []);

  const fetch = useCallback<FetchLike>(async (input, init) => {
    const response = await globalThis.fetch(input, init);
    if (response.status === 401 && accountsMode.current) expire();
    return response;
  }, [expire]);

  const signedIn = useCallback((account: AuthAccount) => {
    setState(previous => {
      if (previous.kind !== "accounts") return previous;
      const same = previous.mounted?.id === account.id;
      if (!same) setStorageAccount(account.id);
      // The address may name the previous account's session; another account starts at home.
      if (!same && previous.mounted) startAtHome();
      return { ...previous, account, mounted: account, notice: null, generation: same ? previous.generation + 1 : 0 };
    });
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(error => {
      // Already signed out on the server is still signed out.
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    });
    setStorageAccount(null);
    startAtHome();
    setState(previous => previous.kind === "accounts"
      ? { ...previous, account: null, mounted: null, notice: "signed-out", generation: 0 }
      : previous);
  }, [api]);

  const changePassword = useCallback((current: string, next: string) => api.changePassword(current, next), [api]);

  const account = state.kind === "accounts" ? state.account : null;
  const generation = state.kind === "accounts" ? state.generation : 0;
  const publicOrigin = state.kind === "accounts" ? state.publicOrigin : undefined;
  const session = useMemo<AuthSession>(() => ({
    mode: "accounts", publicOrigin, account, fetch, onAuthExpired: expire, generation, logout, changePassword,
  }), [publicOrigin, account, fetch, expire, generation, logout, changePassword]);

  if (state.kind === "loading") return <div className="auth-status auth-loading" data-testid="auth-loading">{zhCN.auth.loading}</div>;
  if (state.kind === "unreachable") {
    return <div className="auth-status" role="alert" data-testid="auth-unreachable">
      <p>{zhCN.auth.unreachable}</p>
      <button type="button" className="auth-secondary" onClick={() => void boot()}>{zhCN.auth.retry}</button>
    </div>;
  }
  if (state.kind === "ip") return <>{children}</>;
  return <>
    {state.mounted && <AuthContext.Provider value={session}>
      <div className="auth-app" inert={state.account === null} aria-hidden={state.account === null || undefined} key={state.mounted.id}>
        {children}
      </div>
    </AuthContext.Provider>}
    {state.account === null && <LoginPage api={api} publicOrigin={state.publicOrigin} notice={state.notice} onSignedIn={signedIn} />}
  </>;
}
