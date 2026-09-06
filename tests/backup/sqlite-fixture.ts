// Shared canonical SQLite baseline builder for backup tests.
//
// Real backup source databases must be the complete current canonical schema
// (tables / columns / PK / FK / indexes) with the canonical single-baseline
// ledger, exactly what restore's strict migrate-verify requires. A simplified
// sessions-only fixture can be backed up but fails restore's strict verify, so
// every backup fixture that exercises createSqliteBackup builds the real
// baseline here. The baseline is produced from the immutable registry
// operations (the same DDL the migrate runner applies) plus the canonical
// schema_migrations table.

import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import { migrationChecksum, migrationDefinitions } from "../../src/storage/migration-manifest.js";

/** Build the complete canonical schema + canonical single-baseline ledger. */
export function createCanonicalSqliteBaseline(db: DatabaseSync): void {
  for (const operation of migrationDefinitions[0]!.operations.SQLite) {
    db.exec(operation.sql);
  }
  db.exec(
    "CREATE TABLE schema_migrations (" +
    "  version INTEGER PRIMARY KEY NOT NULL,\n" +
    "  name TEXT UNIQUE NOT NULL,\n" +
    "  checksum TEXT NOT NULL,\n" +
    "  applied_at INTEGER NOT NULL\n" +
    ")",
  );
  db.prepare("INSERT INTO schema_migrations VALUES (0, 'initial-schema', ?, 1)").run(migrationChecksum(migrationDefinitions[0]!));
}

/** Insert one canonical sessions row (only pi_session_file is caller-provided). */
export function insertCanonicalSession(db: DatabaseSync, id: string, file: string): void {
  // The canonical sessions.project_id FK references projects.id; ensure the
  // immutable DEFAULT_PROJECT_ID row exists so the inserted session is a valid
  // FK row (restore runs PRAGMA foreign_key_check and fails on any dangling FK).
  db.prepare(
    "INSERT OR IGNORE INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(DEFAULT_PROJECT_ID, "default", "/", "owner", 1);
  db.prepare(
    "INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, "owner", DEFAULT_PROJECT_ID, id, 1, 1, file);
}
