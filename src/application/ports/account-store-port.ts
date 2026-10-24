// Accounts and how they sign in (docs/login-design.md §3). The store keeps only hashes and scrypt strings;
// plaintext passwords, cookies and tokens never reach it.

import type { IpRole } from "../../core/ip-access-policy.js";

/** Account roles reuse the existing role vocabulary and RBAC matrix. */
export type AccountRole = IpRole;

export interface AccountRecord {
  readonly id: string;
  readonly name: string;
  readonly role: AccountRole;
  readonly disabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AuthSessionRecord {
  readonly id: string;
  readonly accountId: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly label: string | null;
}

export interface ApiTokenRecord {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

export class AccountNameTakenError extends Error {
  constructor() {
    super("账号名已存在");
    this.name = "AccountNameTakenError";
  }
}

export interface AccountStorePort {
  createAccount(account: AccountRecord): Promise<void>;
  getAccount(id: string): Promise<AccountRecord | null>;
  findAccountByName(name: string): Promise<AccountRecord | null>;
  listAccounts(): Promise<AccountRecord[]>;
  setRole(accountId: string, role: AccountRole, now: number): Promise<boolean>;
  /** Disables the account, signs out every browser and revokes every token in one transaction. */
  disableAccount(accountId: string, now: number): Promise<boolean>;
  enableAccount(accountId: string, now: number): Promise<boolean>;

  getPasswordSecret(accountId: string): Promise<string | null>;
  /**
   * Sets the password and signs out every browser of the account except `keepSessionId`
   * (the browser that changed it), in one transaction.
   */
  setPasswordSecret(accountId: string, secret: string, now: number, keepSessionId?: string): Promise<void>;
  markPasswordUsed(accountId: string, now: number): Promise<void>;

  createAuthSession(session: AuthSessionRecord, tokenHash: string): Promise<void>;
  findAuthSessionByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null>;
  touchAuthSession(id: string, lastSeenAt: number): Promise<void>;
  deleteAuthSession(id: string): Promise<boolean>;
  listAuthSessions(accountId: string): Promise<AuthSessionRecord[]>;

  createApiToken(token: ApiTokenRecord, tokenHash: string): Promise<void>;
  findApiTokenByHash(tokenHash: string): Promise<ApiTokenRecord | null>;
  touchApiToken(id: string, lastUsedAt: number): Promise<void>;
  listApiTokens(accountId: string): Promise<ApiTokenRecord[]>;
  revokeApiToken(id: string, now: number): Promise<boolean>;
}
