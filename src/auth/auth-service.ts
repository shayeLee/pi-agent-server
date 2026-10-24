// Accounts-mode authentication (docs/login-design.md §4–§7).
//
// Nothing is cached: every request looks up its cookie or token by its unique hash, so a change made
// by the accounts CLI in another process applies to the next request.

import { randomUUID } from "node:crypto";
import {
  type AccountRecord,
  type AccountRole,
  type AccountStorePort,
  type ApiTokenRecord,
  type AuthSessionRecord,
} from "../application/ports/account-store-port.js";
import { IP_ROLES } from "../core/ip-access-policy.js";
import {
  API_TOKEN_PREFIX,
  apiTokenPrefix,
  hashPassword,
  newApiToken,
  newSessionToken,
  passwordLengthOk,
  sha256Hex,
  verifyPassword,
} from "./secrets.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A browser session lasts at most 30 days. */
export const SESSION_ABSOLUTE_MS = 30 * DAY_MS;
/** A browser session not used for 14 days ends. */
export const SESSION_IDLE_MS = 14 * DAY_MS;
/** last_seen_at / last_used_at are written at most once a day. */
const TOUCH_INTERVAL_MS = DAY_MS;
const LABEL_MAX_LENGTH = 120;

export const ACCOUNT_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

export type Authenticated = {
  readonly account: AccountRecord;
  readonly via: "cookie" | "token";
  /** The browser session behind a cookie. */
  readonly sessionId?: string;
};

export type LoginResult = {
  readonly account: AccountRecord;
  /** Cookie value; shown to the browser only. */
  readonly sessionToken: string;
  readonly session: AuthSessionRecord;
};

export class AuthError extends Error {
  constructor(readonly code: "account_not_found" | "account_exists" | "invalid_name" | "invalid_role" | "password_too_weak" | "token_not_found" | "session_not_found", message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export function isAccountRole(value: unknown): value is AccountRole {
  return typeof value === "string" && (IP_ROLES as readonly string[]).includes(value);
}

/** User-Agent shortened to one line for the device list. */
function sessionLabel(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const clean = userAgent.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean ? clean.slice(0, LABEL_MAX_LENGTH) : null;
}

export class AuthService {
  private readonly now: () => number;

  constructor(private readonly store: AccountStorePort, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  async authenticateSession(token: string): Promise<Authenticated | null> {
    if (!token) return null;
    const session = await this.store.findAuthSessionByTokenHash(sha256Hex(token));
    if (!session) return null;
    const now = this.now();
    if (session.expiresAt <= now || session.lastSeenAt + SESSION_IDLE_MS <= now) return null;
    const account = await this.store.getAccount(session.accountId);
    if (!account || account.disabled) return null;
    if (now - session.lastSeenAt >= TOUCH_INTERVAL_MS) await this.store.touchAuthSession(session.id, now);
    return { account, via: "cookie", sessionId: session.id };
  }

  async authenticateToken(token: string): Promise<Authenticated | null> {
    if (!token.startsWith(API_TOKEN_PREFIX)) return null;
    const record = await this.store.findApiTokenByHash(sha256Hex(token));
    if (!record || record.revokedAt !== null) return null;
    const account = await this.store.getAccount(record.accountId);
    if (!account || account.disabled) return null;
    const now = this.now();
    if (record.lastUsedAt === null || now - record.lastUsedAt >= TOUCH_INTERVAL_MS) await this.store.touchApiToken(record.id, now);
    return { account, via: "token" };
  }

  /**
   * Checks a name and password. An unknown, disabled or password-less account costs the same
   * scrypt and gives the same null as a wrong password.
   */
  async login(name: string, password: string, userAgent?: string): Promise<LoginResult | null> {
    const account = ACCOUNT_NAME_PATTERN.test(name) ? await this.store.findAccountByName(name) : null;
    const secret = account ? await this.store.getPasswordSecret(account.id) : null;
    const ok = await verifyPassword(password, secret);
    if (!ok || !account || account.disabled) return null;
    const now = this.now();
    const { session, sessionToken } = await this.issueSession(account.id, now, sessionLabel(userAgent));
    await this.store.markPasswordUsed(account.id, now);
    return { account, sessionToken, session };
  }

  async logout(sessionId: string): Promise<void> {
    await this.store.deleteAuthSession(sessionId);
  }

  /**
   * Changes the password after checking the current one. Every browser of the account is signed out;
   * the caller's browser gets a new session.
   */
  async changePassword(accountId: string, current: string, next: string, userAgent?: string):
    Promise<{ ok: true; sessionToken: string; session: AuthSessionRecord } | { ok: false; reason: "invalid_current" | "password_too_weak" }> {
    const secret = await this.store.getPasswordSecret(accountId);
    if (!(await verifyPassword(current, secret))) return { ok: false, reason: "invalid_current" };
    if (!passwordLengthOk(next)) return { ok: false, reason: "password_too_weak" };
    const now = this.now();
    await this.store.setPasswordSecret(accountId, await hashPassword(next), now);
    const issued = await this.issueSession(accountId, now, sessionLabel(userAgent));
    return { ok: true, ...issued };
  }

  private async issueSession(accountId: string, now: number, label: string | null): Promise<{ session: AuthSessionRecord; sessionToken: string }> {
    const sessionToken = newSessionToken();
    const session: AuthSessionRecord = {
      id: randomUUID(), accountId, createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_ABSOLUTE_MS, label,
    };
    await this.store.createAuthSession(session, sha256Hex(sessionToken));
    return { session, sessionToken };
  }

  // --- Administration (accounts CLI) -------------------------------------------------------------

  async createAccount(name: string, role: string, password: string): Promise<AccountRecord> {
    if (!ACCOUNT_NAME_PATTERN.test(name)) throw new AuthError("invalid_name", "账号名只能用 1–32 个小写字母、数字、- 或 _");
    if (!isAccountRole(role)) throw new AuthError("invalid_role", `角色必须是 ${IP_ROLES.join(" / ")} 之一`);
    if (!passwordLengthOk(password)) throw new AuthError("password_too_weak", "密码长度必须在 12–256 个字符之间");
    if (await this.store.findAccountByName(name)) throw new AuthError("account_exists", "账号名已存在");
    const now = this.now();
    const account: AccountRecord = { id: randomUUID(), name, role, disabled: false, createdAt: now, updatedAt: now };
    const secret = await hashPassword(password);
    await this.store.createAccount(account);
    await this.store.setPasswordSecret(account.id, secret, now);
    return account;
  }

  async requireAccount(name: string): Promise<AccountRecord> {
    const account = ACCOUNT_NAME_PATTERN.test(name) ? await this.store.findAccountByName(name) : null;
    if (!account) throw new AuthError("account_not_found", "账号不存在");
    return account;
  }

  async setPassword(name: string, password: string): Promise<void> {
    if (!passwordLengthOk(password)) throw new AuthError("password_too_weak", "密码长度必须在 12–256 个字符之间");
    const account = await this.requireAccount(name);
    await this.store.setPasswordSecret(account.id, await hashPassword(password), this.now());
  }

  async setRole(name: string, role: string): Promise<void> {
    if (!isAccountRole(role)) throw new AuthError("invalid_role", `角色必须是 ${IP_ROLES.join(" / ")} 之一`);
    const account = await this.requireAccount(name);
    await this.store.setRole(account.id, role, this.now());
  }

  async disable(name: string): Promise<void> {
    const account = await this.requireAccount(name);
    await this.store.disableAccount(account.id, this.now());
  }

  async enable(name: string): Promise<void> {
    const account = await this.requireAccount(name);
    await this.store.enableAccount(account.id, this.now());
  }

  listAccounts(): Promise<AccountRecord[]> {
    return this.store.listAccounts();
  }

  async listSessions(name: string): Promise<AuthSessionRecord[]> {
    return this.store.listAuthSessions((await this.requireAccount(name)).id);
  }

  async kick(sessionId: string): Promise<void> {
    if (!(await this.store.deleteAuthSession(sessionId))) throw new AuthError("session_not_found", "登录状态不存在");
  }

  async issueToken(name: string, label: string): Promise<{ token: string; record: ApiTokenRecord }> {
    const account = await this.requireAccount(name);
    const token = newApiToken();
    const record: ApiTokenRecord = {
      id: randomUUID(), accountId: account.id, name: label, prefix: apiTokenPrefix(token), createdAt: this.now(), lastUsedAt: null, revokedAt: null,
    };
    await this.store.createApiToken(record, sha256Hex(token));
    return { token, record };
  }

  async listTokens(name: string): Promise<ApiTokenRecord[]> {
    return this.store.listApiTokens((await this.requireAccount(name)).id);
  }

  async revokeToken(id: string): Promise<void> {
    if (!(await this.store.revokeApiToken(id, this.now()))) throw new AuthError("token_not_found", "token 不存在或已吊销");
  }
}
