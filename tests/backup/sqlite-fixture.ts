// Shared canonical SQLite head builder for backup tests.
//
// Backup fixtures use every immutable migration operation and record the full
// authenticated ledger through the current head, matching migrate apply/verify.

import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import { migrationChecksum, migrationDefinitions } from "../../src/storage/migration-manifest.js";

/** Build a published canonical migration prefix and its authenticated ledger. */
export function createCanonicalSqlitePrefix(db: DatabaseSync, appliedThrough: number): void {
  if (!Number.isSafeInteger(appliedThrough) || appliedThrough < 0 || appliedThrough >= migrationDefinitions.length) throw new Error("invalid canonical SQLite migration prefix");
  const prefix = migrationDefinitions.slice(0, appliedThrough + 1);
  for (const migration of prefix) {
    for (const operation of migration.operations.SQLite) db.exec(operation.sql);
  }
  db.exec(
    "CREATE TABLE schema_migrations (" +
    "  version INTEGER PRIMARY KEY NOT NULL,\n" +
    "  name TEXT UNIQUE NOT NULL,\n" +
    "  checksum TEXT NOT NULL,\n" +
    "  applied_at INTEGER NOT NULL\n" +
    ")",
  );
  const insert = db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)");
  for (const migration of prefix) {
    insert.run(migration.version, migration.name, migrationChecksum(migration), 1);
  }
}

/** Build the complete current canonical schema + authenticated migration ledger. */
export function createCanonicalSqliteHead(db: DatabaseSync): void {
  createCanonicalSqlitePrefix(db, migrationDefinitions.at(-1)!.version);
}

/** Insert one canonical sessions row (only conversation_ref is caller-provided). */
export function insertCanonicalSession(db: DatabaseSync, id: string, file: string): void {
  // The canonical sessions.project_id FK references projects.id; ensure the
  // immutable DEFAULT_PROJECT_ID row exists so the inserted session is a valid
  // FK row (restore runs PRAGMA foreign_key_check and fails on any dangling FK).
  db.prepare(
    "INSERT OR IGNORE INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(DEFAULT_PROJECT_ID, "default", "/", "owner", 1);
  db.prepare(
    "INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, "owner", DEFAULT_PROJECT_ID, id, 1, 1, file);
}
