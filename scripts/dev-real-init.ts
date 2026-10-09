import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStoragePaths, resolveStorageConfig, type StorageEnvironment } from "../src/storage/storage-config.js";
import { runSqliteMigrations } from "../src/storage/migration-engine.js";
import { assertCliMigrationHead, bootstrapSqliteCanonicalBaseline } from "./migrate.js";
import { withSqliteReadonlySnapshot } from "./sqlite-readonly-snapshot.js";

export async function initializeDevelopmentDatabase(environment: StorageEnvironment = process.env, baseCwd = process.cwd()): Promise<"initialized" | "already-initialized"> {
  const paths = resolveStoragePaths({}, environment, baseCwd);
  const storage = resolveStorageConfig({}, paths.dbPath, environment);
  if (storage.dialect !== "sqlite") throw new Error("dev:real:init supports SQLite only; use the explicit offline migrate CLI for PostgreSQL");
  if (existsSync(paths.dbPath)) {
    const empty = await withSqliteReadonlySnapshot(paths.dbPath, async (db) => {
      // Existing targets are always verified first, using the official verify engine.
      try {
        assertCliMigrationHead(await runSqliteMigrations(db, { mode: "verify" }));
        return false;
      } catch {
        const row = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").get() as { count: number };
        if (row.count === 0) return true;
        // Only a valid registry prefix/physical schema can be classified as needing migration.
        const plan = await runSqliteMigrations(db, { mode: "dry-run" }).catch(() => null);
        if (plan && plan.appliedVersion !== null && plan.pending.length > 0) {
          throw new Error("existing database requires an explicit offline migration; init will not apply it");
        }
        throw new Error("existing database failed schema/ledger verification; init refuses adoption, baseline writes, deletion or repair");
      }
    });
    if (!empty) return "already-initialized";
  }
  mkdirSync(path.dirname(paths.dbPath), { recursive: true });
  const db = new DatabaseSync(paths.dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
  try { await bootstrapSqliteCanonicalBaseline(db); }
  finally { db.close(); }
  return "initialized";
}

function isEntry(): boolean {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isEntry()) {
  void initializeDevelopmentDatabase().then((status) => {
    console.log(status === "already-initialized" ? "dev:real:init: already initialized (schema/ledger verified; no writes)" : "dev:real:init: initialized and verified");
  }).catch((error: unknown) => {
    // No arbitrary catalog values or environment/credentials in diagnostics.
    const message = error instanceof Error && error.message.startsWith("existing database") ? error.message : "initialization failed; no automatic repair (check target paths/storage configuration)";
    console.error(`dev:real:init: ${message}`);
    process.exitCode = 1;
  });
}
