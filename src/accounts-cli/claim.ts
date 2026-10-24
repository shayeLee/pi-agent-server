// `pnpm accounts -- claim`: move one owner's data to an account (docs/login-design.md §8, step 5–6).
//
// - Reads raw rows, not the repositories (those read an undecryptable credential as "absent").
// - Changes only rows whose owner_key is exactly the source owner, in the five tables that carry an
//   owner: projects, sessions, uploaded_files, companion_personas, user_mcp_credentials. The default
//   project, system projects and native sessions (owner '') are never touched.
// - Refuses, and changes nothing, when: a unique constraint would collide at the target (persona,
//   credential (owner, server), upload (owner, project, key)); a session or upload of the source sits
//   in a project that belongs to a third owner; a credential does not decrypt with this key (unless
//   --drop-unreadable-credentials, which deletes those rows and lists them).
// - Credentials are encrypted with the owner in their associated data, so they are decrypted and
//   re-encrypted for the new owner.
// - Apply redoes every check inside one transaction and compares the changed row counts with them
//   before committing. It is meant to run with the service stopped (--maintenance-window CONFIRMED).

import { sql, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema } from "../storage/db-schema.js";
import type { McpTokenCipher } from "../mcp/token-cipher.js";
import { withSqliteWriteLock } from "../storage/sqlite-write-lock.js";
import { POSTGRES_MIGRATION_LOCK_KEY } from "../storage/migration-engine.js";

type Db = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export const CLAIM_TABLES = ["projects", "sessions", "uploaded_files", "companion_personas", "user_mcp_credentials"] as const;
export type ClaimTable = (typeof CLAIM_TABLES)[number];

export type ClaimPlan = {
  readonly from: string;
  readonly to: string;
  readonly counts: Readonly<Record<ClaimTable, number>>;
  /** Server names of the source's credentials that do not decrypt with this key. */
  readonly unreadableCredentials: readonly string[];
  /** Unique constraints that would collide at the target. */
  readonly conflicts: readonly string[];
  /** Source rows in a project of a third owner. */
  readonly misplaced: readonly string[];
};

export class ClaimRefusedError extends Error {}

const credentialAad = (ownerKey: string, serverName: string) => JSON.stringify(["user_mcp_credentials", ownerKey, serverName]);

/** An owner key this command may move from: `ip:<address>` or `user:<id>`, never the system owner ''. */
export function isClaimableOwner(owner: string): boolean {
  return /^(ip|user):\S+$/.test(owner);
}

function decrypts(cipher: McpTokenCipher | null, ciphertext: string, aad: string): boolean {
  if (!cipher) return false;
  try { cipher.decrypt(ciphertext, aad); return true; } catch { return false; }
}

export async function planClaim(db: Db, cipher: McpTokenCipher | null, from: string, to: string): Promise<ClaimPlan> {
  const projects = await db.selectFrom("projects").select(["id"]).where("owner_key", "=", from).execute();
  const sessions = await db.selectFrom("sessions").select(["id", "project_id"]).where("owner_key", "=", from).execute();
  const uploads = await db.selectFrom("uploaded_files").select(["id", "project_id", "upload_key"]).where("owner_key", "=", from).execute();
  const personas = await db.selectFrom("companion_personas").select(["owner_key"]).where("owner_key", "=", from).execute();
  const credentials = await db.selectFrom("user_mcp_credentials").select(["server_name", "tokens"]).where("owner_key", "=", from).execute();

  const conflicts: string[] = [];
  if (personas.length > 0) {
    const taken = await db.selectFrom("companion_personas").select(["owner_key"]).where("owner_key", "=", to).executeTakeFirst();
    if (taken) conflicts.push("companion_personas：目标账号已有数字人设置");
  }
  if (credentials.length > 0) {
    const taken = await db.selectFrom("user_mcp_credentials").select(["server_name"]).where("owner_key", "=", to)
      .where("server_name", "in", credentials.map(row => row.server_name)).execute();
    for (const row of taken) conflicts.push(`user_mcp_credentials：目标账号已连接 MCP server ${row.server_name}`);
  }
  if (uploads.length > 0) {
    const taken = await db.selectFrom("uploaded_files").select(["project_id", "upload_key"]).where("owner_key", "=", to).execute();
    const keys = new Set(taken.map(row => `${row.project_id}\u0000${row.upload_key}`));
    for (const row of uploads) {
      if (keys.has(`${row.project_id}\u0000${row.upload_key}`)) conflicts.push(`uploaded_files：目标账号在项目 ${row.project_id} 已有同一上传键的文件 ${row.id}`);
    }
  }

  // Projects the source's sessions and uploads sit in must be the source's own or the system's.
  const projectIds = [...new Set([...sessions.map(row => row.project_id), ...uploads.map(row => row.project_id)])];
  const owners = projectIds.length === 0 ? [] : await db.selectFrom("projects").select(["id", "owner_key"]).where("id", "in", projectIds).execute();
  const ownerOf = new Map(owners.map(row => [row.id, row.owner_key]));
  const foreign = (projectId: string) => {
    const owner = ownerOf.get(projectId);
    return owner !== undefined && owner !== from && owner !== "";
  };
  const misplaced = [
    ...sessions.filter(row => foreign(row.project_id)).map(row => `会话 ${row.id} 在别人的项目 ${row.project_id} 里`),
    ...uploads.filter(row => foreign(row.project_id)).map(row => `上传 ${row.id} 在别人的项目 ${row.project_id} 里`),
  ];

  const unreadableCredentials = credentials
    .filter(row => !decrypts(cipher, row.tokens, credentialAad(from, row.server_name)))
    .map(row => row.server_name);

  return {
    from, to, unreadableCredentials, conflicts, misplaced,
    counts: {
      projects: projects.length, sessions: sessions.length, uploaded_files: uploads.length,
      companion_personas: personas.length, user_mcp_credentials: credentials.length,
    },
  };
}

function refusals(plan: ClaimPlan, dropUnreadable: boolean): string[] {
  const reasons = [...plan.conflicts, ...plan.misplaced];
  if (plan.unreadableCredentials.length > 0 && !dropUnreadable) {
    reasons.push(`${plan.unreadableCredentials.length} 条 MCP 凭证用当前 PI_MCP_TOKEN_KEY_FILE 解不开：${plan.unreadableCredentials.join("、")}`
      + "（确认密钥；或加 --drop-unreadable-credentials 删除它们，之后重新授权）");
  }
  return reasons;
}

export type ClaimResult = { readonly plan: ClaimPlan; readonly dropped: readonly string[]; readonly applied: boolean };

/** Dry run: the plan and what would stop it. Apply: the same checks in one transaction, then the change. */
export async function runClaim(input: {
  kysely: Kysely<DatabaseSchema>;
  dialect: "sqlite" | "postgres";
  cipher: McpTokenCipher | null;
  from: string;
  to: string;
  dryRun: boolean;
  dropUnreadableCredentials: boolean;
}): Promise<ClaimResult> {
  const { kysely, dialect, cipher, from, to, dropUnreadableCredentials } = input;
  if (input.dryRun) {
    const plan = await planClaim(kysely, cipher, from, to);
    return { plan, dropped: [], applied: false };
  }
  const run = () => kysely.transaction().execute(async trx => {
    // Same key as migrations: a claim and a migration never interleave.
    if (dialect === "postgres") await sql`SELECT pg_advisory_xact_lock(${POSTGRES_MIGRATION_LOCK_KEY})`.execute(trx);
    const plan = await planClaim(trx, cipher, from, to);
    const reasons = refusals(plan, dropUnreadableCredentials);
    if (reasons.length > 0) throw new ClaimRefusedError(reasons.join("\n"));

    const changed = (result: { numUpdatedRows?: bigint; numDeletedRows?: bigint }) => Number(result.numUpdatedRows ?? result.numDeletedRows ?? 0n);
    const expect = (table: string, actual: number, wanted: number) => {
      if (actual !== wanted) throw new ClaimRefusedError(`${table} 改动 ${actual} 行，与检查时的 ${wanted} 行不一致，已回滚`);
    };

    // Credentials first: drop the unreadable ones, re-encrypt the rest for the new owner.
    const dropped = [...plan.unreadableCredentials];
    if (dropped.length > 0) {
      const result = await trx.deleteFrom("user_mcp_credentials").where("owner_key", "=", from).where("server_name", "in", dropped).executeTakeFirst();
      expect("user_mcp_credentials（删除）", changed(result), dropped.length);
    }
    const credentials = await trx.selectFrom("user_mcp_credentials").select(["server_name", "tokens"]).where("owner_key", "=", from).execute();
    expect("user_mcp_credentials", credentials.length + dropped.length, plan.counts.user_mcp_credentials);
    for (const row of credentials) {
      const tokens = cipher!.encrypt(cipher!.decrypt(row.tokens, credentialAad(from, row.server_name)), credentialAad(to, row.server_name));
      const result = await trx.updateTable("user_mcp_credentials").set({ owner_key: to, tokens })
        .where("owner_key", "=", from).where("server_name", "=", row.server_name).executeTakeFirst();
      expect("user_mcp_credentials", changed(result), 1);
    }

    for (const table of ["projects", "sessions", "uploaded_files", "companion_personas"] as const) {
      const result = await trx.updateTable(table).set({ owner_key: to }).where("owner_key", "=", from).executeTakeFirst();
      expect(table, changed(result), plan.counts[table]);
    }
    return { plan, dropped, applied: true };
  });
  return dialect === "sqlite" ? withSqliteWriteLock(kysely, run) : run();
}

/** Lines for the terminal. */
export function describeClaim(result: ClaimResult, accountName: string, dropUnreadable: boolean): string[] {
  const { plan } = result;
  const lines = [
    `${result.applied ? "已把" : "预演：将把"} ${plan.from} 的数据转给账号 ${accountName}（${plan.to}）`,
    ...CLAIM_TABLES.map(table => `  ${table}\t${plan.counts[table]} 行`),
  ];
  if (result.applied) {
    if (result.dropped.length > 0) lines.push(`已删除解不开的 MCP 凭证，需要重新授权：${result.dropped.join("、")}`);
    lines.push(`owner 映射：${plan.from} → ${plan.to}（插件若按 owner 存了数据，按这个映射自行迁移）`);
    return lines;
  }
  const reasons = [...plan.conflicts, ...plan.misplaced];
  if (plan.unreadableCredentials.length > 0) {
    if (dropUnreadable) lines.push(`执行时将删除解不开的 MCP 凭证：${plan.unreadableCredentials.join("、")}`);
    else reasons.push(`MCP 凭证用当前 PI_MCP_TOKEN_KEY_FILE 解不开：${plan.unreadableCredentials.join("、")}（确认密钥，或加 --drop-unreadable-credentials）`);
  }
  if (reasons.length === 0) lines.push("检查通过；停服后去掉 --dry-run、加 --maintenance-window CONFIRMED 执行");
  else lines.push("执行时会拒绝：", ...reasons.map(reason => `  ${reason}`));
  return lines;
}
