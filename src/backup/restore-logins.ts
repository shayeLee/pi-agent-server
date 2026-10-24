// A restored database starts with nobody logged in (docs/login-design.md §10): every web login
// (auth_sessions) is removed and every personal API token still in use is revoked, inside the
// same transaction that publishes the restore. A backup older than migration 7 has no such tables.

import type { DatabaseSync } from "node:sqlite";
import type { PgBackupClient } from "./postgres-backup-core.js";

export type RestoredLogins = { readonly authSessionsCleared: number; readonly apiTokensRevoked: number };

export const NO_RESTORED_LOGINS: RestoredLogins = { authSessionsCleared: 0, apiTokensRevoked: 0 };

/** SQLite: call inside the remap transaction on the staged copy. */
export function resetRestoredLoginsSqlite(db: DatabaseSync, now = Date.now()): RestoredLogins {
  const present = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (!present("auth_sessions") || !present("api_tokens")) return NO_RESTORED_LOGINS;
  const sessions = db.prepare("DELETE FROM auth_sessions").run();
  const tokens = db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE revoked_at IS NULL").run(now);
  return { authSessionsCleared: Number(sessions.changes), apiTokensRevoked: Number(tokens.changes) };
}

/**
 * PostgreSQL: call inside the remap transaction, before COMMIT, for a restored ledger at version 7
 * or later (the restore has already checked the schema against that ledger). `qschema` is quoted.
 */
export async function resetRestoredLoginsPostgres(client: PgBackupClient, qschema: string, now = Date.now()): Promise<RestoredLogins> {
  const sessions = await client.query(`DELETE FROM ${qschema}."auth_sessions" RETURNING 1 AS gone`);
  const tokens = await client.query(`UPDATE ${qschema}."api_tokens" SET revoked_at = $1 WHERE revoked_at IS NULL RETURNING 1 AS gone`, [now]);
  return { authSessionsCleared: sessions.rows.length, apiTokensRevoked: tokens.rows.length };
}
