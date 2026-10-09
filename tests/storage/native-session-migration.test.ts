import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runSqliteMigrations, runSqliteMigrationsForTest } from "../../src/storage/migration-engine.js";
import { migrationDefinitions, migrationChecksum, MIGRATION_V2_GOLDEN_CHECKSUM } from "../../src/storage/migration-manifest.js";
import { bindReferencesToPayload } from "../../src/backup/backup-core.js";

describe("native migration and backup boundary", () => {
  it("upgrades v1 fixtures additively, preserves existing duplicate cwds/private rows, and verify-only never applies", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      await runSqliteMigrationsForTest(db, { migrations: migrationDefinitions.slice(0, 2) });
      db.exec("INSERT INTO projects VALUES ('p1','one','/same','a',1), ('p2','two','/same','b',2)");
      db.exec("INSERT INTO sessions (id,owner_key,project_id,title,created_at,updated_at) VALUES ('private','a','p1','old',1,1)");
      await expect(runSqliteMigrations(db, { mode: "verify" })).rejects.toThrow();
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toMatchObject({ n: 2 });
      await runSqliteMigrations(db);
      expect(db.prepare("SELECT visibility,origin,title FROM sessions WHERE id='private'").get()).toEqual({ visibility: "private", origin: "managed", title: "old" });
      expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toMatchObject({ n: 2 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toMatchObject({ n: 3 });
      expect(migrationChecksum(migrationDefinitions[2]!)).toBe(MIGRATION_V2_GOLDEN_CHECKSUM);
      expect((await runSqliteMigrations(db, { mode: "verify" })).pending).toEqual([]);
    } finally { db.close(); }
  });

  it("backup does not classify native originals as managed or missing-as-empty", () => {
    expect(() => bindReferencesToPayload([{ sessionId: "server", projectId: "project", agentKind: "pi",
      conversationFormat: "pi-native-jsonl-v3", conversationRef: "/fixture/native/original.jsonl" }], "/fixture/managed", []))
      .toThrow("native session references are not supported by backup/restore");
  });
});
