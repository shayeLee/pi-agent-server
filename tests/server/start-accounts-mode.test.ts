// startServer in accounts mode (docs/login-design.md §2): config checks before any resource, and the
// real composition wires the account store into request authentication.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type StartConfig } from "../../src/server/start.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { AuthService } from "../../src/auth/auth-service.js";
import { KyselyAccountRepository } from "../../src/storage/kysely-account-repository.js";
import { makeTestIpAccess } from "../helpers/ip-access.js";

const cleanups: string[] = [];
afterEach(() => { for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function baseConfig(overrides: Partial<StartConfig> = {}): StartConfig & { dbPath: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-start-accounts-")));
  cleanups.push(dir);
  return {
    port: 0,
    ipAccess: makeTestIpAccess(),
    dataDir: dir,
    nativeSessionSourceDir: join(dir, "native-fixture"),
    authPath: join(dir, "auth.json"),
    dbPath: join(dir, "pi-agent-server.db"),
    ...overrides,
  } as StartConfig & { dbPath: string };
}

describe("startServer accounts mode", () => {
  it("refuses to start without PI_PUBLIC_URL, or when PI_TRUSTED_ORIGINS leaves out the public origin, before opening the database", async () => {
    const missing = baseConfig({ authMode: "accounts" });
    await expect(startServer(missing)).rejects.toThrow(/PI_PUBLIC_URL/);
    expect(existsSync(missing.dbPath)).toBe(false);
    const narrow = baseConfig({ authMode: "accounts", publicUrl: "http://192.168.5.137:5180", trustedOrigins: "http://127.0.0.1:5173" });
    await expect(startServer(narrow)).rejects.toThrow(/PI_TRUSTED_ORIGINS/);
    await expect(startServer(baseConfig({ authMode: "Accounts" as never }))).rejects.toThrow(/PI_AUTH_MODE/);
  });

  it("authenticates requests against the migrated database", async () => {
    const config = baseConfig({ authMode: "accounts", publicUrl: "http://127.0.0.1:5180" });
    const setup = new DatabaseSync(config.dbPath);
    try {
      await runSqliteMigrations(setup, { mode: "apply" });
    } finally {
      setup.close();
    }
    const admin = new DatabaseSync(config.dbPath);
    const kysely = await initializeDatabase(admin);
    let token: string;
    try {
      const auth = new AuthService(new KyselyAccountRepository(kysely, "sqlite"));
      await auth.createAccount("mz", "admin", "correct horse battery");
      token = (await auth.issueToken("mz", "test")).token;
    } finally {
      await kysely.destroy();
    }

    const app = await startServer(config);
    try {
      expect((await app.inject({ method: "GET", url: "/v1/sessions" })).statusCode).toBe(401);
      const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${token}` } });
      expect(me.json()).toMatchObject({ account: { name: "mz", role: "admin" }, via: "token" });
      const login = await app.inject({
        method: "POST", url: "/v1/auth/login", headers: { "content-type": "application/json", origin: "http://127.0.0.1:5180" },
        payload: JSON.stringify({ name: "mz", password: "correct horse battery" }),
      });
      expect(login.statusCode).toBe(200);
      expect(String(login.headers["set-cookie"])).toMatch(/^pi_session_5180=/);
    } finally {
      await app.close();
    }
  }, 60_000);
});
