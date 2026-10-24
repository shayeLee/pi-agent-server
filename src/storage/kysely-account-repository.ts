// Accounts, password login methods, browser sessions and personal tokens (SQLite and PostgreSQL alike).
import type { Kysely, Transaction } from "kysely";
import type { DatabaseSchema } from "./db-schema.js";
import {
  AccountNameTakenError,
  type AccountRecord,
  type AccountRole,
  type AccountStorePort,
  type ApiTokenRecord,
  type AuthSessionRecord,
} from "../application/ports/account-store-port.js";
import { IP_ROLES } from "../core/ip-access-policy.js";
import { withSqliteWriteLock } from "./sqlite-write-lock.js";
import { randomUUID } from "node:crypto";

const PASSWORD_KIND = "password";
const ROLES = new Set<string>(IP_ROLES);

type AccountRow = { id: string; name: string; role: string; disabled: number | string | bigint; created_at: number; updated_at: number };
type SessionRow = { id: string; account_id: string; created_at: number; last_seen_at: number; expires_at: number; label: string | null };
type TokenRow = { id: string; account_id: string; name: string; prefix: string; created_at: number; last_used_at: number | null; revoked_at: number | null };

/** A row with a role this server does not know reads as disabled, so it can never sign in. */
function toAccount(row: AccountRow): AccountRecord {
  const known = ROLES.has(row.role);
  return {
    id: row.id,
    name: row.name,
    role: (known ? row.role : "viewer") as AccountRole,
    disabled: !known || Number(row.disabled) !== 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toSession(row: SessionRow): AuthSessionRecord {
  return {
    id: row.id, accountId: row.account_id, createdAt: Number(row.created_at), lastSeenAt: Number(row.last_seen_at),
    expiresAt: Number(row.expires_at), label: row.label,
  };
}

function toToken(row: TokenRow): ApiTokenRecord {
  return {
    id: row.id, accountId: row.account_id, name: row.name, prefix: row.prefix, createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

const ACCOUNT_COLUMNS = ["id", "name", "role", "disabled", "created_at", "updated_at"] as const;
const SESSION_COLUMNS = ["id", "account_id", "created_at", "last_seen_at", "expires_at", "label"] as const;
const TOKEN_COLUMNS = ["id", "account_id", "name", "prefix", "created_at", "last_used_at", "revoked_at"] as const;

export class KyselyAccountRepository implements AccountStorePort {
  constructor(
    private readonly db: Kysely<DatabaseSchema>,
    private readonly dialect: "sqlite" | "postgres",
  ) {}

  async createAccount(account: AccountRecord): Promise<void> {
    await this.write(tx => this.insertAccount(tx, account));
  }

  private async insertAccount(tx: Transaction<DatabaseSchema>, account: AccountRecord): Promise<void> {
    const existing = await tx.selectFrom("accounts").select("id").where("name", "=", account.name).executeTakeFirst();
    if (existing) throw new AccountNameTakenError();
    await tx.insertInto("accounts").values({
      id: account.id, name: account.name, role: account.role, disabled: account.disabled ? 1 : 0,
      created_at: account.createdAt, updated_at: account.updatedAt,
    }).execute();
  }

  async getAccount(id: string): Promise<AccountRecord | null> {
    const row = await this.db.selectFrom("accounts").select(ACCOUNT_COLUMNS).where("id", "=", id).executeTakeFirst();
    return row ? toAccount(row) : null;
  }

  async findAccountByName(name: string): Promise<AccountRecord | null> {
    const row = await this.db.selectFrom("accounts").select(ACCOUNT_COLUMNS).where("name", "=", name).executeTakeFirst();
    return row ? toAccount(row) : null;
  }

  async listAccounts(): Promise<AccountRecord[]> {
    const rows = await this.db.selectFrom("accounts").select(ACCOUNT_COLUMNS).orderBy("name").execute();
    return rows.map(toAccount);
  }

  async setRole(accountId: string, role: AccountRole, now: number): Promise<boolean> {
    return this.write(async tx => {
      const result = await tx.updateTable("accounts").set({ role, updated_at: now }).where("id", "=", accountId).executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    });
  }

  async disableAccount(accountId: string, now: number): Promise<boolean> {
    return this.write(async tx => {
      const result = await tx.updateTable("accounts").set({ disabled: 1, updated_at: now }).where("id", "=", accountId).executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) return false;
      await tx.deleteFrom("auth_sessions").where("account_id", "=", accountId).execute();
      await tx.updateTable("api_tokens").set({ revoked_at: now }).where("account_id", "=", accountId).where("revoked_at", "is", null).execute();
      return true;
    });
  }

  async enableAccount(accountId: string, now: number): Promise<boolean> {
    return this.write(async tx => {
      const result = await tx.updateTable("accounts").set({ disabled: 0, updated_at: now }).where("id", "=", accountId).executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    });
  }

  async getPasswordSecret(accountId: string): Promise<string | null> {
    const row = await this.db.selectFrom("login_methods").select("secret")
      .where("kind", "=", PASSWORD_KIND).where("issuer", "=", "").where("subject", "=", accountId).executeTakeFirst();
    return row?.secret ?? null;
  }

  async setPasswordSecret(accountId: string, secret: string, now: number, keepSessionId?: string): Promise<void> {
    await this.write(async tx => {
      const updated = await tx.updateTable("login_methods").set({ secret })
        .where("kind", "=", PASSWORD_KIND).where("issuer", "=", "").where("subject", "=", accountId).executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) {
        await tx.insertInto("login_methods").values({
          id: randomUUID(), account_id: accountId, kind: PASSWORD_KIND, issuer: "", subject: accountId, secret,
          created_at: now, last_used_at: null,
        }).execute();
      }
      let sessions = tx.deleteFrom("auth_sessions").where("account_id", "=", accountId);
      if (keepSessionId !== undefined) sessions = sessions.where("id", "!=", keepSessionId);
      await sessions.execute();
      await tx.updateTable("accounts").set({ updated_at: now }).where("id", "=", accountId).execute();
    });
  }

  async markPasswordUsed(accountId: string, now: number): Promise<void> {
    await this.write(tx => tx.updateTable("login_methods").set({ last_used_at: now })
      .where("kind", "=", PASSWORD_KIND).where("issuer", "=", "").where("subject", "=", accountId).execute());
  }

  async createAuthSession(session: AuthSessionRecord, tokenHash: string): Promise<void> {
    await this.write(tx => tx.insertInto("auth_sessions").values({
      id: session.id, token_hash: tokenHash, account_id: session.accountId, created_at: session.createdAt,
      last_seen_at: session.lastSeenAt, expires_at: session.expiresAt, label: session.label,
    }).execute());
  }

  async findAuthSessionByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
    const row = await this.db.selectFrom("auth_sessions").select(SESSION_COLUMNS).where("token_hash", "=", tokenHash).executeTakeFirst();
    return row ? toSession(row) : null;
  }

  async touchAuthSession(id: string, lastSeenAt: number): Promise<void> {
    await this.write(tx => tx.updateTable("auth_sessions").set({ last_seen_at: lastSeenAt }).where("id", "=", id).execute());
  }

  async deleteAuthSession(id: string): Promise<boolean> {
    return this.write(async tx => Number((await tx.deleteFrom("auth_sessions").where("id", "=", id).executeTakeFirst()).numDeletedRows) > 0);
  }

  async listAuthSessions(accountId: string): Promise<AuthSessionRecord[]> {
    const rows = await this.db.selectFrom("auth_sessions").select(SESSION_COLUMNS).where("account_id", "=", accountId)
      .orderBy("created_at", "desc").execute();
    return rows.map(toSession);
  }

  async createApiToken(token: ApiTokenRecord, tokenHash: string): Promise<void> {
    await this.write(tx => tx.insertInto("api_tokens").values({
      id: token.id, account_id: token.accountId, name: token.name, token_hash: tokenHash, prefix: token.prefix,
      created_at: token.createdAt, last_used_at: token.lastUsedAt, revoked_at: token.revokedAt,
    }).execute());
  }

  async findApiTokenByHash(tokenHash: string): Promise<ApiTokenRecord | null> {
    const row = await this.db.selectFrom("api_tokens").select(TOKEN_COLUMNS).where("token_hash", "=", tokenHash).executeTakeFirst();
    return row ? toToken(row) : null;
  }

  async touchApiToken(id: string, lastUsedAt: number): Promise<void> {
    await this.write(tx => tx.updateTable("api_tokens").set({ last_used_at: lastUsedAt }).where("id", "=", id).execute());
  }

  async listApiTokens(accountId: string): Promise<ApiTokenRecord[]> {
    const rows = await this.db.selectFrom("api_tokens").select(TOKEN_COLUMNS).where("account_id", "=", accountId)
      .orderBy("created_at", "desc").execute();
    return rows.map(toToken);
  }

  async revokeApiToken(id: string, now: number): Promise<boolean> {
    return this.write(async tx => {
      const result = await tx.updateTable("api_tokens").set({ revoked_at: now }).where("id", "=", id).where("revoked_at", "is", null).executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    });
  }

  private write<T>(action: (tx: Transaction<DatabaseSchema>) => Promise<T>): Promise<T> {
    const run = () => this.db.transaction().execute(action);
    return this.dialect === "sqlite" ? withSqliteWriteLock(this.db, run) : run();
  }
}
