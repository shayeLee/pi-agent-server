import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AccountsUsageError, parseAccountsArgs, runAccountsCommand } from "../../src/accounts-cli/accounts-cli.js";
import { AuthService } from "../../src/auth/auth-service.js";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { KyselyAccountRepository } from "../../src/storage/kysely-account-repository.js";

const PASSWORD = "correct horse battery";

describe("parseAccountsArgs", () => {
  it("accepts the pnpm -- separator and the flags each command needs", () => {
    expect(parseAccountsArgs(["--", "create", "--name", "mz", "--role", "admin"])).toEqual({ command: "create", options: { name: "mz", role: "admin" }, needsPassword: true });
    expect(parseAccountsArgs(["list"])).toEqual({ command: "list", options: {}, needsPassword: false });
    expect(parseAccountsArgs(["kick", "--session", "s1"]).options).toEqual({ session: "s1" });
  });

  it("refuses unknown commands, missing, repeated or unexpected flags, and a password argument", () => {
    for (const argv of [[], ["--help"], ["drop"], ["create", "--name", "mz"], ["create", "--name", "mz", "--role", "admin", "--name", "x"],
      ["set-password", "--name", "mz", "--password", "secret"], ["list", "--name"], ["disable", "--name", "--role"]]) {
      expect(() => parseAccountsArgs(argv), argv.join(" ")).toThrow(AccountsUsageError);
    }
  });
});

describe("runAccountsCommand", () => {
  it("runs each command against the account store", async () => {
    const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    const kysely = await initializeDatabase(db);
    try {
      const auth = new AuthService(new KyselyAccountRepository(kysely, "sqlite"));
      const run = (...argv: string[]) => runAccountsCommand(parseAccountsArgs(argv), auth, async () => PASSWORD);
      expect((await run("list"))).toEqual(["还没有账号"]);
      expect((await run("create", "--name", "mz", "--role", "admin"))[0]).toMatch(/^已创建账号 mz（admin）/);
      await expect(run("create", "--name", "mz", "--role", "admin")).rejects.toThrow("账号名已存在");
      await expect(run("set-role", "--name", "mz", "--role", "root")).rejects.toThrow(AccountsUsageError);
      await run("set-role", "--name", "mz", "--role", "user");
      expect((await run("list"))[0]).toMatch(/^mz\tuser\t正常\t/);

      const issued = await run("issue-token", "--name", "mz", "--label", "claude-desktop");
      const token = issued[1]!;
      expect(token).toMatch(/^pi_/);
      expect(await auth.authenticateToken(token)).not.toBeNull();
      const [row] = await run("tokens", "--name", "mz");
      const tokenId = row!.split("\t")[0]!;
      expect(row).toContain(`${token.slice(0, 8)}…\tclaude-desktop`);
      expect(row).not.toContain(token);

      const login = await auth.login("mz", PASSWORD);
      expect((await run("sessions", "--name", "mz"))[0]).toContain(login!.session.id);
      await run("kick", "--session", login!.session.id);
      expect(await run("sessions", "--name", "mz")).toEqual(["没有已登录的设备"]);

      await run("revoke-token", "--id", tokenId);
      expect(await auth.authenticateToken(token)).toBeNull();
      await expect(run("revoke-token", "--id", tokenId)).rejects.toThrow(AccountsUsageError);

      await run("disable", "--name", "mz");
      expect((await run("list"))[0]).toContain("已禁用");
      await run("enable", "--name", "mz");
      await run("set-password", "--name", "mz");
      await expect(run("disable", "--name", "ghost")).rejects.toThrow("账号不存在");
    } finally {
      await kysely.destroy();
    }
  });
});

describe("scripts/accounts.ts", () => {
  const repo = path.resolve(import.meta.dirname, "../..");
  const cli = (env: NodeJS.ProcessEnv, args: string[], input?: string) =>
    spawnSync(process.execPath, ["--import", "tsx", path.join(repo, "scripts/accounts.ts"), "--", ...args], {
      // NODE_NO_WARNINGS: Node 22 prints an ExperimentalWarning for node:sqlite on stderr.
      cwd: repo, env: { ...process.env, NODE_NO_WARNINGS: "1", ...env }, input, encoding: "utf8", timeout: 60_000,
    });

  it("creates an account with a password from stdin and issues a token, on the configured database", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-accounts-cli-"));
    try {
      const dbPath = path.join(dir, "pi.db");
      const setup = new DatabaseSync(dbPath);
      const kysely = await initializeDatabase(setup);
      await kysely.destroy();
      const env = { DB_PATH: dbPath, PI_STORAGE_DIALECT: "" };

      const created = cli(env, ["create", "--name", "mz", "--role", "admin"], `${PASSWORD}\n`);
      expect(created.stderr).toBe("");
      expect(created.status).toBe(0);
      expect(created.stdout).toMatch(/^已创建账号 mz（admin）/);
      const issued = cli(env, ["issue-token", "--name", "mz", "--label", "bridge"]);
      expect(issued.status).toBe(0);
      const token = issued.stdout.trim().split("\n")[1]!;

      const db = new DatabaseSync(dbPath);
      const check = await initializeDatabase(db);
      try {
        const auth = new AuthService(new KyselyAccountRepository(check, "sqlite"));
        expect(await auth.login("mz", PASSWORD)).not.toBeNull();
        expect((await auth.authenticateToken(token))?.account.role).toBe("admin");
      } finally {
        await check.destroy();
      }

      const usage = cli(env, ["create", "--name", "mz"]);
      expect(usage.status).toBe(2);
      const missing = cli({ DB_PATH: path.join(dir, "missing.db"), PI_STORAGE_DIALECT: "" }, ["list"]);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("数据库不存在");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
