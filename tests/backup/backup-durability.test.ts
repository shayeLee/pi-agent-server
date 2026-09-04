import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createSqliteBackup,
  type AgeAdapter,
} from "../../src/backup/backup-core.js";
import {
  createPostgresBackup,
  type PgBackupClient,
  type PgProcessRequest,
} from "../../src/backup/postgres-backup-core.js";

// ---------------------------------------------------------------------------
// fsync observation seam: every node:fs openSync/fsyncSync performed by the
// backup cores is recorded as fd -> path so the tests can prove the crash
// durability contract: every new ciphertext directory (payload leaves →
// payload root → publish root) is fsynced BEFORE the COMPLETE marker is
// written. Fault injection makes a directory fsync fail with EIO and asserts
// the backup fails closed without ever writing COMPLETE.
// ---------------------------------------------------------------------------

const tracked = vi.hoisted(() => ({
  fdPaths: new Map<number, string>(),
  fsyncLog: [] as string[],
  /** When set, fsync of a path matching this regex source throws EIO. */
  failMatch: undefined as string | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = actual.openSync as (...args: unknown[]) => number;
  return {
    ...actual,
    openSync: (file: unknown, ...rest: unknown[]) => {
      const fd = openSync(file, ...rest);
      tracked.fdPaths.set(fd, typeof file === "string" ? file : String(file));
      return fd;
    },
    closeSync: (fd: number) => {
      tracked.fdPaths.delete(fd);
      return actual.closeSync(fd);
    },
    fsyncSync: (fd: number) => {
      const file = tracked.fdPaths.get(fd) ?? `fd:${fd}`;
      if (tracked.failMatch !== undefined && new RegExp(tracked.failMatch).test(file)) {
        const error: NodeJS.ErrnoException = new Error(`injected EIO while fsyncing ${file}`);
        error.code = "EIO";
        throw error;
      }
      tracked.fsyncLog.push(file);
      return actual.fsyncSync(fd);
    },
  };
});

const cleanups: string[] = [];
afterEach(() => {
  tracked.failMatch = undefined;
  tracked.fsyncLog.length = 0;
  tracked.fdPaths.clear();
  for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function baseFixture(prefix: string): { root: string; dataDir: string; backupRoot: string; recipient: string } {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(root);
  const dataDir = path.join(root, "data");
  mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, ".pi-agent"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dataDir, "sessions", "s1", "history.jsonl"), '{"secret":"payload-secret"}\n', { mode: 0o600 });
  writeFileSync(path.join(dataDir, ".pi-agent", "models.json"), '{"models":[]}\n', { mode: 0o600 });
  const recipient = path.join(root, "recipient.txt");
  writeFileSync(recipient, "age1testrecipient\n", { mode: 0o600 });
  return { root, dataDir, backupRoot: path.join(root, "backups"), recipient };
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

/** Publish-related fsync entries in order: leaf dirs, payload, publish root, COMPLETE. */
function publishFsyncs(): string[] {
  return tracked.fsyncLog.filter((file) => file.includes(".pi-agent-backup-publish-"));
}

function lastIndexOf(list: string[], match: (file: string) => boolean): number {
  for (let index = list.length - 1; index >= 0; index--) if (match(list[index]!)) return index;
  return -1;
}

/**
 * Proves the tree sync ordering against the recorded fsync log: the last fsync
 * of the deepest payload leaf precedes the last payload fsync, which precedes
 * a publish-root fsync, which precedes the COMPLETE marker fsync.
 */
function assertTreeSyncedBeforeComplete(): void {
  // All indices are taken within the same publish-related fsync list so they
  // are directly comparable.
  const entries = publishFsyncs();
  expect(entries.length).toBeGreaterThan(0);
  const leafIndex = lastIndexOf(entries, (file) => /payload\/sessions\/s1$/.test(file));
  const payloadIndex = lastIndexOf(entries, (file) => /payload$/.test(file));
  const completeIndex = lastIndexOf(entries, (file) => file.endsWith("/COMPLETE"));
  expect(leafIndex).toBeGreaterThanOrEqual(0);
  expect(payloadIndex).toBeGreaterThan(leafIndex);
  // A publish-root fsync strictly between the last payload fsync and the
  // COMPLETE fsync proves the tree sync (deepest first) ran before the marker.
  const rootSyncBeforeComplete = entries
    .slice(payloadIndex + 1, completeIndex)
    .some((file) => /\.pi-agent-backup-publish-[^/]+$/.test(file));
  expect(rootSyncBeforeComplete).toBe(true);
  expect(completeIndex).toBeGreaterThan(payloadIndex);
}

function sqliteFixture(prefix: string): { fixture: ReturnType<typeof baseFixture>; dbPath: string } {
  const fixture = baseFixture(prefix);
  const dbPath = path.join(fixture.dataDir, "pi-agent-server.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, pi_session_file TEXT)");
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at INTEGER)");
  db.close();
  return { fixture, dbPath };
}

function noCompleteLeft(backupRoot: string): void {
  expect(!existsSync(backupRoot) || readdirSync(backupRoot).length === 0).toBe(true);
  expect(existsSync(path.join(backupRoot, "COMPLETE"))).toBe(false);
}

describe("SQLite publish durability: every ciphertext directory fsynced before COMPLETE", () => {
  it("fsyncs payload leaf → payload root → publish root before the COMPLETE marker", async () => {
    const { fixture, dbPath } = sqliteFixture("pi-durability-sqlite-");
    const result = await createSqliteBackup({
      paths: { dataDir: fixture.dataDir, dbPath, backupRoot: fixture.backupRoot, ageRecipientFile: fixture.recipient },
      age: fakeAge(),
    });
    expect(result.finalPath).toBeTruthy();
    // The published tree really contains the nested leaf directory.
    expect(existsSync(path.join(result.finalPath!, "payload", "sessions", "s1"))).toBe(true);
    assertTreeSyncedBeforeComplete();
  });

  it("fails closed with no COMPLETE when a leaf directory fsync fails (fault injection)", async () => {
    const { fixture, dbPath } = sqliteFixture("pi-durability-sqlite-fail-");
    tracked.failMatch = "payload/sessions/s1$";
    await expect(createSqliteBackup({
      paths: { dataDir: fixture.dataDir, dbPath, backupRoot: fixture.backupRoot, ageRecipientFile: fixture.recipient },
      age: fakeAge(),
    })).rejects.toThrow(/EIO/);
    noCompleteLeft(fixture.backupRoot);
  });

  it("fails closed with no COMPLETE when the publish root fsync fails (fault injection)", async () => {
    const { fixture, dbPath } = sqliteFixture("pi-durability-sqlite-root-");
    tracked.failMatch = /\/\.pi-agent-backup-publish-[^/]+$/.source;
    await expect(createSqliteBackup({
      paths: { dataDir: fixture.dataDir, dbPath, backupRoot: fixture.backupRoot, ageRecipientFile: fixture.recipient },
      age: fakeAge(),
    })).rejects.toThrow(/EIO/);
    noCompleteLeft(fixture.backupRoot);
  });
});

// ---------------------------------------------------------------------------
// PostgreSQL: same durability contract through the PG core with a controlled
// executable and a fake source client (no real PG server needed).
// ---------------------------------------------------------------------------

function controlledExecutable(root: string, kind: "pg_dump" | "pg_restore"): string {
  const executable = path.join(root, `${kind}.mjs`);
  writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("${kind} (PostgreSQL) 16.4\\n");
} else if (args.includes("--list")) {
  process.exit(0);
} else if (args.includes("--format=custom")) {
  process.stdout.write("controlled custom pg dump bytes\\n");
} else {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
}
`, { mode: 0o700 });
  return executable;
}

function pgSourceClient(fixture: ReturnType<typeof baseFixture>): PgBackupClient {
  const session = path.join(fixture.dataDir, "sessions", "s1", "history.jsonl");
  return {
    async query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly T[] }> {
      if (text.startsWith("BEGIN ") || text === "COMMIT" || text === "ROLLBACK") return { rows: [] as unknown as readonly T[] };
      if (text.includes("pg_export_snapshot")) return { rows: [{ snapshot: "0003A0-1" }] as unknown as readonly T[] };
      if (text.includes("pg_control_system")) return { rows: [{ system_identifier: "7234567890123456789" }] as unknown as readonly T[] };
      if (text.includes("inet_server_addr")) return { rows: [{ database_oid: "16384", schema_oid: "16401", server_address: "192.0.2.10", server_port: "5432", cluster_name: "" }] as unknown as readonly T[] };
      if (text.includes("current_database()")) return { rows: [{ database: "source_db", schema: "app_schema", user: "backup_user" }] as unknown as readonly T[] };
      if (text === "SHOW server_version_num") return { rows: [{ server_version_num: "160004" }] as unknown as readonly T[] };
      if (text.includes("information_schema.tables")) {
        const table = values?.[1];
        return { rows: [{ present: table === "schema_migrations" || table === "sessions" }] as unknown as readonly T[] };
      }
      if (text.includes("FROM \"app_schema\".\"schema_migrations\"")) return { rows: [{ version: 0, name: "initial-schema", checksum: "a".repeat(64), applied_at: 1 }] as unknown as readonly T[] };
      if (text.includes("FROM \"app_schema\".\"sessions\"")) return { rows: [{ id: "session-1", pi_session_file: session }] as unknown as readonly T[] };
      throw new Error(`unexpected fake source query: ${text}`);
    },
  };
}

describe("PostgreSQL publish durability: every ciphertext directory fsynced before COMPLETE", () => {
  it("fsyncs payload leaf → payload root → publish root before the COMPLETE marker", async () => {
    const fixture = baseFixture("pi-durability-pg-");
    const result = await createPostgresBackup({
      storageDialect: "postgres",
      databaseUrl: "postgres://u:p@example.test/source_db",
      paths: { dataDir: fixture.dataDir, backupRoot: fixture.backupRoot, ageRecipientFile: fixture.recipient },
      age: fakeAge(),
      pgClient: pgSourceClient(fixture),
      pgProcess: {
        async run(request: PgProcessRequest) {
          if (request.args[0] === "--version") return { code: 0, stdout: Buffer.from(`${path.basename(request.command).replace(/\.mjs$/, "")} (PostgreSQL) 16.4\n`), stderr: Buffer.alloc(0) };
          if (request.args.includes("--format=custom") && request.stdoutPath) {
            writeFileSync(request.stdoutPath, Buffer.from("controlled custom pg dump bytes\n"), { mode: 0o600 });
          }
          return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        },
      },
      pgDumpBinary: controlledExecutable(fixture.root, "pg_dump"),
      pgRestoreBinary: controlledExecutable(fixture.root, "pg_restore"),
    });
    expect(result.finalPath).toBeTruthy();
    expect(existsSync(path.join(result.finalPath!, "payload", "sessions", "s1"))).toBe(true);
    assertTreeSyncedBeforeComplete();
  });

  it("fails closed with no COMPLETE when the publish root fsync fails (fault injection)", async () => {
    const fixture = baseFixture("pi-durability-pg-fail-");
    tracked.failMatch = /\/\.pi-agent-backup-publish-[^/]+$/.source;
    await expect(createPostgresBackup({
      storageDialect: "postgres",
      databaseUrl: "postgres://u:p@example.test/source_db",
      paths: { dataDir: fixture.dataDir, backupRoot: fixture.backupRoot, ageRecipientFile: fixture.recipient },
      age: fakeAge(),
      pgClient: pgSourceClient(fixture),
      pgProcess: {
        async run(request: PgProcessRequest) {
          if (request.args[0] === "--version") return { code: 0, stdout: Buffer.from(`${path.basename(request.command).replace(/\.mjs$/, "")} (PostgreSQL) 16.4\n`), stderr: Buffer.alloc(0) };
          if (request.args.includes("--format=custom") && request.stdoutPath) {
            writeFileSync(request.stdoutPath, Buffer.from("controlled custom pg dump bytes\n"), { mode: 0o600 });
          }
          return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        },
      },
      pgDumpBinary: controlledExecutable(fixture.root, "pg_dump"),
      pgRestoreBinary: controlledExecutable(fixture.root, "pg_restore"),
    })).rejects.toThrow(/EIO/);
    noCompleteLeft(fixture.backupRoot);
  });
});
