import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { migrationChecksum, migrationDefinitions } from "../../src/storage/migration-manifest.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import { createCanonicalSqliteBaseline } from "./sqlite-fixture.js";
import {
  AGE_PROCESS_TIMEOUT_MS,
  createSqliteBackup,
  spawnAgeFile,
  type AgeAdapter,
} from "../../src/backup/backup-core.js";
import {
  createPgProcessAdapter,
  createPostgresBackupForTest,
  type PgBackupPool,
  type PgBackupPoolClient,
  type PgProcessAdapter,
  type PgProcessRequest,
  type PgProcessResult,
} from "../../src/backup/postgres-backup-core.js";
import { APPLY_STAGE_BUDGET_MS, StageTimeoutError, withStageTimeout } from "../../src/backup/stage-guard.js";

const cleanups: string[] = [];
afterEach(() => {
  // Two passes: restore ALL write permissions before ANY removal, so a
  // deliberately read-only ancestor (cleanup-error tests) never blocks the
  // removal of its descendants.
  const directories = cleanups.splice(0);
  for (const directory of directories) {
    try { chmodSync(directory, 0o700); } catch { /* already writable */ }
  }
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

function baseFixture(prefix: string): {
  root: string; dataDir: string; backupRoot: string; stagingRoot: string; recipient: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(root);
  const dataDir = path.join(root, "data");
  mkdirSync(path.join(dataDir, "sessions", "session-1"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, ".pi-agent"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dataDir, "sessions", "session-1", "history.jsonl"), '{"secret":"payload-secret"}\n', { mode: 0o600 });
  writeFileSync(path.join(dataDir, ".pi-agent", "models.json"), '{"models":[]}\n', { mode: 0o600 });
  const recipient = path.join(root, "recipient.txt");
  writeFileSync(recipient, "age1testrecipient\n", { mode: 0o600 });
  // The staging root must stay OUTSIDE the backup root AND its parent by
  // contract: backupRoot's parent is root/store, staging is root/staging.
  return { root, dataDir, backupRoot: path.join(root, "store", "backups"), stagingRoot: path.join(root, "staging"), recipient };
}

function sqliteDb(dataDir: string): string {
  const dbPath = path.join(dataDir, "pi-agent-server.db");
  const db = new DatabaseSync(dbPath);
  createCanonicalSqliteBaseline(db);
  db.close();
  return dbPath;
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

/** True when no staging/publish artifact or plaintext dump leaked under root. */
function assertNoBackupLeftovers(root: string, plaintextMarkers: string[]): void {
  const leftovers = walkFiles(root);
  for (const relative of leftovers) {
    expect(relative.includes(".pi-agent-backup-")).toBe(false);
    expect(relative).not.toBe("COMPLETE");
    const bytes = readFileSync(path.join(root, relative));
    for (const marker of plaintextMarkers) expect(bytes.includes(marker)).toBe(false);
  }
}

/** Recursively collect every file under root (relative paths). */
function walkFiles(root: string, prefix = ""): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walkFiles(full, relative) : [relative];
  });
}

// ---------------------------------------------------------------------------
// PostgreSQL: hung pg_dump child, stage timeout, bounded abort settle, and
// full cleanup: no plaintext, no publish staging, no COMPLETE, transaction
// rolled back, dedicated client released.
// ---------------------------------------------------------------------------

function pgSourceClient(fixture: ReturnType<typeof baseFixture>) {
  const queries: string[] = [];
  const session = path.join(fixture.dataDir, "sessions", "session-1", "history.jsonl");
  const client: PgBackupPoolClient & { readonly queries: string[] } = {
    queries,
    async query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      queries.push(text);
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
      if (text.includes("FROM \"app_schema\".\"schema_migrations\"")) return { rows: [{ version: 0, name: "initial-schema", checksum: migrationChecksum(migrationDefinitions[0]!), applied_at: 1 }] as unknown as readonly T[] };
      if (text.includes("FROM \"app_schema\".\"sessions\"")) return { rows: [{ id: "session-1", project_id: DEFAULT_PROJECT_ID, agent_kind: "pi", conversation_format: "pi-jsonl-v3", conversation_ref: session }] as unknown as readonly T[] };
      throw new Error(`unexpected fake source query: ${text}`);
    },
  };
  let released = 0;
  const pool: PgBackupPool = {
    async connect() {
      return {
        query: client.query,
        release() { released++; },
      };
    },
  };
  return { pool, queries, released: () => released };
}

describe("stage timeout cleanup: hung pg_dump child (confirmed settle, zero leaks)", () => {
  it("aborts, waits for the CONFIRMED settlement of the aborted action, rolls back and releases, and leaves no plaintext/COMPLETE", async () => {
    const fixture = baseFixture("pi-timeout-pg-");
    const source = pgSourceClient(fixture);
    let aborts = 0;
    let abortedAt = 0;
    let settledAt = 0;
    const hungDump: PgProcessAdapter = {
      abort(): void {
        aborts++;
        abortedAt = Date.now();
      },
      run(request: PgProcessRequest): Promise<PgProcessResult> {
        if (request.args[0] === "--version") {
          return Promise.resolve({ code: 0, stdout: Buffer.from(`${path.basename(request.command)} (PostgreSQL) 16.4\n`), stderr: Buffer.alloc(0) });
        }
        // The dump child: streams partial plaintext into the staging surface,
        // then hangs until the abort kills it — and only settles a measurable
        // time LATER (stream teardown latency). The gate must not return the
        // timeout before that confirmed settlement.
        mkdirSync(path.dirname(request.stdoutPath!), { recursive: true, mode: 0o700 });
        writeFileSync(request.stdoutPath!, Buffer.from("PARTIAL PLAINTEXT DUMP BYTES\n"), { mode: 0o600 });
        return new Promise((resolve) => {
          const poll = setInterval(() => {
            if (aborts > 0) {
              clearInterval(poll);
              const late = setTimeout(() => {
                settledAt = Date.now();
                resolve({ code: null, signal: "SIGKILL", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
              }, 300);
              late.unref?.();
            }
          }, 10);
          poll.unref?.();
        });
      },
    };
    const started = Date.now();
    const error = await createPostgresBackupForTest({
      storageDialect: "postgres",
      databaseUrl: "postgres://u:p@example.test/source_db",
      paths: { dataDir: fixture.dataDir, backupRoot: fixture.backupRoot, ageRecipientFile: fixture.recipient },
      stagingRoot: fixture.stagingRoot,
      age: fakeAge(),
      pgPool: source.pool,
      pgProcess: hungDump,
      stageTimeoutMs: { pgDump: 400 },
}, async () => ({ version: 0, pending: 0 })).catch((caught: unknown) => caught);
    // The rejection happened ONLY after the aborted action really settled:
    // never earlier, and bounded by the confirmed settle (not an unbounded hang).
    expect(settledAt).toBeGreaterThan(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(settledAt - started);
    expect(settledAt - abortedAt).toBeGreaterThanOrEqual(200);
    expect(error).toBeInstanceOf(StageTimeoutError);
    expect((error as StageTimeoutError).stage).toBe("pg-dump");
    // The abort was invoked exactly once (kill the hung child).
    expect(aborts).toBe(1);
    // Transaction: rolled back, never committed, dedicated client released.
    expect(source.queries).toContain("ROLLBACK");
    expect(source.queries).not.toContain("COMMIT");
    expect(source.released()).toBeGreaterThanOrEqual(1);
    // No plaintext anywhere: the partial dump bytes are gone, no staging or
    // publish artifact survived, and the backup root holds no package.
    assertNoBackupLeftovers(fixture.root, ["PARTIAL PLAINTEXT DUMP BYTES"]);
    expect(existsSync(fixture.backupRoot) ? readdirSync(fixture.backupRoot) : []).toEqual([]);
    expect(existsSync(path.join(fixture.backupRoot, "COMPLETE"))).toBe(false);
  });

  it("outer timeout → real adapter abort → kill error → delayed close：备份核心只以真实 child 确认 close 后的 StageTimeoutError 结算并零残留 (P1)", async () => {
    const fixture = baseFixture("pi-outer-timeout-real-");
    const source = pgSourceClient(fixture);
    const erroredAt = { at: 0 };
    const closedAt = { at: 0 };
    const spawnImpl = ((command: string, args: readonly string[]) => {
      const child = new EventEmitter() as unknown as FakeChild;
      child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
      child.stderr = new Readable({ read() { /* silent */ } });
      // Version probes must settle immediately so the preflight can pass.
      if (args[0] === "--version") {
        child.exitCode = 0;
        child.signalCode = null;
        child.stdout = new Readable({ read() { /* below */ } });
        child.stdout.push(Buffer.from(`${path.basename(command)} (PostgreSQL) 16.4\n`));
        child.stdout.push(null);
        setImmediate(() => child.emit("close", 0));
        return child as unknown as ReturnType<typeof spawn>;
      }
      // The dump child hangs; the OUTER stage timeout fires the abort (via the
      // real adapter), the kill surfaces an error, and the confirmed close
      // trails even that error (delayed close).
      child.exitCode = null;
      child.signalCode = null;
      child.stdout = new Readable({ read() { /* never produces output: a hung pg_dump */ } });
      child.kill = () => {
        child.signalCode = "SIGKILL";
        setTimeout(() => {
          erroredAt.at = Date.now();
          child.emit("error", new Error("outer-abort kill error"));
        }, 30);
        setTimeout(() => {
          closedAt.at = Date.now();
          child.emit("close", null, "SIGKILL");
        }, 130);
        return true;
      };
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    const adapter = createPgProcessAdapter(spawnImpl);
    const started = Date.now();
    const error = await createPostgresBackupForTest({
      storageDialect: "postgres",
      databaseUrl: "postgres://u:p@example.test/source_db",
      paths: { dataDir: fixture.dataDir, backupRoot: fixture.backupRoot, ageRecipientFile: fixture.recipient },
      stagingRoot: fixture.stagingRoot,
      age: fakeAge(),
      pgPool: source.pool,
      pgProcess: adapter,
      stageTimeoutMs: { pgDump: 300 },
}, async () => ({ version: 0, pending: 0 })).catch((caught: unknown) => caught);
    // The run promise was NOT settled by the kill error: the gate rejected the
    // timeout only after the killed child's close was confirmed, and only then
    // did the transaction rollback / staging removal run.
    expect(erroredAt.at).toBeGreaterThan(0);
    expect(closedAt.at).toBeGreaterThan(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(closedAt.at - started);
    expect(error).toBeInstanceOf(StageTimeoutError);
    expect((error as StageTimeoutError).stage).toBe("pg-dump");
    expect(source.queries).toContain("ROLLBACK");
    expect(source.queries).not.toContain("COMMIT");
    expect(source.released()).toBeGreaterThanOrEqual(1);
    // No plaintext/COMPLETE/publish leftovers: cleanup ran only after settle.
    assertNoBackupLeftovers(fixture.root, []);
    expect(existsSync(fixture.backupRoot) ? readdirSync(fixture.backupRoot) : []).toEqual([]);
    expect(existsSync(path.join(fixture.backupRoot, "COMPLETE"))).toBe(false);
  });
});

describe("pgProcessAdapter 内部 timeout：kill 后等待 child 确认 close 才交还结果（P1）", () => {
  it("delayed close：internal 预算耗尽后，结果只在被 kill 的 child 真正关闭之后返回", async () => {
    const closedAt = { at: 0 };
    const spawnImpl = ((_command: string, _args: readonly string[]) => {
      const child = new EventEmitter() as unknown as FakeChild;
      child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
      child.stdout = new Readable({ read() { /* never produces output: a hung pg_dump */ } });
      child.stderr = new Readable({ read() { /* silent */ } });
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => {
        child.signalCode = "SIGKILL";
        // close trails the kill (reap + stdio wind-down round-trip): a real
        // child would not reacquire synchronously either.
        setTimeout(() => {
          closedAt.at = Date.now();
          child.emit("close", null, "SIGKILL");
        }, 150);
        return true;
      };
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    const adapter = createPgProcessAdapter(spawnImpl);
    const started = Date.now();
    const result = await adapter.run({ command: "pg_dump", args: ["--format=custom"], env: {}, timeoutMs: 50 });
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGKILL");
    // 调用方只在 child 确认 close 之后才拿到结果（绝不早于 close）。
    expect(closedAt.at).toBeGreaterThan(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(closedAt.at - started);
  });

  it("delayed error：内部 kill 后的 error 事件绝不早结算，仍等 child 确认 close 才交还 kill 结果", async () => {
    const closedAt = { at: 0 };
    const erroredAt = { at: 0 };
    const spawnImpl = ((_command: string, _args: readonly string[]) => {
      const child = new EventEmitter() as unknown as FakeChild;
      child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
      child.stdout = new Readable({ read() { /* never produces output: a hung pg_dump */ } });
      child.stderr = new Readable({ read() { /* silent */ } });
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => {
        child.signalCode = "SIGKILL";
        // A kill-related error trails the kill, and the close trails even
        // that error: the killed child is still winding down.
        setTimeout(() => {
          erroredAt.at = Date.now();
          child.emit("error", new Error("simulated post-kill error"));
        }, 40);
        setTimeout(() => {
          closedAt.at = Date.now();
          child.emit("close", null, "SIGKILL");
        }, 120);
        return true;
      };
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    const adapter = createPgProcessAdapter(spawnImpl);
    const started = Date.now();
    // The delayed error REALLY fired before the close...
    const result = await adapter.run({ command: "pg_dump", args: ["--format=custom"], env: {}, timeoutMs: 50 });
    expect(erroredAt.at).toBeGreaterThan(0);
    // ...but the promise only settled via the CONFIRMED close with the killed
    // handoff (code null / SIGKILL): it was NOT rejected early by the error.
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGKILL");
    expect(closedAt.at).toBeGreaterThan(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(closedAt.at - started);
  });

  it("outer abort：外层超时的 abort() 同样置 kill 状态——kill 后的 error 不早结算，等 close 才交还 (P1)", async () => {
    const erroredAt = { at: 0 };
    const closedAt = { at: 0 };
    const spawnImpl = ((_command: string, _args: readonly string[]) => {
      const child = new EventEmitter() as unknown as FakeChild;
      child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
      child.stdout = new Readable({ read() { /* never produces output: a hung pg_dump */ } });
      child.stderr = new Readable({ read() { /* silent */ } });
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => {
        child.signalCode = "SIGKILL";
        // A kill-related error trails the OUTER kill; the confirmed close trails even that.
        setTimeout(() => {
          erroredAt.at = Date.now();
          child.emit("error", new Error("simulated post-outer-kill error"));
        }, 40);
        setTimeout(() => {
          closedAt.at = Date.now();
          child.emit("close", null, "SIGKILL");
        }, 140);
        return true;
      };
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    const adapter = createPgProcessAdapter(spawnImpl);
    // The internal budget (500ms) is later than the OUTER abort below, so only
    // abort() — the outer stage-timeout — can have fired the SIGKILL.
    const pending = adapter.run({ command: "pg_dump", args: ["--format=custom"], env: {}, timeoutMs: 500 });
    adapter.abort?.(); // outer timeout fires the abort
    const result = await pending;
    expect(erroredAt.at).toBeGreaterThan(0);
    // The kill error did NOT settle the run early: the result came back only
    // via the CONFIRMED close with the killed handoff, exactly like the
    // internal-budget kill.
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGKILL");
    expect(closedAt.at).toBeGreaterThan(0);
    expect(closedAt.at).toBeGreaterThanOrEqual(erroredAt.at);
  });

  it("outer timeout → kill error → delayed close：gate 只在被 kill 的 child 确认 close 后返回 StageTimeoutError (P1)", async () => {
    const erroredAt = { at: 0 };
    const closedAt = { at: 0 };
    const spawnImpl = ((_command: string, _args: readonly string[]) => {
      const child = new EventEmitter() as unknown as FakeChild;
      child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
      child.stdout = new Readable({ read() { /* never produces output: a hung pg_dump */ } });
      child.stderr = new Readable({ read() { /* silent */ } });
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => {
        child.signalCode = "SIGKILL";
        // The outer abort kills; the child reports a kill error, and the
        // confirmed close trails even that (delayed close).
        setTimeout(() => {
          erroredAt.at = Date.now();
          child.emit("error", new Error("outer kill error"));
        }, 30);
        setTimeout(() => {
          closedAt.at = Date.now();
          child.emit("close", null, "SIGKILL");
        }, 130);
        return true;
      };
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    const adapter = createPgProcessAdapter(spawnImpl);
    const started = Date.now();
    await expect(
      withStageTimeout("pg-dump", 40, () => adapter.run({ command: "pg_dump", args: ["--format=custom"], env: {}, timeoutMs: 500 }), { abort: () => adapter.abort?.() }),
    ).rejects.toBeInstanceOf(StageTimeoutError);
    expect(erroredAt.at).toBeGreaterThan(0);
    expect(closedAt.at).toBeGreaterThan(0);
    // The gate rejected the timeout ONLY after the killed child's close was
    // confirmed (kill error + delayed close), never while it was winding down.
    expect(Date.now() - started).toBeGreaterThanOrEqual(closedAt.at - started);
  });
});

// ---------------------------------------------------------------------------
// SQLite: hung age stream (fake child that never produces output), age budget
// timeout, full staging cleanup, no publication.
// ---------------------------------------------------------------------------

type FakeChild = EventEmitter & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean;
};

function hungAgeSpawn(): { spawnImpl: typeof spawn; killCount: () => number } {
  let killed = 0;
  const spawnImpl = ((_command: string, _args: readonly string[]) => {
    const child = new EventEmitter() as unknown as FakeChild;
    child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    child.stdout = new Readable({ read() { /* never pushed: the child never produces ciphertext */ } });
    child.stderr = new Readable({ read() { /* silent stderr */ } });
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      killed++;
      child.signalCode = "SIGKILL";
      child.emit("close", null, "SIGKILL");
      return true;
    };
    // The child never writes output and never exits on its own.
    return child as unknown as ReturnType<typeof spawn>;
  }) as unknown as typeof spawn;
  return { spawnImpl, killCount: () => killed };
}

describe("age budget cleanup: hung age stream (SQLite core)", () => {
  it("kills the hung child, cleans both staging surfaces, and never publishes", async () => {
    const fixture = baseFixture("pi-timeout-age-");
    const dbPath = sqliteDb(fixture.dataDir);
    mkdirSync(fixture.stagingRoot, { recursive: true, mode: 0o700 });
    const { spawnImpl, killCount } = hungAgeSpawn();
    const hungAge: AgeAdapter = {
      encrypt(input) { return input; },
      encryptFile: (inputPath, outputPath, recipientFile) =>
        spawnAgeFile(["--encrypt", "--recipients-file", recipientFile], inputPath, outputPath, 150, spawnImpl),
    };
    await expect(createSqliteBackup({
      paths: { dataDir: fixture.dataDir, dbPath, backupRoot: fixture.backupRoot, ageRecipientFile: fixture.recipient },
      stagingRoot: fixture.stagingRoot,
      age: hungAge,
    })).rejects.toThrow(/age encryption exceeded the 150ms safety budget/);
    expect(killCount()).toBe(1);
    // No plaintext staging leftovers and no published package/COMPLETE.
    expect(readdirSync(fixture.stagingRoot)).toEqual([]);
    expect(existsSync(fixture.backupRoot) ? readdirSync(fixture.backupRoot) : []).toEqual([]);
    expect(existsSync(path.join(fixture.backupRoot, "COMPLETE"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cleanup failures never mask the original error (independent per-item
// cleanup): a failing plaintext-staging removal must not replace the age
// error, and the remaining cleanup items still run.
// ---------------------------------------------------------------------------

describe("cleanup error preservation", () => {
  it("preserves the original backup error when plaintext staging removal fails", async () => {
    const fixture = baseFixture("pi-timeout-mask-");
    const dbPath = sqliteDb(fixture.dataDir);
    mkdirSync(fixture.stagingRoot, { recursive: true, mode: 0o700 });
    const maskingAge: AgeAdapter = {
      encrypt(input) { return input; },
      encryptFile: (inputPath, _outputPath, _recipientFile) => {
        // Fail the backup AND make the plaintext-staging root read-only so the
        // finally-block removal of the staging child cannot succeed either.
        chmodSync(fixture.stagingRoot, 0o500);
        cleanups.push(fixture.stagingRoot);
        return Promise.reject(new Error("age deliberately failed"));
      },
    };
    await expect(createSqliteBackup({
      paths: { dataDir: fixture.dataDir, dbPath, backupRoot: fixture.backupRoot, ageRecipientFile: fixture.recipient },
      stagingRoot: fixture.stagingRoot,
      age: maskingAge,
    })).rejects.toThrow(/age deliberately failed/);
    // The publish surface stayed clean: no package, no COMPLETE.
    expect(existsSync(fixture.backupRoot) ? readdirSync(fixture.backupRoot) : []).toEqual([]);
    expect(existsSync(path.join(fixture.backupRoot, "COMPLETE"))).toBe(false);
  });
});

// Guard against accidental regression of the timeout lifecycle: the age
// child budget stays well inside the abortable backup stage budget that
// wraps it (the outer budget only decides WHEN the abort fires, never an
// early return).
describe("budget invariants", () => {
  it("keeps the age child budget bounded below the backup stage budget", () => {
    expect(AGE_PROCESS_TIMEOUT_MS).toBeLessThan(APPLY_STAGE_BUDGET_MS.backup);
  });
});
