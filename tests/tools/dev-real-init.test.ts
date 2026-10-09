import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { runSqliteMigrationsForTest } from "../../src/storage/migration-engine.js";
import { migrationDefinitions } from "../../src/storage/migration-manifest.js";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeDevelopmentDatabase } from "../../scripts/dev-real-init.js";
import { sqliteSourceMetadata, withSqliteReadonlySnapshot } from "../../scripts/sqlite-readonly-snapshot.js";
import { resolveStoragePaths } from "../../src/storage/storage-config.js";

describe("dev:real:init", () => {
  let root: string;
  let home: string | undefined;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "dev-init-test-")); home = process.env.HOME; process.env.HOME = root; });
  afterEach(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; rmSync(root, { recursive: true, force: true }); });
  it("uses the shared simulated home default without touching real home", async () => {
    const target = path.join(root, ".pi", "agent", "pi-agent-server.db");
    expect(resolveStoragePaths({}, {}, root).dbPath).toBe(target);
    expect(await initializeDevelopmentDatabase({}, root)).toBe("initialized");
    expect(existsSync(target)).toBe(true);
  });
  it("honors explicit DATA_DIR and DB_PATH", async () => {
    const target = path.join(root, "override.db");
    expect(await initializeDevelopmentDatabase({ DATA_DIR: path.join(root, "data"), DB_PATH: target }, root)).toBe("initialized");
    expect(existsSync(target)).toBe(true);
    expect(existsSync(path.join(root, "data"))).toBe(false);
  });
  it("loads .env.local like dev:real, with process env winning", () => {
    const fileData = path.join(root, "env-file-data");
    const explicitData = path.join(root, "process-data");
    writeFileSync(path.join(root, ".env.local"), `DATA_DIR=${fileData}\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: explicitData, PI_STORAGE_DIALECT: "sqlite" };
    delete env.DB_PATH;
    const output = execFileSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "--env-file-if-exists=.env.local", path.resolve("scripts/dev-real-init.ts")], { cwd: root, env, encoding: "utf8" });
    expect(output).toContain("initialized and verified");
    expect(existsSync(path.join(explicitData, "pi-agent-server.db"))).toBe(true);
    expect(existsSync(fileData)).toBe(false);
  });
  it("refuses a valid older version and requests explicit migration", async () => {
    const target = path.join(root, "pi-agent-server.db");
    const db = new DatabaseSync(target);
    try { await runSqliteMigrationsForTest(db, { mode: "apply", assertEmptySchema: true, migrations: migrationDefinitions.slice(0, 1) }); }
    finally { db.close(); }
    const before = sqliteSourceMetadata(target);
    await expect(initializeDevelopmentDatabase({ DATA_DIR: root }, root)).rejects.toThrow("explicit offline migration");
    expect(sqliteSourceMetadata(target)).toBe(before);
  });
  it("bootstraps a completely empty existing file", async () => {
    const target = path.join(root, "pi-agent-server.db");
    writeFileSync(target, "");
    expect(await initializeDevelopmentDatabase({ DATA_DIR: root }, root)).toBe("initialized");
  });
  it("verifies a valid existing target without writes", async () => {
    const env = { DATA_DIR: root };
    await initializeDevelopmentDatabase(env, root);
    const target = path.join(root, "pi-agent-server.db");
    const metadata = sqliteSourceMetadata(target);
    const bytes = readFileSync(target);
    expect(await initializeDevelopmentDatabase(env, root)).toBe("already-initialized");
    expect(sqliteSourceMetadata(target)).toBe(metadata);
    expect(readFileSync(target)).toEqual(bytes);
  });
  it.each(["no-ledger", "bad-checksum", "corrupt"])("refuses %s without changing it", async (kind) => {
    const target = path.join(root, "pi-agent-server.db");
    if (kind === "bad-checksum") await initializeDevelopmentDatabase({ DATA_DIR: root }, root);
    if (kind === "corrupt") writeFileSync(target, "not sqlite");
    else {
      const db = new DatabaseSync(target);
      try { db.exec(kind === "no-ledger" ? "CREATE TABLE sessions(id TEXT)" : "UPDATE schema_migrations SET checksum = 'invalid'"); }
      finally { db.close(); }
    }
    const before = sqliteSourceMetadata(target);
    const bytes = readFileSync(target);
    await expect(initializeDevelopmentDatabase({ DATA_DIR: root }, root)).rejects.toThrow();
    expect(sqliteSourceMetadata(target)).toBe(before);
    expect(readFileSync(target)).toEqual(bytes);
  });
  it("cleans snapshots on success, callback failure and open failure", async () => {
    const target = path.join(root, "source.db");
    const db = new DatabaseSync(target); db.close();
    await withSqliteReadonlySnapshot(target, async () => undefined, root);
    await expect(withSqliteReadonlySnapshot(target, async () => { throw new Error("test failure"); }, root)).rejects.toThrow("test failure");
    // A directory cannot be copied as a database: exercise acquisition failure cleanup.
    await expect(withSqliteReadonlySnapshot(root, async () => undefined, root)).rejects.toThrow();
    expect(readdirSync(root).filter((name) => name.startsWith("pi-init-readonly-"))).toEqual([]);
  });
});
