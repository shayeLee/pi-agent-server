import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  migrationDefinitions,
  migrationChecksum,
  MIGRATION_BASELINE_GOLDEN_CHECKSUM,
  MIGRATION_BASELINE_GOLDEN_DDL_SNAPSHOT,
  stableSerialize,
  schemaManifest,
  SQLITE_PHYSICAL_TYPES,
  POSTGRES_PHYSICAL_TYPES,
} from "../../src/storage/migration-manifest.js";
import { runSqliteMigrations, runSqliteMigrationsForTest } from "../../src/storage/migration-engine.js";

function tables(db: DatabaseSync): unknown[] {
  return db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
}

function futureMigration() {
  return Object.freeze({
    version: 1,
    name: "test-future",
    manifest: schemaManifest,
    physicalTypeMaps: { SQLite: SQLITE_PHYSICAL_TYPES, PostgreSQL: POSTGRES_PHYSICAL_TYPES },
    operations: {
      SQLite: [{ kind: "ddl", dialect: "SQLite", sql: "CREATE TABLE test_future (id INTEGER)" }] as const,
      PostgreSQL: [{ kind: "ddl", dialect: "PostgreSQL", sql: "CREATE TABLE test_future (id BIGINT)" }] as const,
    },
    dataTransform: { kind: "none", format: "pi-agent-server.data-transform.v1" },
  });
}

function failingMigration() {
  return Object.freeze({
    version: 1,
    name: "test-failure",
    manifest: schemaManifest,
    physicalTypeMaps: { SQLite: SQLITE_PHYSICAL_TYPES, PostgreSQL: POSTGRES_PHYSICAL_TYPES },
    operations: {
      SQLite: [
        { kind: "ddl", dialect: "SQLite", sql: "CREATE TABLE migration_failure_marker (id INTEGER PRIMARY KEY)" },
        { kind: "ddl", dialect: "SQLite", sql: "THIS IS INVALID" },
      ] as const,
      PostgreSQL: [{ kind: "ddl", dialect: "PostgreSQL", sql: "SELECT 1" }] as const,
    },
    dataTransform: { kind: "none", format: "pi-agent-server.data-transform.v1" },
  });
}

/** A legacy no-ledger database: managed tables built exactly like the removed v0 RC bootstrap. */
function legacyNoLedgerDatabase(db: DatabaseSync): void {
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, cwd TEXT NOT NULL, owner_key TEXT NOT NULL, created_at INTEGER NOT NULL)");
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, owner_key TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c', title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, conversation_ref TEXT, model_provider TEXT, model_id TEXT, thinking_level TEXT, system_prompt TEXT, capability_versions TEXT)");
  db.exec("CREATE TABLE idempotency (session_id TEXT NOT NULL, request_id TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, request_id))");
}

/** An unsupported multi-row ledger from an abandoned database. */
function unsupportedLedger(db: DatabaseSync): void {
  db.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    name TEXT UNIQUE NOT NULL,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  db.prepare("INSERT INTO schema_migrations VALUES (0, 'initial-schema', ?, 1)").run("a".repeat(64));
  db.prepare("INSERT INTO schema_migrations VALUES (1, 'old-extra', ?, 1)").run("b".repeat(64));
}

describe("Manifest-driven migration engine (SQLite, single baseline)", () => {
  it("fresh apply is atomic, records the single baseline v0, is idempotent, and preserves data", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const first = await runSqliteMigrations(db);
      expect(first.status).toBe("applied");
      expect(first.appliedVersion).toBe(0);
      expect((db.prepare("SELECT version, name, length(checksum) AS n FROM schema_migrations ORDER BY version").all() as Array<Record<string, unknown>>)).toEqual([
        { version: 0, name: "initial-schema", n: 64 },
      ]);
      // The complete schema (incl. file_operations) exists after the single apply.
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
      expect(names).toEqual(["file_operations", "idempotency", "projects", "schema_migrations", "sessions"]);
      db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)").run(
        "data-project", "Data", "/data", "owner", 1,
      );

      const before = tables(db);
      const second = await runSqliteMigrations(db);
      expect(second.pending).toEqual([]);
      expect(tables(db)).toEqual(before);
      expect(db.prepare("SELECT name FROM projects WHERE id = 'data-project'").get()).toEqual({ name: "Data" });
    } finally {
      db.close();
    }
  });

  it("dry-run and verify never bootstrap an empty database", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const before = tables(db);
      const dry = await runSqliteMigrations(db, { mode: "dry-run" });
      expect(dry.status).toBe("planned");
      expect(dry.pending.map((item) => item.version)).toEqual([0]);
      expect(tables(db)).toEqual(before);
      await expect(runSqliteMigrations(db, { mode: "verify" })).rejects.toThrow(/not been initialized/);
      expect(tables(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("assertEmptySchema bootstraps only a completely empty database and refuses any existing user object", async () => {
    // An empty database applies the single baseline.
    const empty = new DatabaseSync(":memory:");
    try {
      const result = await runSqliteMigrations(empty, { assertEmptySchema: true });
      expect(result.status).toBe("applied");
      expect(result.appliedVersion).toBe(0);
      expect(result.pending).toEqual([]);
    } finally {
      empty.close();
    }

    // An unrelated user table refuses and mutates nothing.
    const withTable = new DatabaseSync(":memory:");
    try {
      withTable.exec("CREATE TABLE arbitrary_user_table (id INTEGER PRIMARY KEY)");
      const before = tables(withTable);
      await expect(runSqliteMigrations(withTable, { assertEmptySchema: true })).rejects.toThrow(/non-empty SQLite|user object/);
      expect(tables(withTable)).toEqual(before);
      expect(() => withTable.prepare("SELECT * FROM schema_migrations")).toThrow(/no such table/);
    } finally {
      withTable.close();
    }

    // A view alone (no base table) must refuse: the old table-only check would have missed it.
    const withView = new DatabaseSync(":memory:");
    try {
      withView.exec("CREATE VIEW arbitrary_view AS SELECT 1 AS x");
      await expect(runSqliteMigrations(withView, { assertEmptySchema: true })).rejects.toThrow(/non-empty SQLite|user object/);
      const rows = withView.prepare("SELECT type, name FROM sqlite_master").all() as Array<{ type: string; name: string }>;
      expect(rows).toEqual([{ type: "view", name: "arbitrary_view" }]);
    } finally {
      withView.close();
    }

    // A trigger alone (no base table) must refuse.
    const withTrigger = new DatabaseSync(":memory:");
    try {
      withTrigger.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      withTrigger.exec("CREATE TRIGGER arbitrary_trigger AFTER INSERT ON t BEGIN SELECT 1; END");
      await expect(runSqliteMigrations(withTrigger, { assertEmptySchema: true })).rejects.toThrow(/non-empty SQLite|user object/);
    } finally {
      withTrigger.close();
    }

    // An already-initialized database (ledger present) refuses: bootstrap is strictly empty-only.
    const initialized = new DatabaseSync(":memory:");
    try {
      await runSqliteMigrations(initialized);
      await expect(runSqliteMigrations(initialized, { assertEmptySchema: true })).rejects.toThrow(/non-empty SQLite|user object/);
      expect(initialized.prepare("SELECT count(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 });
    } finally {
      initialized.close();
    }
  });

  it("rejects a legacy no-ledger managed database with a dedicated error without any DDL mutation (apply and verify)", async () => {
    for (const mode of ["apply", "verify"] as const) {
      const db = new DatabaseSync(":memory:");
      try {
        legacyNoLedgerDatabase(db);
        db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)").run("old", "old", "/old", "owner", 1);
        const before = tables(db);
        await expect(runSqliteMigrations(db, { mode })).rejects.toThrow(/legacy database and adoption is forbidden|not been initialized/);
        expect(tables(db)).toEqual(before);
        expect(db.prepare("SELECT name FROM projects").all()).toEqual([{ name: "old" }]);
      } finally {
        db.close();
      }
    }
  });

  it("rejects an unsupported multi-row ledger before any DDL", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      unsupportedLedger(db);
      const before = tables(db);
      await expect(runSqliteMigrations(db)).rejects.toThrow(/single-baseline registry has 1; recreate the database/);
      expect(tables(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("rejects a single-row ledger carrying a non-canonical checksum", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT UNIQUE NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`);
      db.prepare("INSERT INTO schema_migrations VALUES (0, 'initial-schema', ?, 1)").run("a".repeat(64));
      await expect(runSqliteMigrations(db)).rejects.toThrow(/checksum mismatch; recreate the database/);
    } finally {
      db.close();
    }
  });

  it("verify is fail-closed when a pending future migration leaves the database behind the canonical head", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      await runSqliteMigrations(db);
      const before = tables(db);
      await expect(runSqliteMigrationsForTest(db, { mode: "verify", migrations: [...migrationDefinitions, futureMigration()] })).rejects.toThrow(/canonical migration head|pending/);
      expect(tables(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("fails fast on checksum tampering and physical schema drift", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      await runSqliteMigrations(db);
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 0").run("tampered");
      await expect(runSqliteMigrations(db)).rejects.toThrow(/checksum mismatch/);
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 0").run(migrationChecksum(migrationDefinitions[0]!));
      db.exec("DROP INDEX idx_projects_owner");
      await expect(runSqliteMigrations(db)).rejects.toThrow(/不兼容|physical schema/);
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("never allows a custom registry to replace the canonical baseline before DDL", async () => {
    const canonical = migrationDefinitions[0]!;
    const registries = [
      { ...canonical, name: "renamed-v0" },
      { ...canonical, manifest: { ...canonical.manifest } },
      {
        ...canonical,
        operations: {
          ...canonical.operations,
          SQLite: canonical.operations.SQLite.map((operation, index) => index === 0 ? { ...operation, sql: operation.sql.replace("projects", "projects_changed") } : operation),
        },
      },
      { ...canonical, dataTransform: { kind: "changed", format: "pi-agent-server.data-transform.v1" } },
    ];
    for (const registryV0 of registries) {
      const db = new DatabaseSync(":memory:");
      try {
        await expect(runSqliteMigrationsForTest(db, { migrations: [registryV0] })).rejects.toThrow(/canonical|golden|version 0/);
        expect(tables(db)).toEqual([]);
      } finally {
        db.close();
      }
    }
  });

  it("rolls back DDL and ledger together on an injected migration failure", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      await expect(runSqliteMigrationsForTest(db, { migrations: [...migrationDefinitions, failingMigration()] })).rejects.toThrow(
        /syntax error|near \"THIS\"/,
      );
      expect(tables(db)).toEqual([]);
      expect(() => db.prepare("SELECT * FROM schema_migrations")).toThrow(/no such table/i);
      expect(() => db.prepare("SELECT * FROM migration_failure_marker")).toThrow(/no such table/i);
    } finally {
      db.close();
    }
  });

  it("discards the SQLite connection and preserves cleanup context when rollback fails", async () => {
    const db = new DatabaseSync(":memory:");
    const rollbackFailure = Object.freeze({
      version: 1,
      name: "rollback-failure",
      manifest: schemaManifest,
      physicalTypeMaps: { SQLite: SQLITE_PHYSICAL_TYPES, PostgreSQL: POSTGRES_PHYSICAL_TYPES },
      operations: {
        SQLite: [
          { kind: "ddl", dialect: "SQLite", sql: "COMMIT" },
          { kind: "ddl", dialect: "SQLite", sql: "THIS IS INVALID" },
        ] as const,
        PostgreSQL: [{ kind: "ddl", dialect: "PostgreSQL", sql: "SELECT 1" }] as const,
      },
      dataTransform: { kind: "none", format: "pi-agent-server.data-transform.v1" },
    });
    await expect(runSqliteMigrationsForTest(db, { migrations: [...migrationDefinitions, rollbackFailure] })).rejects.toThrow(
      /syntax error.*migration cleanup failed/,
    );
    expect(() => db.prepare("SELECT 1")).toThrow(/not open/i);
  });

  it("uses stable object-key ordering for checksums", () => {
    expect(stableSerialize({ z: 1, a: { d: true, c: false } })).toBe(stableSerialize({ a: { c: false, d: true }, z: 1 }));
  });

  it("keeps the released single-baseline snapshot and descriptor frozen, with a golden checksum", () => {
    expect(schemaManifest).toBe(migrationDefinitions[0]!.manifest);
    expect(Object.isFrozen(schemaManifest)).toBe(true);
    expect(Object.isFrozen(schemaManifest.tables)).toBe(true);
    expect(Object.isFrozen(migrationDefinitions[0])).toBe(true);
    expect(Object.isFrozen(migrationDefinitions[0]!.physicalTypeMaps)).toBe(true);
    expect(Object.isFrozen(migrationDefinitions[0]!.operations)).toBe(true);
    for (const dialect of ["SQLite", "PostgreSQL"] as const) {
      expect(migrationDefinitions[0]!.operations[dialect].map((operation) => operation.sql)).toEqual(MIGRATION_BASELINE_GOLDEN_DDL_SNAPSHOT[dialect]);
    }
    expect(schemaManifest.tables[1]!.columns[2]!.default).toBe("6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c");
    expect(schemaManifest.tables.some((table) => table.name === "file_operations")).toBe(true);
    expect(migrationChecksum(migrationDefinitions[0]!)).toBe(MIGRATION_BASELINE_GOLDEN_CHECKSUM);

    const descriptor = migrationDefinitions[0]!;
    expect(migrationChecksum({ ...descriptor, name: "changed" })).not.toBe(MIGRATION_BASELINE_GOLDEN_CHECKSUM);
    expect(migrationChecksum({ ...descriptor, operations: { ...descriptor.operations, PostgreSQL: [{ ...descriptor.operations.PostgreSQL[0]!, sql: descriptor.operations.PostgreSQL[0]!.sql.replace("UUID", "TEXT") }] } })).not.toBe(MIGRATION_BASELINE_GOLDEN_CHECKSUM);
    expect(migrationChecksum({ ...descriptor, operations: { ...descriptor.operations, SQLite: [{ ...descriptor.operations.SQLite[0]!, sql: "CREATE TABLE changed (id INTEGER)" }] } })).not.toBe(MIGRATION_BASELINE_GOLDEN_CHECKSUM);
    expect(migrationChecksum({ ...descriptor, physicalTypeMaps: { ...descriptor.physicalTypeMaps, SQLite: { ...descriptor.physicalTypeMaps.SQLite, json: "integer" } } })).not.toBe(MIGRATION_BASELINE_GOLDEN_CHECKSUM);
    expect(migrationChecksum({ ...descriptor, dataTransform: { kind: "changed" } })).not.toBe(MIGRATION_BASELINE_GOLDEN_CHECKSUM);
  });
});