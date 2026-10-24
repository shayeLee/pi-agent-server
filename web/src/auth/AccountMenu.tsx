import { useId, useState, type ReactNode } from "react";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "pi-agent-server/client";
import { Modal } from "../components/Modal.js";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "../components/ui/dropdown-menu.js";
import { zhCN } from "../i18n/zh-CN.js";
import { useAuth } from "./auth-context.js";
import { authErrorMessage } from "./LoginPage.js";

/** Counted like the server counts: code points. */
const passwordLength = (value: string) => [...value].length;

function PasswordDialog({ open, onClose, accountName, changePassword }: {
  open: boolean;
  onClose: () => void;
  accountName: string;
  changePassword: (current: string, next: string) => Promise<void>;
}) {
  const formId = useId();
  const [done, setDone] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (busy) return; setCurrent(""); setNext(""); setConfirm(""); setError(null); setDone(false); onClose(); };

  async function submit() {
    if (busy) return;
    if (next !== confirm) { setError(zhCN.auth.passwordMismatch); return; }
    const length = passwordLength(next);
    if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) { setError(zhCN.auth.passwordLength(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH)); return; }
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      setCurrent(""); setNext(""); setConfirm("");
      setDone(true);
    } catch (failure) {
      setError(authErrorMessage(failure) ?? zhCN.auth.changeFailed);
    } finally {
      setBusy(false);
    }
  }

  return <Modal open={open} onClose={close} title={zhCN.auth.changePassword} className="auth-dialog"
    footer={done ? <div className="rename-actions">
      <button type="button" className="rename-save" data-testid="password-done" onClick={close}>{zhCN.auth.done}</button>
    </div> : <div className="rename-actions">
      <button type="button" onClick={close} disabled={busy}>{zhCN.auth.cancel}</button>
      <button type="submit" form={formId} className="rename-save" data-testid="password-save" disabled={busy || !current || !next || !confirm}>
        {busy ? zhCN.auth.saving : zhCN.auth.save}
      </button>
    </div>}>
    {done ? <p className="auth-notice" role="status" data-testid="password-changed">{zhCN.auth.passwordChanged}</p> : <form id={formId} className="auth-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {/* Lets password managers file the new password under the right account. */}
      <input type="text" name="username" autoComplete="username" value={accountName} readOnly hidden />
      <label className="rename-field">
        <span>{zhCN.auth.currentPassword}</span>
        <input type="password" data-testid="password-current" autoComplete="current-password" value={current} disabled={busy} onChange={event => setCurrent(event.target.value)} />
      </label>
      <label className="rename-field">
        <span>{zhCN.auth.newPassword}</span>
        <input type="password" data-testid="password-next" autoComplete="new-password" value={next} disabled={busy} onChange={event => setNext(event.target.value)} />
      </label>
      <label className="rename-field">
        <span>{zhCN.auth.confirmPassword}</span>
        <input type="password" data-testid="password-confirm" autoComplete="new-password" value={confirm} disabled={busy} onChange={event => setConfirm(event.target.value)} />
      </label>
      <p className="auth-rule">{zhCN.auth.passwordRule(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH)}</p>
      {error && <p className="auth-error" role="alert" data-testid="password-error">{error}</p>}
    </form>}
  </Modal>;
}

/** The settings menu's account section: who is signed in, change password, log out. Only in accounts mode. */
export function useAccountMenu(): { available: boolean; items: ReactNode; dialog: ReactNode } {
  const auth = useAuth();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const { account, logout, changePassword } = auth;
  if (auth.mode !== "accounts" || !account || !logout || !changePassword) return { available: false, items: null, dialog: null };
  const items = <>
    <DropdownMenuSeparator />
    <DropdownMenuLabel className="settings-menu-label" data-testid="account-name">{zhCN.auth.account(account.name)}</DropdownMenuLabel>
    <DropdownMenuItem data-testid="password-open" onSelect={() => setPasswordOpen(true)}>{zhCN.auth.changePassword}</DropdownMenuItem>
    <DropdownMenuItem data-testid="logout" onSelect={() => { setLogoutFailed(false); logout().catch(() => setLogoutFailed(true)); }}>{zhCN.auth.logout}</DropdownMenuItem>
  </>;
  const dialog = <>
    <PasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} accountName={account.name} changePassword={changePassword} />
    {logoutFailed && <button type="button" className="auth-toast" role="alert" data-testid="logout-failed" onClick={() => setLogoutFailed(false)}>{zhCN.auth.logoutFailed}</button>}
  </>;
  return { available: true, items, dialog };
}
