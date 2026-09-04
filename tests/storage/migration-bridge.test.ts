import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { KyselyProjectRepository } from "../../src/storage/kysely-project-repository.js";
import { sqliteConstraintErrorMapper } from "../../src/storage/sqlite-constraint-errors.js";

describe("Phase 3 migration to Phase 2 bootstrap bridge (SQLite)", () => {
  it("migrates an empty database, reuses initializeDatabase, and retains CRUD data", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      await runSqliteMigrations(db);
      const kysely = await initializeDatabase(db);
      try {
        const projects = new KyselyProjectRepository(kysely, sqliteConstraintErrorMapper);
        await projects.create({ id: "bridge-project", name: "kept", cwd: "/kept", ownerKey: "owner", createdAt: 1 });
        expect((await projects.get("bridge-project"))?.name).toBe("kept");
        expect(db.prepare("SELECT count(*) AS n FROM schema_migrations").get()).toEqual({ n: 2 });
      } finally {
        await kysely.destroy();
      }
    } finally {
      // The migration runner borrows the connection; initializeDatabase owns it
      // only through its returned Kysely and closes it above.
      try { db.close(); } catch { /* already closed by Kysely */ }
    }
  });
});
