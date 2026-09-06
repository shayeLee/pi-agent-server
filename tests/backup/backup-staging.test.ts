import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteBackup, type AgeAdapter } from "../../src/backup/backup-core.js";
import { migrationChecksum, migrationDefinitions } from "../../src/storage/migration-manifest.js";
import { createCanonicalSqliteBaseline } from "./sqlite-fixture.js";
import { createPostgresBackupForTest, type PgProcessAdapter, type PgProcessRequest } from "../../src/backup/postgres-backup-core.js";

const cleanups: string[] = [];
afterEach(() => {
  for (const directory of cleanups.splice(0)) {
    // Restore write permission so removal of locked test ancestors always works.
    try { chmodSync(directory, 0o700); } catch { /* already writable */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Layout:
 *   base/sources  — dataDir, DB, recipient file (must stay writable)
 *   base/store    — backupRoot's parent (may be locked to simulate the real EPERM)
 *   base/store/backups — backupRoot (stays writable)
 *   base/staging  — optional explicit plaintext staging root (sibling of store,
 *                   NOT inside store: plaintext must stay outside the backup
 *                   root's parent by contract)
 */
function makeLayout(createBackupRoot = true): { base: string; sources: string; backupRoot: string; stagingRoot: string } {
  const base = mkdtempSync(path.join(tmpdir(), "pi-backup-stage-"));
  cleanups.push(base);
  const sources = path.join(base, "sources");
  const backupRoot = path.join(base, "store", "backups");
  mkdirSync(sources, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(backupRoot), { recursive: true, mode: 0o700 });
  if (createBackupRoot) mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const stagingRoot = path.join(base, "staging");
  return { base, sources, backupRoot, stagingRoot };
}

function writeFixture(sources: string): { dataDir: string; dbPath: string; recipient: string } {
  const dataDir = path.join(sources, "data");
  mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, ".pi-agent"), { recursive: true, mode: 0o700 });
  const dbPath = path.join(dataDir, "pi-agent-server.db");
  const db = new DatabaseSync(dbPath);
  createCanonicalSqliteBaseline(db);
  db.close();
  writeFileSync(path.join(dataDir, "sessions", "s1", "history.jsonl"), '{"secret":"payload-secret"}\n', { mode: 0o600 });
  writeFileSync(path.join(dataDir, ".pi-agent", "models.json"), '{"models":[]}\n', { mode: 0o600 });
  const recipient = path.join(sources, "recipient.txt");
  writeFileSync(recipient, "age1testrecipient\n", { mode: 0o600 });
  return { dataDir, dbPath, recipient };
}

function fakeAge(): AgeAdapter {
  return {
    encrypt(input) { return Buffer.from(`FAKE-AGE\n${input.toString("base64")}`, "utf8"); },
    encryptFile: async (inputPath, outputPath) => {
      const plain = readFileSync(inputPath).toString("base64");
      writeFileSync(outputPath, Buffer.from(`FAKE-AGE\n${plain}`, "utf8"), { mode: 0o600 });
    },
  };
}

/** Published packages must contain ciphertext and COMPLETE only. */
function assertPublishedOnlyCiphertext(finalPath: string): void {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : [path.relative(finalPath, full)];
    });
  const entries = walk(finalPath).sort();
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    expect(entry === "COMPLETE" || entry.endsWith(".age")).toBe(true);
  }
  // The plaintext snapshot is removed from staging before publication.
  expect(existsSync(path.join(finalPath, "database.sqlite"))).toBe(false);
  const publishedBytes = entries
    .map((entry) => readFileSync(path.join(finalPath, entry)))
    .map((bytes) => bytes.includes("payload-secret"));
  for (const leaked of publishedBytes) expect(leaked).toBe(false);
}

describe("backup staging separation (plaintext temp root vs ciphertext publish staging)", () => {
  it("publishes a backup when the backup root's parent is not writable and never stages plaintext beside the backup root", async () => {
    const layout = makeLayout();
    const fixture = writeFixture(layout.sources);
    // Simulate the real failure: the parent of the backup root cannot be
    // written (no mkdir, no sibling staging directory) while the backup root
    // itself stays writable.
    chmodSync(path.dirname(layout.backupRoot), 0o500);
    try {
      const result = await createSqliteBackup({
        paths: { dataDir: fixture.dataDir, dbPath: fixture.dbPath, backupRoot: layout.backupRoot, ageRecipientFile: fixture.recipient },
        age: fakeAge(),
      });
      expect(result.finalPath).toBeTruthy();
      expect(path.dirname(result.finalPath!)).toBe(layout.backupRoot);
      // Nothing but the published package may appear in the (read-only) parent.
      expect(readdirSync(path.dirname(layout.backupRoot))).toEqual(["backups"]);
      expect(readdirSync(layout.backupRoot).filter((name) => name.startsWith("backup-"))).toHaveLength(1);
      // The published surface holds ciphertext only; no plaintext names or bytes.
      assertPublishedOnlyCiphertext(result.finalPath!);
    } finally {
      // Restore write permission so afterEach cleanup can remove the tree.
      chmodSync(path.dirname(layout.backupRoot), 0o700);
    }
  });

  it("uses an explicit plaintext staging root, cleans it on success, and never leaves plaintext in the backup root", async () => {
    const layout = makeLayout();
    mkdirSync(layout.stagingRoot, { recursive: true, mode: 0o700 });
    const fixture = writeFixture(layout.sources);
    const result = await createSqliteBackup({
      paths: { dataDir: fixture.dataDir, dbPath: fixture.dbPath, backupRoot: layout.backupRoot, ageRecipientFile: fixture.recipient },
      stagingRoot: layout.stagingRoot,
      age: fakeAge(),
    });
    expect(result.finalPath).toBeTruthy();
    assertPublishedOnlyCiphertext(result.finalPath!);
    // Success leaves no staging leftovers anywhere: no plaintext staging
    // directory and no publish staging directory (it was renamed).
    expect(readdirSync(layout.stagingRoot)).toEqual([]);
    expect(readdirSync(layout.backupRoot).filter((name) => name.startsWith(".pi-agent-backup-"))).toEqual([]);
  });

  it("cleans both staging surfaces when encryption fails and keeps plaintext out of the backup root", async () => {
    const layout = makeLayout();
    mkdirSync(layout.stagingRoot, { recursive: true, mode: 0o700 });
    const fixture = writeFixture(layout.sources);
    const failingAge: AgeAdapter = {
      encrypt: () => { throw new Error("age encryption failed"); },
      encryptFile: () => Promise.reject(new Error("age encryption failed")),
    };
    await expect(createSqliteBackup({
      paths: { dataDir: fixture.dataDir, dbPath: fixture.dbPath, backupRoot: layout.backupRoot, ageRecipientFile: fixture.recipient },
      stagingRoot: layout.stagingRoot,
      age: failingAge,
    })).rejects.toThrow(/age encryption failed/);
    // No published package, no publish-staging leftovers (COMPLETE included).
    expect(readdirSync(layout.backupRoot)).toEqual([]);
    expect(existsSync(path.join(layout.backupRoot, "COMPLETE"))).toBe(false);
    // No plaintext staging leftovers either: the snapshot/JSONL copies are gone.
    expect(readdirSync(layout.stagingRoot).filter((name) => name.startsWith(".pi-agent-backup-staging-"))).toEqual([]);
  });

  it("rejects a plaintext staging root inside the backup root or its parent without materializing anything", async () => {
    const layout = makeLayout(false);
    const fixture = writeFixture(layout.sources);
    for (const stagingRoot of [layout.backupRoot, path.dirname(layout.backupRoot)]) {
      await expect(createSqliteBackup({
        paths: { dataDir: fixture.dataDir, dbPath: fixture.dbPath, backupRoot: layout.backupRoot, ageRecipientFile: fixture.recipient },
        stagingRoot,
        age: fakeAge(),
      })).rejects.toThrow(/overlaps the (backup root|backup root parent)/);
    }
    // The rejected staging roots were never created and no backup was published.
    expect(existsSync(layout.backupRoot)).toBe(false);
    expect(existsSync(layout.stagingRoot)).toBe(false);
  });

  it("rejects a relative or blank configured staging root before path.resolve without materializing anything", async () => {
    const layout = makeLayout(false);
    const fixture = writeFixture(layout.sources);
    // Relative roots would silently depend on the caller's cwd; blank values
    // must never fall back to the OS temporary directory. Both are rejected
    // on the ORIGINAL string, before any path.resolve().
    for (const stagingRoot of ["relative/staging", ".", "", "   "]) {
      await expect(createSqliteBackup({
        paths: { dataDir: fixture.dataDir, dbPath: fixture.dbPath, backupRoot: layout.backupRoot, ageRecipientFile: fixture.recipient },
        stagingRoot,
        age: fakeAge(),
      })).rejects.toThrow(/staging root must be (an absolute path|a non-blank string)/);
    }
    // Nothing was materialized and no backup was published.
    expect(existsSync(layout.backupRoot)).toBe(false);
    expect(existsSync(path.join(layout.base, "staging"))).toBe(false);
  });

  it("rejects an explicit staging root that is group/world writable without materializing anything", async () => {
    const layout = makeLayout(false);
    const fixture = writeFixture(layout.sources);
    mkdirSync(layout.stagingRoot, { recursive: true, mode: 0o730 });
    chmodSync(layout.stagingRoot, 0o730);
    await expect(createSqliteBackup({
      paths: { dataDir: fixture.dataDir, dbPath: fixture.dbPath, backupRoot: layout.backupRoot, ageRecipientFile: fixture.recipient },
      stagingRoot: layout.stagingRoot,
      age: fakeAge(),
    })).rejects.toThrow(/staging root must be private \(0700/);
    // The unsafe root was left untouched and nothing was published.
    expect(existsSync(layout.backupRoot)).toBe(false);
    expect(readdirSync(layout.stagingRoot)).toEqual([]);
  });

  it("rejects a symlinked staging root without materializing anything", async () => {
    const layout = makeLayout(false);
    const fixture = writeFixture(layout.sources);
    const safeTarget = path.join(layout.base, "safe-target");
    mkdirSync(safeTarget, { recursive: true, mode: 0o700 });
    symlinkSync(safeTarget, layout.stagingRoot);
    await expect(createSqliteBackup({
      paths: { dataDir: fixture.dataDir, dbPath: fixture.dbPath, backupRoot: layout.backupRoot, ageRecipientFile: fixture.recipient },
      stagingRoot: layout.stagingRoot,
      age: fakeAge(),
    })).rejects.toThrow(/symbolic-link/);
    expect(existsSync(layout.backupRoot)).toBe(false);
    expect(readdirSync(safeTarget)).toEqual([]);
  });

  it("rejects a relative PostgreSQL staging root before any tool runs and without materializing anything", async () => {
    const layout = makeLayout(false);
    const fixture = writeFixture(layout.sources);
    // Full fake source client so the backup passes target-resolve and the
    // binary preflights and fails exactly at the staging-root validation.
    const client = {
      async query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly T[] }> {
        if (text.startsWith("BEGIN ") || text === "COMMIT" || text === "ROLLBACK") return { rows: [] as unknown as readonly T[] };
        if (text.includes("pg_export_snapshot")) return { rows: [{ snapshot: "0003A0-1" }] as unknown as readonly T[] };
        if (text.includes("pg_control_system")) return { rows: [{ system_identifier: "7234567890123456789" }] as unknown as readonly T[] };
        if (text.includes("inet_server_addr")) return { rows: [{ database_oid: "16384", schema_oid: "16401", server_address: "192.0.2.10", server_port: "5432", cluster_name: "" }] as unknown as readonly T[] };
        if (text.includes("current_database()")) return { rows: [{ database: "source_db", schema: "app_schema", user: "backup_user" }] as unknown as readonly T[] };
        if (text === "SHOW server_version_num") return { rows: [{ server_version_num: "160004" }] as unknown as readonly T[] };
        if (text.includes("information_schema.tables")) {
          const table = values?.[1];
          return { rows: [{ present: table === "schema_migrations" }] as unknown as readonly T[] };
        }
        if (text.includes("FROM \"app_schema\".\"schema_migrations\"")) return { rows: [{ version: 0, name: "initial-schema", checksum: migrationChecksum(migrationDefinitions[0]!), applied_at: 1 }] as unknown as readonly T[] };
        throw new Error(`unexpected fake source query: ${text}`);
      },
    };
    const requests: PgProcessRequest[] = [];
    const process: PgProcessAdapter = { async run(request) {
      requests.push(request);
      return { code: 0, stdout: Buffer.from(`${path.basename(request.command)} (PostgreSQL) 16.4\n`), stderr: Buffer.alloc(0) };
    } };
    await expect(createPostgresBackupForTest({
      storageDialect: "postgres",
      databaseUrl: "postgres://u:p@example.test/source_db",
      paths: { dataDir: fixture.dataDir, backupRoot: layout.backupRoot, ageRecipientFile: fixture.recipient },
      stagingRoot: "relative/staging",
      age: fakeAge(),
      pgClient: client,
      pgProcess: process,
}, async () => ({ version: 0, pending: 0 }))).rejects.toThrow(/staging root must be an absolute path/);
    // Only the binary preflight versions ran; no dump and no publication.
    expect(requests.every((request) => request.args[0] === "--version")).toBe(true);
    expect(existsSync(layout.backupRoot)).toBe(false);
  });
});
