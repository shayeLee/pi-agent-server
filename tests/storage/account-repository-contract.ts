// Accounts store + AuthService behaviour over a real database. Registered for SQLite (tests/storage)
// and PostgreSQL (tests/postgres).
import { describe, expect, it } from "vitest";
import { KyselyAccountRepository } from "../../src/storage/kysely-account-repository.js";
import { AuthError, AuthService, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from "../../src/auth/auth-service.js";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";

export interface AccountContractStorage {
  readonly kysely: Kysely<DatabaseSchema>;
  readonly dialect: "sqlite" | "postgres";
  /** Every row of the four account tables, to check that no plaintext secret is stored. */
  rawRows(): Promise<unknown>;
  close(): Promise<void>;
}

const PASSWORD = "correct horse battery";
const DAY = 24 * 60 * 60 * 1000;

export function defineAccountRepositoryContract(name: string, setup: () => Promise<AccountContractStorage>): void {
  describe(name, () => {
    async function withAuth(run: (ctx: { auth: AuthService; store: KyselyAccountRepository; clock: { now: number }; storage: AccountContractStorage }) => Promise<void>): Promise<void> {
      const storage = await setup();
      const clock = { now: 1_792_200_000_000 };
      const store = new KyselyAccountRepository(storage.kysely, storage.dialect);
      try {
        await run({ auth: new AuthService(store, { now: () => clock.now }), store, clock, storage });
      } finally {
        await storage.close();
      }
    }

    it("creates an account with a password and logs in; only hashes reach the database", () => withAuth(async ({ auth, storage }) => {
      const account = await auth.createAccount("mz", "admin", PASSWORD);
      expect(account).toMatchObject({ name: "mz", role: "admin", disabled: false });
      const login = await auth.login("mz", PASSWORD, "Mozilla/5.0\nTest");
      expect(login?.account.id).toBe(account.id);
      expect(login?.session.label).toBe("Mozilla/5.0 Test");
      const { token } = await auth.issueToken("mz", "claude-desktop");
      const raw = JSON.stringify(await storage.rawRows());
      expect(raw).not.toContain(PASSWORD);
      expect(raw).not.toContain(login!.sessionToken);
      expect(raw).not.toContain(token);
      expect(raw).toContain("scrypt$32768$8$1$");
    }));

    it("refuses bad names, roles, short passwords and duplicate names", () => withAuth(async ({ auth }) => {
      await expect(auth.createAccount("MZ", "admin", PASSWORD)).rejects.toMatchObject({ code: "invalid_name" });
      await expect(auth.createAccount("a".repeat(33), "admin", PASSWORD)).rejects.toMatchObject({ code: "invalid_name" });
      await expect(auth.createAccount("mz", "root", PASSWORD)).rejects.toMatchObject({ code: "invalid_role" });
      await expect(auth.createAccount("mz", "admin", "short")).rejects.toMatchObject({ code: "password_too_weak" });
      await auth.createAccount("mz", "admin", PASSWORD);
      await expect(auth.createAccount("mz", "user", PASSWORD)).rejects.toBeInstanceOf(AuthError);
    }));

    it("gives the same null for an unknown account, a wrong password and a disabled account", () => withAuth(async ({ auth }) => {
      await auth.createAccount("mz", "user", PASSWORD);
      expect(await auth.login("nobody", PASSWORD)).toBeNull();
      expect(await auth.login("mz", `${PASSWORD}!`)).toBeNull();
      await auth.disable("mz");
      expect(await auth.login("mz", PASSWORD)).toBeNull();
      await auth.enable("mz");
      expect(await auth.login("mz", PASSWORD)).not.toBeNull();
    }));

    it("ends a browser session after 30 days, or after 14 days without use; use is recorded once a day", () => withAuth(async ({ auth, store, clock }) => {
      const account = await auth.createAccount("mz", "user", PASSWORD);
      const { sessionToken, session } = (await auth.login("mz", PASSWORD))!;
      clock.now += DAY - 1;
      expect(await auth.authenticateSession(sessionToken)).toMatchObject({ via: "cookie", sessionId: session.id });
      expect((await store.listAuthSessions(account.id))[0]!.lastSeenAt).toBe(session.lastSeenAt);
      clock.now += 1;
      await auth.authenticateSession(sessionToken);
      expect((await store.listAuthSessions(account.id))[0]!.lastSeenAt).toBe(clock.now);

      clock.now += SESSION_IDLE_MS;
      expect(await auth.authenticateSession(sessionToken)).toBeNull();

      const fresh = (await auth.login("mz", PASSWORD))!;
      for (let used = 0; used < 30; used++) {
        clock.now += DAY;
        if (clock.now < fresh.session.expiresAt) expect(await auth.authenticateSession(fresh.sessionToken)).not.toBeNull();
      }
      expect(clock.now).toBeGreaterThanOrEqual(fresh.session.createdAt + SESSION_ABSOLUTE_MS);
      expect(await auth.authenticateSession(fresh.sessionToken)).toBeNull();
      expect(await auth.authenticateSession("not-a-session")).toBeNull();
    }));

    it("logout, kick, set-password and disable end browser sessions at once", () => withAuth(async ({ auth, store }) => {
      const account = await auth.createAccount("mz", "user", PASSWORD);
      const a = (await auth.login("mz", PASSWORD))!;
      const b = (await auth.login("mz", PASSWORD))!;
      const c = (await auth.login("mz", PASSWORD))!;
      await auth.logout(a.session.id);
      expect(await auth.authenticateSession(a.sessionToken)).toBeNull();
      await auth.kick(b.session.id);
      expect(await auth.authenticateSession(b.sessionToken)).toBeNull();
      await expect(auth.kick(b.session.id)).rejects.toMatchObject({ code: "session_not_found" });
      expect(await auth.authenticateSession(c.sessionToken)).not.toBeNull();
      await auth.setPassword("mz", "another long password");
      expect(await auth.authenticateSession(c.sessionToken)).toBeNull();
      expect(await auth.login("mz", PASSWORD)).toBeNull();
      const d = (await auth.login("mz", "another long password"))!;
      await auth.disable("mz");
      expect(await auth.authenticateSession(d.sessionToken)).toBeNull();
      expect(await store.listAuthSessions(account.id)).toEqual([]);
    }));

    it("changing the password checks the current one, signs every browser out and issues a new session", () => withAuth(async ({ auth }) => {
      const account = await auth.createAccount("mz", "user", PASSWORD);
      const mine = (await auth.login("mz", PASSWORD))!;
      const other = (await auth.login("mz", PASSWORD))!;
      expect(await auth.changePassword(account.id, "wrong password!!", "brand new password")).toEqual({ ok: false, reason: "invalid_current" });
      expect(await auth.changePassword(account.id, PASSWORD, "short")).toEqual({ ok: false, reason: "password_too_weak" });
      const changed = await auth.changePassword(account.id, PASSWORD, "brand new password");
      expect(changed.ok).toBe(true);
      expect(await auth.authenticateSession(mine.sessionToken)).toBeNull();
      expect(await auth.authenticateSession(other.sessionToken)).toBeNull();
      expect(await auth.authenticateSession(changed.ok ? changed.sessionToken : "")).not.toBeNull();
    }));

    it("personal tokens authenticate until revoked; disable revokes all; role changes apply to the next check", () => withAuth(async ({ auth, store, clock }) => {
      const account = await auth.createAccount("mz", "admin", PASSWORD);
      const first = await auth.issueToken("mz", "claude-desktop");
      const second = await auth.issueToken("mz", "script");
      expect(first.token.startsWith(first.record.prefix)).toBe(true);
      expect(await auth.authenticateToken(first.token)).toMatchObject({ via: "token", account: { id: account.id, role: "admin" } });
      expect((await store.findApiTokenByHash("missing"))).toBeNull();
      expect(await auth.authenticateToken(first.token.replace(/^pi_/, "xx_"))).toBeNull();

      await auth.setRole("mz", "viewer");
      expect(await auth.authenticateToken(first.token)).toMatchObject({ account: { role: "viewer" } });

      clock.now += 1;
      await auth.revokeToken(first.record.id);
      expect(await auth.authenticateToken(first.token)).toBeNull();
      await expect(auth.revokeToken(first.record.id)).rejects.toMatchObject({ code: "token_not_found" });
      expect(await auth.authenticateToken(second.token)).not.toBeNull();
      await auth.disable("mz");
      await auth.enable("mz");
      expect(await auth.authenticateToken(second.token)).toBeNull();
      expect((await auth.listTokens("mz")).every(token => token.revokedAt !== null)).toBe(true);
    }));

    it("lists accounts by name and keeps timestamps beyond 32-bit integers", () => withAuth(async ({ auth }) => {
      await auth.createAccount("zed", "viewer", PASSWORD);
      await auth.createAccount("amy", "operator", PASSWORD);
      const accounts = await auth.listAccounts();
      expect(accounts.map(a => [a.name, a.role])).toEqual([["amy", "operator"], ["zed", "viewer"]]);
      expect(accounts[0]!.createdAt).toBe(1_792_200_000_000);
      await expect(auth.requireAccount("ghost")).rejects.toMatchObject({ code: "account_not_found" });
    }));
  });
}
