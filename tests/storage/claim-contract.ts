// `accounts claim` over a real database (docs/login-design.md §8). Registered for SQLite
// (tests/storage) and PostgreSQL (tests/postgres).
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";
import { McpTokenCipher } from "../../src/mcp/token-cipher.js";
import { CLAIM_TABLES, runClaim, type ClaimTable } from "../../src/accounts-cli/claim.js";
import { parseAccountsArgs, runAccountsCommand, AccountsUsageError } from "../../src/accounts-cli/accounts-cli.js";
import { AuthService } from "../../src/auth/auth-service.js";
import { KyselyAccountRepository } from "../../src/storage/kysely-account-repository.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";

export interface ClaimContractStorage {
  readonly kysely: Kysely<DatabaseSchema>;
  readonly dialect: "sqlite" | "postgres";
  close(): Promise<void>;
}

const FROM = "ip:127.0.0.1";
const OTHER = "ip:10.0.0.2";
const aad = (owner: string, server: string) => JSON.stringify(["user_mcp_credentials", owner, server]);

const sessionRow = (id: string, owner: string, project: string) => ({
  id, owner_key: owner, project_id: project, title: id, created_at: 1, updated_at: 1,
  visibility: "private", origin: "managed", kind: "chat", agent_kind: "pi", conversation_format: "pi-jsonl-v3", conversation_ref: null,
  model_provider: null, model_id: null, thinking_level: null,
});

type Ids = { mine: string; theirs: string; s1: string; s2: string; native: string; other: string; f1: string };
type Fixture = { db: Kysely<DatabaseSchema>; cipher: McpTokenCipher; to: string; auth: AuthService; ids: Ids };

async function seed(storage: ClaimContractStorage): Promise<Fixture> {
  const db = storage.kysely;
  const cipher = new McpTokenCipher(randomBytes(32));
  const auth = new AuthService(new KyselyAccountRepository(db, storage.dialect));
  const account = await auth.createAccount("mz", "admin", "correct horse battery");
  const to = `user:${account.id}`;
  const ids: Ids = { mine: randomUUID(), theirs: randomUUID(), s1: randomUUID(), s2: randomUUID(), native: randomUUID(), other: randomUUID(), f1: randomUUID() };
  await db.insertInto("projects").values([
    { id: DEFAULT_PROJECT_ID, name: "默认项目", cwd: "/w", owner_key: "", created_at: 1 },
    { id: ids.mine, name: "mine", cwd: "/w/mine", owner_key: FROM, created_at: 1 },
    { id: ids.theirs, name: "theirs", cwd: "/w/theirs", owner_key: OTHER, created_at: 1 },
  ]).execute();
  await db.insertInto("sessions").values([
    sessionRow(ids.s1, FROM, ids.mine),
    sessionRow(ids.s2, FROM, DEFAULT_PROJECT_ID),
    sessionRow(ids.native, "", DEFAULT_PROJECT_ID),
    sessionRow(ids.other, OTHER, ids.theirs),
  ]).execute();
  await db.insertInto("uploaded_files").values({
    id: ids.f1, owner_key: FROM, project_id: ids.mine, upload_key: "k1", name: "a.txt", media_type: "text/plain", size: 1,
    checksum: "c", storage_key: "s", agent_path: "/p", status: "ready", created_at: 1, session_id: null,
  }).execute();
  await db.insertInto("companion_personas").values({ owner_key: FROM, name: "小派", style: "lively", docked: 1, updated_at: 1 }).execute();
  await db.insertInto("butlers").values({ owner_key: FROM, session_id: ids.s2, created_at: 1 }).execute();
  await db.insertInto("user_mcp_credentials").values(["linear", "docs"].map(server => ({
    owner_key: FROM, server_name: server, server_url: `https://${server}.example/mcp`, client_id: "c", account_label: null,
    tokens: cipher.encrypt(JSON.stringify({ access_token: `${server}-token`, token_type: "bearer" }), aad(FROM, server)),
    expires_at: null, scope: null, discovery: null, created_at: 1, updated_at: 1,
  }))).execute();
  return { db, cipher, to, auth, ids };
}

async function owners(db: Kysely<DatabaseSchema>): Promise<Record<ClaimTable, string[]>> {
  const result = {} as Record<ClaimTable, string[]>;
  for (const table of CLAIM_TABLES) {
    const rows = await db.selectFrom(table).select(["owner_key"]).execute();
    result[table] = rows.map(row => row.owner_key).sort();
  }
  return result;
}

export function defineClaimContract(name: string, setup: () => Promise<ClaimContractStorage>): void {
  describe(name, () => {
    async function withFixture(run: (fixture: Fixture & { storage: ClaimContractStorage }) => Promise<void>) {
      const storage = await setup();
      try { await run({ ...(await seed(storage)), storage }); } finally { await storage.close(); }
    }

    it("a dry run reports and changes nothing; apply moves exactly the source's rows", () => withFixture(async ({ db, cipher, to, storage }) => {
      const before = await owners(db);
      const base = { kysely: db, dialect: storage.dialect, cipher, from: FROM, to, dropUnreadableCredentials: false };
      const preview = await runClaim({ ...base, dryRun: true });
      expect(preview.applied).toBe(false);
      expect(preview.plan.counts).toEqual({ projects: 1, sessions: 2, uploaded_files: 1, companion_personas: 1, butlers: 1, user_mcp_credentials: 2 });
      expect(preview.plan).toMatchObject({ conflicts: [], misplaced: [], unreadableCredentials: [] });
      expect(await owners(db)).toEqual(before);

      const result = await runClaim({ ...base, dryRun: false });
      expect(result.applied).toBe(true);
      const after = await owners(db);
      expect(after.projects).toEqual(["", OTHER, to].sort());
      expect(after.sessions).toEqual(["", OTHER, to, to].sort());
      expect(after.uploaded_files).toEqual([to]);
      expect(after.companion_personas).toEqual([to]);
      expect(after.butlers).toEqual([to]);
      expect(after.user_mcp_credentials).toEqual([to, to]);

      // Credentials now open only as the new owner's rows.
      for (const row of await db.selectFrom("user_mcp_credentials").selectAll().execute()) {
        expect(JSON.parse(cipher.decrypt(row.tokens, aad(to, row.server_name)))).toMatchObject({ access_token: `${row.server_name}-token` });
        expect(() => cipher.decrypt(row.tokens, aad(FROM, row.server_name))).toThrow();
      }
      // Nothing is left to claim.
      expect((await runClaim({ ...base, dryRun: true })).plan.counts).toEqual({ projects: 0, sessions: 0, uploaded_files: 0, companion_personas: 0, butlers: 0, user_mcp_credentials: 0 });
    }));

    it("refuses on a collision at the target, or a source row in someone else's project, and changes nothing", () => withFixture(async ({ db, cipher, to, ids, storage }) => {
      const base = { kysely: db, dialect: storage.dialect, cipher, from: FROM, to, dryRun: false, dropUnreadableCredentials: false };
      await db.insertInto("companion_personas").values({ owner_key: to, name: "派", style: "formal", docked: 1, updated_at: 2 }).execute();
      await db.insertInto("user_mcp_credentials").values({
        owner_key: to, server_name: "linear", server_url: "https://linear.example/mcp", client_id: "c", account_label: null,
        tokens: "v1.x.y", expires_at: null, scope: null, discovery: null, created_at: 1, updated_at: 1,
      }).execute();
      await db.insertInto("uploaded_files").values({
        id: randomUUID(), owner_key: to, project_id: ids.mine, upload_key: "k1", name: "b.txt", media_type: "text/plain", size: 1,
        checksum: "c", storage_key: "s2", agent_path: "/p2", status: "ready", created_at: 1, session_id: null,
      }).execute();
      await db.insertInto("sessions").values(sessionRow(randomUUID(), FROM, ids.theirs)).execute();
      const targetButler = randomUUID();
      await db.insertInto("sessions").values(sessionRow(targetButler, to, DEFAULT_PROJECT_ID)).execute();
      await db.insertInto("butlers").values({ owner_key: to, session_id: targetButler, created_at: 2 }).execute();
      const before = await owners(db);

      const plan = (await runClaim({ ...base, dryRun: true })).plan;
      expect(plan.conflicts).toHaveLength(4);
      expect(plan.misplaced).toHaveLength(1);
      const error = await runClaim(base).then(() => new Error("not refused"), (caught: unknown) => caught as Error);
      expect(error.message).toContain("companion_personas");
      expect(error.message).toContain("linear");
      expect(error.message).toContain("上传键");
      expect(error.message).toContain("管家");
      expect(error.message).toContain(ids.theirs);
      expect(await owners(db)).toEqual(before);
    }));

    it("refuses credentials that do not decrypt with this key, unless told to drop them", () => withFixture(async ({ db, to, storage }) => {
      const wrongKey = new McpTokenCipher(randomBytes(32));
      const base = { kysely: db, dialect: storage.dialect, from: FROM, to, dryRun: false };
      const before = await owners(db);
      for (const cipher of [wrongKey, null]) {
        await expect(runClaim({ ...base, cipher, dropUnreadableCredentials: false })).rejects.toThrow(/2 条 MCP 凭证.*linear|2 条 MCP 凭证.*docs/);
        expect(await owners(db)).toEqual(before);
      }
      const result = await runClaim({ ...base, cipher: wrongKey, dropUnreadableCredentials: true });
      expect([...result.dropped].sort()).toEqual(["docs", "linear"]);
      const after = await owners(db);
      expect(after.user_mcp_credentials).toEqual([]);
      expect(after.sessions.filter(owner => owner === to)).toHaveLength(2);
    }));

    it("the command checks its arguments and names what it did", () => withFixture(async ({ db, cipher, auth, to, storage }) => {
      const store = { kysely: db, dialect: storage.dialect, cipher };
      const run = (...argv: string[]) => runAccountsCommand(parseAccountsArgs(argv), auth, async () => "", store);
      for (const argv of [
        ["claim", "--from", FROM, "--name", "mz"],
        ["claim", "--from", FROM, "--name", "mz", "--dry-run", "--maintenance-window", "CONFIRMED"],
        ["claim", "--from", FROM, "--name", "mz", "--maintenance-window", "confirmed"],
        ["claim", "--from", "", "--name", "mz", "--dry-run"],
        ["claim", "--from", "127.0.0.1", "--name", "mz", "--dry-run"],
        ["claim", "--from", to, "--name", "mz", "--dry-run"],
      ]) {
        await expect(run(...argv), argv.join(" ")).rejects.toThrow(AccountsUsageError);
      }
      await expect(run("claim", "--from", FROM, "--name", "ghost", "--dry-run")).rejects.toThrow("账号不存在");
      const preview = await run("claim", "--from", FROM, "--name", "mz", "--dry-run");
      expect(preview[0]).toBe(`预演：将把 ${FROM} 的数据转给账号 mz（${to}）`);
      expect(preview.at(-1)).toContain("检查通过");
      const applied = await run("claim", "--from", FROM, "--name", "mz", "--maintenance-window", "CONFIRMED");
      expect(applied[0]).toBe(`已把 ${FROM} 的数据转给账号 mz（${to}）`);
      expect(applied.at(-1)).toBe(`owner 映射：${FROM} → ${to}（插件若按 owner 存了数据，按这个映射自行迁移）`);
    }));
  });
}
