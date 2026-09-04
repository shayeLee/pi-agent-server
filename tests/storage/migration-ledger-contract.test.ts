import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrationChecksum, migrationDefinitions } from "../../src/storage/migration-manifest.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";

const checksum = migrationChecksum(migrationDefinitions[0]!);
const ledgerDdl = `CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  name TEXT UNIQUE NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`;

function snapshot(db: DatabaseSync): unknown[] {
  return db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
}

function withLedger(setup: (db: DatabaseSync) => void, check: (db: DatabaseSync) => void): Promise<void> {
  const db = new DatabaseSync(":memory:");
  setup(db);
  const before = snapshot(db);
  return runSqliteMigrations(db).then(
    () => { throw new Error("expected strict ledger rejection"); },
    (error: unknown) => {
      expect(String(error)).toMatch(/schema migration ledger|checksum|physical schema/);
      expect(snapshot(db)).toEqual(before);
      check(db);
      db.close();
    },
  );
}

describe("SQLite schema_migrations strict contract", () => {
  it("rejects empty, partial and extra-column ledgers without DDL or deletion", async () => {
    await withLedger((db) => db.exec(ledgerDdl), (db) => {
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 0 });
    });
    await withLedger((db) => db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL)"), () => {});
    await withLedger((db) => db.exec(`${ledgerDdl.slice(0, -1)}, extra TEXT NOT NULL)`), () => {});
  });

  it("rejects gaps, future versions and wrong names", async () => {
    for (const row of [
      "INSERT INTO schema_migrations VALUES (2, 'initial-schema', '" + checksum + "', 1)",
      "INSERT INTO schema_migrations VALUES (1, 'initial-schema', '" + checksum + "', 1)",
      "INSERT INTO schema_migrations VALUES (0, 'wrong-name', '" + checksum + "', 1)",
    ]) {
      await withLedger((db) => { db.exec(ledgerDdl); db.exec(row); }, () => {});
    }
  });

  it("rejects malformed checksum/applied_at and an incomplete physical schema", async () => {
    for (const row of [
      "INSERT INTO schema_migrations VALUES (0, 'initial-schema', 'not-a-checksum', 1)",
      "INSERT INTO schema_migrations VALUES (0, 'initial-schema', '" + checksum + "', 'not-an-integer')",
    ]) {
      await withLedger((db) => { db.exec(ledgerDdl); db.exec(row); }, () => {});
    }
    await withLedger((db) => {
      db.exec(ledgerDdl);
      db.exec(`INSERT INTO schema_migrations VALUES (0, 'initial-schema', '${checksum}', 1)`);
    }, (db) => {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name != 'schema_migrations' AND name NOT LIKE 'sqlite_autoindex_%'").all()).toEqual([]);
    });
  });

  it("rejects every undeclared ledger object without changing the target", async () => {
    const setups = [
      (db: DatabaseSync) => db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL, CHECK (version >= 0))"),
      (db: DatabaseSync) => db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, checksum TEXT UNIQUE NOT NULL, applied_at INTEGER NOT NULL)"),
      (db: DatabaseSync) => { db.exec(ledgerDdl); db.exec("CREATE INDEX extra_ledger_index ON schema_migrations(name)"); },
      (db: DatabaseSync) => { db.exec(ledgerDdl); db.exec("CREATE TRIGGER extra_ledger_trigger AFTER INSERT ON schema_migrations BEGIN SELECT 1; END"); },
      (db: DatabaseSync) => db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL, FOREIGN KEY (version) REFERENCES parent(id))"),
      (db: DatabaseSync) => db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL, generated TEXT GENERATED ALWAYS AS (name) STORED)"),
    ];
    for (const setup of setups) await withLedger(setup, () => {});
  });
});
