import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  migrationDefinitions,
  migrationChecksum,
  MIGRATION_V0_GOLDEN_CHECKSUM,
  stableSerialize,
  schemaManifestV0,
  schemaManifestV1,
  schemaManifest,
  SQLITE_PHYSICAL_TYPES,
  POSTGRES_PHYSICAL_TYPES,
  MIGRATION_V0_GOLDEN_DDL_SNAPSHOT,
} from "../../src/storage/migration-manifest.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";

function tables(db: DatabaseSync): unknown[] {
  return db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
}

function futureMigration() {
  return Object.freeze({
    version: 2,
    name: "test-future",
    manifest: schemaManifestV0,
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
    version: 2,
    name: "test-failure",
    manifest: schemaManifestV0,
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

describe("Manifest-driven migration engine (SQLite)", () => {
  it("fresh apply is atomic, records v0, is idempotent, and preserves data", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const first = await runSqliteMigrations(db);
      expect(first.status).toBe("applied");
      expect(first.appliedVersion).toBe(1);
      expect((db.prepare("SELECT version, name, length(checksum) AS n FROM schema_migrations ORDER BY version").all() as Array<Record<string, unknown>>)).toEqual([
        { version: 0, name: "initial-schema", n: 64 },
        { version: 1, name: "file-operations-outbox", n: 64 },
      ]);
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
      expect(dry.pending.map((item) => item.version)).toEqual([0, 1]);
      expect(tables(db)).toEqual(before);
      await expect(runSqliteMigrations(db, { mode: "verify" })).rejects.toThrow(/not been initialized/);
      expect(tables(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("rejects an RC managed database without a ledger without any DDL mutation", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, cwd TEXT NOT NULL, owner_key TEXT NOT NULL, created_at INTEGER NOT NULL)");
      db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)").run("old", "old", "/old", "owner", 1);
      const before = tables(db);
      await expect(runSqliteMigrations(db)).rejects.toThrow(/controlled reset\/adopt/);
      expect(tables(db)).toEqual(before);
      expect(db.prepare("SELECT name FROM projects").all()).toEqual([{ name: "old" }]);
    } finally {
      db.close();
    }
  });

  it("verify is fail-closed when the registry has a pending v1 behind the canonical head", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      await runSqliteMigrations(db);
      const before = tables(db);
      await expect(runSqliteMigrations(db, { mode: "verify", migrations: [...migrationDefinitions, futureMigration()] })).rejects.toThrow(/canonical migration head|pending/);
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
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });

  it("never allows a custom registry to replace canonical v0 before DDL", async () => {
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
        await expect(runSqliteMigrations(db, { migrations: [registryV0] })).rejects.toThrow(/canonical|golden|version 0/);
        expect(tables(db)).toEqual([]);
      } finally {
        db.close();
      }
    }
  });

  it("rolls back DDL and ledger together on an injected migration failure", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      await expect(runSqliteMigrations(db, { migrations: [...migrationDefinitions, failingMigration()] })).rejects.toThrow(
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
      version: 2,
      name: "rollback-failure",
      manifest: schemaManifestV0,
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
    await expect(runSqliteMigrations(db, { migrations: [...migrationDefinitions, rollbackFailure] })).rejects.toThrow(
      /syntax error.*migration cleanup failed/,
    );
    expect(() => db.prepare("SELECT 1")).toThrow(/not open/i);
  });

  it("uses stable object-key ordering for checksums", () => {
    expect(stableSerialize({ z: 1, a: { d: true, c: false } })).toBe(stableSerialize({ a: { c: false, d: true }, z: 1 }));
  });

  it("keeps the released v0 snapshot and descriptor frozen, with a golden checksum", () => {
    expect(schemaManifest).toBe(schemaManifestV1);
    expect(Object.isFrozen(schemaManifestV0)).toBe(true);
    expect(Object.isFrozen(schemaManifestV0.tables)).toBe(true);
    expect(Object.isFrozen(migrationDefinitions[0])).toBe(true);
    expect(Object.isFrozen(migrationDefinitions[0]!.physicalTypeMaps)).toBe(true);
    expect(Object.isFrozen(migrationDefinitions[0]!.operations)).toBe(true);
    for (const dialect of ["SQLite", "PostgreSQL"] as const) {
      expect(migrationDefinitions[0]!.operations[dialect].map((operation) => operation.sql)).toEqual(MIGRATION_V0_GOLDEN_DDL_SNAPSHOT[dialect]);
    }
    expect(schemaManifestV0.tables[1]!.columns[2]!.default).toBe("6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c");
    expect(migrationChecksum(migrationDefinitions[0]!)).toBe(MIGRATION_V0_GOLDEN_CHECKSUM);

    const descriptor = migrationDefinitions[0]!;
    expect(migrationChecksum({ ...descriptor, name: "changed" })).not.toBe(MIGRATION_V0_GOLDEN_CHECKSUM);
    expect(migrationChecksum({ ...descriptor, operations: { ...descriptor.operations, PostgreSQL: [{ ...descriptor.operations.PostgreSQL[0]!, sql: descriptor.operations.PostgreSQL[0]!.sql.replace("UUID", "TEXT") }] } })).not.toBe(MIGRATION_V0_GOLDEN_CHECKSUM);
    expect(migrationChecksum({ ...descriptor, operations: { ...descriptor.operations, SQLite: [{ ...descriptor.operations.SQLite[0]!, sql: "CREATE TABLE changed (id INTEGER)" }] } })).not.toBe(MIGRATION_V0_GOLDEN_CHECKSUM);
    expect(migrationChecksum({ ...descriptor, physicalTypeMaps: { ...descriptor.physicalTypeMaps, SQLite: { ...descriptor.physicalTypeMaps.SQLite, json: "integer" } } })).not.toBe(MIGRATION_V0_GOLDEN_CHECKSUM);
    expect(migrationChecksum({ ...descriptor, dataTransform: { kind: "changed" } })).not.toBe(MIGRATION_V0_GOLDEN_CHECKSUM);
  });
});
