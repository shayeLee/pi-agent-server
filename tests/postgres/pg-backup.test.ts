import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPostgresKysely, createPostgresPool } from "../../src/storage/postgres-bootstrap.js";
import { createIdempotentStorageCloser } from "../../src/server/storage-close.js";
import { migrationDefinitions } from "../../src/storage/migration-manifest.js";
import { runPostgresMigrations } from "../../src/storage/migration-engine.js";
import { assertPostgresClientServerMajor, assertPostgresToolMajorMatch, createPostgresBackup, parseClientMajor, parseServerVersionNumMajor, parseVersion, pgProcessAdapter, redactPgDiagnostic, runPgProcess, type PgBackupClient, type PgProcessAdapter, type PgProcessRequest } from "../../src/backup/postgres-backup-core.js";
import { POSTGRES_RESTORE_SAFETY_CONTRACT, restorePostgresBackup, type PgRestoreClient } from "../../src/backup/restore-core.js";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";
import { checkPgBackupBinaries } from "../../scripts/test-pg-backup.js";

const pgUrl = process.env.PI_TEST_PG_URL?.trim();
const binaryGate = checkPgBackupBinaries();
assertRequiredPgTestEnvironment("tests/postgres/pg-backup", pgUrl, true);
const describeRealPgBackup = pgUrl && binaryGate.ok ? describe : describe.skip;
const cleanups: string[] = [];

afterEach(() => { for (const root of cleanups.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fakeAge() {
  return {
    encrypt(bytes: Buffer): Buffer { return Buffer.from(`FAKE-AGE\n${bytes.toString("base64")}`, "utf8"); },
    decrypt(bytes: Buffer): Buffer { return Buffer.from(bytes.toString("utf8").split("\n")[1]!, "base64"); },
  };
}

function fixture(): { root: string; dataDir: string; backupRoot: string; recipient: string; identity: string; session: string } {
  const root = mkdtempSync(path.join(tmpdir(), "pi-pg-backup-fake-"));
  cleanups.push(root);
  const dataDir = path.join(root, "data");
  const session = path.join(dataDir, "sessions", "s1", "history.jsonl");
  mkdirSync(path.dirname(session), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, ".pi-agent"), { recursive: true, mode: 0o700 });
  writeFileSync(session, '{"type":"session","id":"header"}\n{"type":"message","id":"entry","parentId":null}\n', { mode: 0o600 });
  writeFileSync(path.join(dataDir, ".pi-agent", "models.json"), '{"models":[]}\n', { mode: 0o600 });
  const recipient = path.join(root, "recipient");
  const identity = path.join(root, "identity");
  writeFileSync(recipient, "age1fakerecipient\n", { mode: 0o600 });
  writeFileSync(identity, "fake identity\n", { mode: 0o600 });
  chmodSync(recipient, 0o600);
  chmodSync(identity, 0o600);
  return { root, dataDir, backupRoot: path.join(root, "backups"), recipient, identity, session };
}

/**
 * Fake backup source client. Same-connection by construction (one object), and
 * transaction-aware: the backup runs BEGIN (REPEATABLE READ, READ ONLY) →
 * identity/catalog queries → pg_export_snapshot() → pg_dump → COMMIT on this
 * single client. Every query is recorded for ordering assertions.
 */
function sourceClient(f: ReturnType<typeof fixture>, variant: "v0" | "v1" | "legacy-v0" | "legacy-v1" = "v0"): PgBackupClient & { readonly queries: string[] } {
  const queries: string[] = [];
  const hasLedger = variant !== "legacy-v0" && variant !== "legacy-v1";
  const hasOutbox = variant === "v1" || variant === "legacy-v1";
  return {
    queries,
    async query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      queries.push(text);
      // Transaction control statements: the backup's dedicated READ ONLY
      // REPEATABLE READ transaction brackets the whole identity/dump window.
      if (text.startsWith("BEGIN ") || text === "COMMIT" || text === "ROLLBACK") return { rows: [] as unknown as readonly T[] };
      // Cluster-identity probes must be matched before the generic current_database branch:
      // the combined identity query also contains current_database() as a subselect.
      if (text.includes("pg_export_snapshot")) return { rows: [{ snapshot: "0003A0-1" } as unknown as T] };
      if (text.includes("pg_control_system")) return { rows: [{ system_identifier: "7234567890123456789" } as unknown as T] };
      if (text.includes("inet_server_addr")) return { rows: [{ database_oid: "16384", schema_oid: "16401", server_address: "192.0.2.10", server_port: "5432", cluster_name: "" } as unknown as T] };
      if (text.includes("current_database()")) return { rows: [{ database: "source_db", schema: "app_schema", user: "backup_user" } as unknown as T] };
      if (text === "SHOW server_version_num") return { rows: [{ server_version_num: "160004" } as unknown as T] };
      if (text.includes("information_schema.tables")) {
        const table = values?.[1];
        return { rows: [{ present: (table === "schema_migrations" && hasLedger) || table === "sessions" || (table === "file_operations" && hasOutbox) } as unknown as T] };
      }
      if (text.includes("FROM \"app_schema\".\"schema_migrations\"")) {
        const rows = variant === "v1"
          ? [{ version: 0, name: "initial-schema", checksum: "a".repeat(64), applied_at: 1 }, { version: 1, name: "file-operations-outbox", checksum: "b".repeat(64), applied_at: 2 }]
          : [{ version: 0, name: "initial-schema", checksum: "a".repeat(64), applied_at: 1 }];
        return { rows: rows as unknown as readonly T[] };
      }
      if (text.includes("FROM \"app_schema\".\"sessions\"")) return { rows: [{ id: "session-1", pi_session_file: f.session } as unknown as T] };
      throw new Error(`unexpected fake source query: ${text}`);
    },
  };
}

class FakePgProcess implements PgProcessAdapter {
  readonly requests: PgProcessRequest[] = [];
  constructor(private readonly failDump = false, private readonly version = "16.4") {}
  async run(request: PgProcessRequest) {
    this.requests.push(request);
    expect(request.args.join(" ")).not.toContain("postgres://");
    expect(request.args.join(" ")).not.toContain("source-password");
    expect(request.env.PI_DATABASE_URL).toBeUndefined();
    expect(request.env.PGPASSWORD).toBeUndefined();
    expect(request.env.PGPASSFILE).toBeTruthy();
    const pass = request.env.PGPASSFILE!;
    expect(statSync(pass).mode & 0o077).toBe(0);
    if (request.args[0] === "--version") return { code: 0, stdout: Buffer.from(`${path.basename(request.command)} (PostgreSQL) ${this.version}\n`), stderr: Buffer.alloc(0) };
    if (this.failDump) return { code: 2, stdout: Buffer.alloc(0), stderr: Buffer.from("password source-password") };
    // A process adapter must not write stdoutPath behind the production code's
    // back. Successful dump tests use the real adapter below with a controlled
    // executable that emits bytes on stdout.
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

function controlledPgExecutable(f: ReturnType<typeof fixture>, kind: "pg_dump" | "pg_restore" = "pg_dump", dumpBytes = "controlled custom pg dump bytes\n", listStatus = 0): string {
  const executable = path.join(f.root, `${kind}.mjs`);
  writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("${kind} (PostgreSQL) 16.4\\n");
} else if (args.includes("--list")) {
  process.exit(${listStatus});
} else if (args.includes("--format=custom")) {
  process.stdout.write(${JSON.stringify(dumpBytes)});
} else {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
}
`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return executable;
}

function backupPaths(f: ReturnType<typeof fixture>) {
  return { dataDir: f.dataDir, backupRoot: f.backupRoot, ageRecipientFile: f.recipient, authPath: path.join(f.root, "auth-not-backed-up.json") };
}

function recordingProductionAdapter(): { adapter: PgProcessAdapter; requests: PgProcessRequest[] } {
  const requests: PgProcessRequest[] = [];
  return {
    requests,
    adapter: { async run(request) { requests.push(request); return pgProcessAdapter.run(request); } },
  };
}

async function productionBackup(f: ReturnType<typeof fixture>, variant: "v0" | "v1" | "legacy-v0" | "legacy-v1" = "v0") {
  return createPostgresBackup({
    storageDialect: "postgres",
    databaseUrl: "postgres://u:source-password@example.test/source_db",
    paths: backupPaths(f),
    age: fakeAge(),
    pgClient: sourceClient(f, variant),
    pgProcess: pgProcessAdapter,
    pgDumpBinary: controlledPgExecutable(f),
    pgRestoreBinary: controlledPgExecutable(f, "pg_restore"),
  });
}

describe("PostgreSQL version compatibility preflight", () => {
  it("parses client/server majors and rejects malformed version metadata", () => {
    expect(parseVersion("pg_dump", Buffer.from("pg_dump (PostgreSQL) 18.6\n"))).toBe("18.6");
    expect(parseVersion("pg_restore", Buffer.from("pg_restore (PostgreSQL) 16.4\n"))).toBe("16.4");
    expect(parseClientMajor("18.6")).toBe(18);
    expect(parseServerVersionNumMajor("180006")).toBe(18);
    expect(() => parseVersion("pg_dump", Buffer.from("pg_dump PostgreSQL unknown"))).toThrow(/version could not be verified/);
    expect(() => parseClientMajor("not-a-version")).toThrow(/version is malformed/);
    expect(() => parseServerVersionNumMajor("not-a-number")).toThrow(/server version is malformed/);
  });

  it("accepts matching majors and reports safe client/server and tool mismatches", () => {
    expect(() => assertPostgresClientServerMajor("pg_dump", 16, 16)).not.toThrow();
    expect(() => assertPostgresToolMajorMatch(16, 16)).not.toThrow();
    expect(() => assertPostgresClientServerMajor("pg_dump", 18, 16)).toThrow(/client major 18, server major 16; install matching client/);
    expect(() => assertPostgresToolMajorMatch(16, 18)).toThrow(/pg_dump client major 16, pg_restore client major 18; install matching client/);
  });
});

describe("PostgreSQL backup core fake-process safety (WP3B2)", () => {
  it("fails before pg_dump when the client major does not match the server", async () => {
    const f = fixture();
    const process = new FakePgProcess(false, "18.6");
    await expect(createPostgresBackup({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: sourceClient(f), pgProcess: process })).rejects.toThrow(/client major 18, server major 16; install matching client/);
    expect(process.requests.map((request) => request.args[0])).toEqual(["--version"]);
    expect(existsSync(f.backupRoot)).toBe(false);
  });
  it("fails closed when pg_restore is missing or has a different major", async () => {
    const f = fixture();
    const requests: PgProcessRequest[] = [];
    const missingRestore: PgProcessAdapter = { async run(request) {
      requests.push(request);
      if (request.args[0] === "--version" && request.command === "pg_dump") return { code: 0, stdout: Buffer.from("pg_dump (PostgreSQL) 16.4"), stderr: Buffer.alloc(0) };
      return { code: 127, stdout: Buffer.alloc(0), stderr: Buffer.from("not found") };
    } };
    await expect(createPostgresBackup({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: sourceClient(f), pgProcess: missingRestore })).rejects.toThrow(/pg_restore binary is unavailable/);
    expect(requests.map((request) => request.args[0])).toEqual(["--version", "--version"]);

    const mismatch: PgProcessAdapter = { async run(request) {
      requests.push(request);
      if (request.args[0] === "--version") return { code: 0, stdout: Buffer.from(`${request.command} (PostgreSQL) ${request.command === "pg_dump" ? "16.4" : "17.2"}`), stderr: Buffer.alloc(0) };
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    } };
    await expect(createPostgresBackup({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: sourceClient(f), pgProcess: mismatch })).rejects.toThrow(/pg_restore.*client major 17, server major 16/);
  });

  it("validates the staged archive with pg_restore --list before publishing or encrypting", async () => {
    const f = fixture();
    let encryptCalls = 0;
    const age = { encrypt(bytes: Buffer): Buffer { encryptCalls++; return fakeAge().encrypt(bytes); } };
    await expect(createPostgresBackup({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age, pgClient: sourceClient(f), pgProcess: pgProcessAdapter, pgDumpBinary: controlledPgExecutable(f), pgRestoreBinary: controlledPgExecutable(f, "pg_restore", "", 2) })).rejects.toThrow(/pg_restore failed/);
    expect(encryptCalls).toBe(0);
    expect(!existsSync(f.backupRoot) || readdirSync(f.backupRoot).length === 0).toBe(true);
  });

  it("requires explicit postgres selection and writes schema-only pg_dump argv with a private PGPASSFILE", async () => {
    const f = fixture();
    const process = recordingProductionAdapter();
    const url = "postgresql://backup_user:source-password@example.test:5433/source_db";
    const dumpBinary = controlledPgExecutable(f);
    const result = await createPostgresBackup({ storageDialect: "postgres", databaseUrl: url, paths: backupPaths(f), age: fakeAge(), pgClient: sourceClient(f), pgProcess: process.adapter, pgDumpBinary: dumpBinary, pgRestoreBinary: controlledPgExecutable(f, "pg_restore") });
    expect(result.manifest?.dialect).toBe("PostgreSQL");
    expect(result.manifest?.kind).toBe("postgresql");
    expect(result.manifest?.postgres).toMatchObject({ pgDumpVersion: "16.4" });
    expect(result.manifest?.postgres.databaseIdentity).toHaveLength(64);
    expect(result.manifest?.postgres.schemaIdentity).toHaveLength(64);
    // Cluster/server/database/schema identity binding（fake server 提供可查询的 identity）。
    expect(result.manifest?.postgres).toMatchObject({
      systemIdentifier: "7234567890123456789",
      databaseOid: "16384",
      schemaOid: "16401",
      serverAddress: "192.0.2.10",
      serverPort: "5432",
      clusterName: null,
    });
    expect(result.publishedIdentity).toMatchObject({ manifestSha256: createHash("sha256").update(readFileSync(path.join(result.finalPath!, "manifest.json.age"))).digest("hex") });
    const dump = process.requests.find((request) => request.args[0] !== "--version");
    expect(dump?.args).toContain("--schema=app_schema");
    expect(dump?.args).not.toContain(url);
    expect(dump?.env.PGPASSFILE).toBeTruthy();
    expect(existsSync(dump!.env.PGPASSFILE!)).toBe(false); // removed after the process returns
    expect(fakeAge().decrypt(readFileSync(path.join(result.finalPath!, "payload/database.pg_dump.age")))).toEqual(Buffer.from("controlled custom pg dump bytes\n"));
    const manifestText = fakeAge().decrypt(readFileSync(path.join(result.finalPath!, "manifest.json.age"))).toString();
    expect(manifestText).not.toContain(url);
    expect(manifestText).not.toContain("source-password");
    expect(readFileSync(path.join(result.finalPath!, "COMPLETE"), "utf8").trim()).toBe(createHash("sha256").update(readFileSync(path.join(result.finalPath!, "manifest.json.age"))).digest("hex"));
    expect(readdirSync(result.finalPath!, { recursive: true, withFileTypes: true }).some((entry) => entry.name === "auth.json")).toBe(false);
  });

  it("binds identity, pg_export_snapshot and the dump to one dedicated transaction and dumps with --snapshot=<id>", async () => {
    const f = fixture();
    const source = sourceClient(f);
    const process = recordingProductionAdapter();
    const result = await createPostgresBackup({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: source, pgProcess: process.adapter, pgDumpBinary: controlledPgExecutable(f), pgRestoreBinary: controlledPgExecutable(f, "pg_restore") });
    expect(result.finalPath).toBeTruthy();
    // Same connection: BEGIN 必须先于一切 identity/catalog 查询；pg_export_snapshot
    // 在事务内、identity 复验之后；COMMIT 在 dump 成功之后。
    expect(source.queries[0]).toMatch(/^BEGIN /);
    expect(source.queries[0]).toContain("REPEATABLE READ");
    expect(source.queries[0]).toContain("READ ONLY");
    const identityIndex = source.queries.findIndex((text) => text.includes("current_database()"));
    const exportIndex = source.queries.findIndex((text) => text.includes("pg_export_snapshot"));
    expect(identityIndex).toBeGreaterThan(0);
    expect(exportIndex).toBeGreaterThan(identityIndex);
    // The dump argv consumes exactly the exported snapshot id.
    const dump = process.requests.find((request) => request.args.includes("--format=custom"));
    expect(dump?.args).toContain("--snapshot=0003A0-1");
    expect(dump?.args).toContain("--schema=app_schema");
    expect(source.queries.at(-1)).toBe("COMMIT");
    expect(source.queries).not.toContain("ROLLBACK");
  });

  it("fails closed when pg_export_snapshot fails, is empty, or the snapshot transaction cannot start (zero publication)", async () => {
    const f = fixture();
    // pg_export_snapshot 报错（老版本/权限不足）→ fail-closed，无 dump、无发布。
    const noExport: PgBackupClient = {
      async query<T extends Record<string, unknown>>(text: string): Promise<{ readonly rows: readonly T[] }> {
        if (text.startsWith("BEGIN ") || text === "COMMIT" || text === "ROLLBACK") return { rows: [] as unknown as readonly T[] };
        if (text.includes("pg_export_snapshot")) throw new Error("function pg_export_snapshot() does not exist");
        if (text.includes("pg_control_system")) return { rows: [{ system_identifier: "7234567890123456789" }] as unknown as readonly T[] };
        if (text.includes("inet_server_addr")) return { rows: [{ database_oid: "16384", schema_oid: "16401", server_address: "192.0.2.10", server_port: "5432", cluster_name: "" }] as unknown as readonly T[] };
        if (text.includes("current_database()")) return { rows: [{ database: "source_db", schema: "app_schema", user: "backup_user" }] as unknown as readonly T[] };
        if (text === "SHOW server_version_num") return { rows: [{ server_version_num: "160004" }] as unknown as readonly T[] };
        if (text.includes("information_schema.tables")) return { rows: [{ present: false }] as unknown as readonly T[] };
        throw new Error(`unexpected fake source query: ${text}`);
      },
    };
    const process = recordingProductionAdapter();
    await expect(createPostgresBackup({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: noExport, pgProcess: process.adapter }))
      .rejects.toThrow(/pg_export_snapshot\(\) failed/);
    expect(process.requests).toEqual([]); // identity 失败在工具预检之前：不 spawn 任何 pg 工具
    expect(existsSync(f.backupRoot)).toBe(false);

    // 导出为空/畸形 → 同样拒绝。
    let emptyExport = true;
    const emptyClient: PgBackupClient = {
      async query<T extends Record<string, unknown>>(text: string): Promise<{ readonly rows: readonly T[] }> {
        if (text.startsWith("BEGIN ") || text === "COMMIT" || text === "ROLLBACK") return { rows: [] as unknown as readonly T[] };
        if (text.includes("pg_export_snapshot")) {
          if (emptyExport) { emptyExport = false; return { rows: [{ snapshot: "" }] as unknown as readonly T[] }; }
          return { rows: [{ snapshot: "bad id with spaces" }] as unknown as readonly T[] };
        }
        if (text.includes("pg_control_system")) return { rows: [{ system_identifier: "7234567890123456789" }] as unknown as readonly T[] };
        if (text.includes("inet_server_addr")) return { rows: [{ database_oid: "16384", schema_oid: "16401", server_address: "192.0.2.10", server_port: "5432", cluster_name: "" }] as unknown as readonly T[] };
        if (text.includes("current_database()")) return { rows: [{ database: "source_db", schema: "app_schema", user: "backup_user" }] as unknown as readonly T[] };
        if (text === "SHOW server_version_num") return { rows: [{ server_version_num: "160004" }] as unknown as readonly T[] };
        if (text.includes("information_schema.tables")) return { rows: [{ present: false }] as unknown as readonly T[] };
        throw new Error(`unexpected fake source query: ${text}`);
      },
    };
    await expect(createPostgresBackup({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: emptyClient, pgProcess: process.adapter }))
      .rejects.toThrow(/no usable snapshot id/);
    expect(existsSync(f.backupRoot)).toBe(false);

    // BEGIN 失败 → 拒绝，且不执行任何 identity 查询。
    const beginFails: PgBackupClient = {
      async query<T extends Record<string, unknown>>(text: string): Promise<{ readonly rows: readonly T[] }> {
        if (text.startsWith("BEGIN ")) throw new Error("server refused the transaction");
        throw new Error(`unexpected fake source query: ${text}`);
      },
    };
    await expect(createPostgresBackup({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: beginFails, pgProcess: process.adapter }))
      .rejects.toThrow(/snapshot transaction could not be started/);
    expect(existsSync(f.backupRoot)).toBe(false);
  });

  it("rolls back the snapshot transaction and publishes nothing when pg_dump fails", async () => {
    const f = fixture();
    const source = sourceClient(f);
    const dumpFailed = createPostgresBackup({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: source, pgProcess: new FakePgProcess(true) });
    await expect(dumpFailed).rejects.toThrow(/pg_dump failed/);
    expect(source.queries).toContain("ROLLBACK");
    expect(source.queries).not.toContain("COMMIT");
    expect(!existsSync(f.backupRoot) || readdirSync(f.backupRoot).length === 0).toBe(true);
  });

  it("redacts bounded child stderr and reports exit/signal for pg_dump and pg_restore failures", async () => {
    const username = "secret-child-user";
    const password = "secret-child-password";
    const passfile = "/private/secret-user/.pgpass-secret";
    const dumpPath = "/private/secret-user/dump-secret.pg_dump";
    const stderr = Buffer.from(`HEAD-SECRET-${"x".repeat(5000)}postgres://url-user:${password}@db.example.test/private-db PGPASSFILE=${passfile} password=${password} user "${username}" ${dumpPath} TAIL-DIAGNOSTIC\n`);
    const adapter: PgProcessAdapter = { async run(request) {
      expect(request.args).toEqual([]);
      return { code: null, signal: "SIGTERM", stdout: Buffer.alloc(0), stderr };
    } };
    const env = { PGUSER: username, PGPASSFILE: passfile };
    await expect(runPgProcess(adapter, "pg_restore", "pg_restore", [], env, { stdinPath: dumpPath }, [password]))
      .rejects.toThrow(/pg_restore failed \(exit=null, signal=SIGTERM\).*TAIL-DIAGNOSTIC/);
    try {
      await runPgProcess(adapter, "pg_dump", "pg_dump", [], env, { stdoutPath: dumpPath }, [password]);
    } catch (error) {
      const message = String(error);
      expect(message).not.toContain("HEAD-SECRET");
      for (const secret of [password, username, passfile, dumpPath, "postgres://url-user"]) expect(message).not.toContain(secret);
      expect(message).toContain("exit=null, signal=SIGTERM");
    }
    const redacted = redactPgDiagnostic(Buffer.from("password=diagnostic-secret user=diagnostic-user OPENAI_API_KEY=openai-diagnostic AWS_SECRET_ACCESS_KEY=aws-diagnostic PGPASSWORD=pg-diagnostic /private/diagnostic/path \"/private/diagnostic path\""));
    expect(Buffer.byteLength(redacted)).toBeLessThanOrEqual(4096);
    expect(redacted).not.toContain("diagnostic-secret");
    expect(redacted).not.toContain("diagnostic-user");
    expect(redacted).not.toContain("openai-diagnostic");
    expect(redacted).not.toContain("aws-diagnostic");
    expect(redacted).not.toContain("pg-diagnostic");
    expect(redacted).not.toContain("/private/diagnostic/path");
    expect(redacted).not.toContain("/private/diagnostic path");
  });

  it("fails closed without publishing COMPLETE when pg_dump fails or times out", async () => {
    const f = fixture();
    const result = createPostgresBackup({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: sourceClient(f), pgProcess: new FakePgProcess(true) });
    await expect(result).rejects.toThrow(/pg_dump failed/);
    expect(existsSync(f.backupRoot) && readdirSync(f.backupRoot).some((name) => name === "COMPLETE" || name.includes("staging"))).toBe(false);
    const timedOut = createPostgresBackup({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: sourceClient(f), pgProcess: { async run(request) { return request.args[0] === "--version" ? { code: 0, stdout: Buffer.from(`${path.basename(request.command)} (PostgreSQL) 16.4`), stderr: Buffer.alloc(0) } : { code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; } } });
    await expect(timedOut).rejects.toThrow(/pg_dump failed/);
    let encryptCalls = 0;
    const emptyAge = fakeAge();
    const trackedAge = {
      encrypt(bytes: Buffer): Buffer { encryptCalls++; return emptyAge.encrypt(bytes); },
      decrypt: emptyAge.decrypt,
    };
    const emptyDump = createPostgresBackup({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: trackedAge, pgClient: sourceClient(f), pgProcess: pgProcessAdapter, pgDumpBinary: controlledPgExecutable(f, "pg_dump", "") });
    await expect(emptyDump).rejects.toThrow(/pg_dump output is empty/);
    expect(encryptCalls).toBe(0);
    expect(existsSync(f.backupRoot) && readdirSync(f.backupRoot).some((name) => name === "COMPLETE" || name.includes("staging"))).toBe(false);
  });

  it("rejects a connection whose current_database does not match the URL database and degrades an unqueryable cluster identity to null", async () => {
    const f = fixture();
    const redirected: PgBackupClient = {
      async query<T extends Record<string, unknown>>(text: string): Promise<{ readonly rows: readonly T[] }> {
        if (text.startsWith("BEGIN ") || text === "COMMIT" || text === "ROLLBACK") return { rows: [] as unknown as readonly T[] };
        if (text.includes("pg_export_snapshot")) return { rows: [{ snapshot: "0003A0-1" }] as unknown as readonly T[] };
        if (text.includes("current_database()")) return { rows: [{ database: "other_db", schema: "app_schema", user: "backup_user" }] as unknown as readonly T[] };
        if (text === "SHOW server_version_num") return { rows: [{ server_version_num: "160004" }] as unknown as readonly T[] };
        throw new Error(`unexpected fake source query: ${text}`);
      },
    };
    await expect(createPostgresBackup({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: redirected, pgProcess: new FakePgProcess() }))
      .rejects.toThrow(/does not match the URL database/);
    expect(existsSync(f.backupRoot)).toBe(false);

    // pg_control_system() 无权限/不可用：绑定降级为 null（cutover 复验将安全 fail），备份本身仍如实发布。
    const restricted = fixture();
    const noClusterIdentity: PgBackupClient = {
      async query<T extends Record<string, unknown>>(text: string): Promise<{ readonly rows: readonly T[] }> {
        if (text.startsWith("BEGIN ") || text === "COMMIT" || text === "ROLLBACK") return { rows: [] as unknown as readonly T[] };
        if (text.includes("pg_export_snapshot")) return { rows: [{ snapshot: "0003A0-1" }] as unknown as readonly T[] };
        if (text.includes("pg_control_system")) throw new Error("permission denied for function pg_control_system");
        if (text.includes("inet_server_addr")) return { rows: [{ database_oid: "16384", schema_oid: "16401", server_address: "192.0.2.10", server_port: "5432", cluster_name: "" }] as unknown as readonly T[] };
        if (text.includes("current_database()")) return { rows: [{ database: "source_db", schema: "app_schema", user: "backup_user" }] as unknown as readonly T[] };
        if (text === "SHOW server_version_num") return { rows: [{ server_version_num: "160004" }] as unknown as readonly T[] };
        if (text.includes("information_schema.tables")) return { rows: [{ present: false }] as unknown as readonly T[] };
        throw new Error(`unexpected fake source query: ${text}`);
      },
    };
    const degraded = await createPostgresBackup({
      storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(restricted), age: fakeAge(), pgClient: noClusterIdentity,
      pgProcess: pgProcessAdapter, pgDumpBinary: controlledPgExecutable(restricted), pgRestoreBinary: controlledPgExecutable(restricted, "pg_restore"),
    });
    expect(degraded.manifest?.postgres.systemIdentifier).toBeNull();
    expect(degraded.manifest?.postgres.databaseOid).toBe("16384");
  });

  it("rejects implicit SQLite selection and malformed URLs before connecting", async () => {
    const f = fixture();
    await expect(createPostgresBackup({ storageDialect: "sqlite", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: sourceClient(f), pgProcess: new FakePgProcess() })).rejects.toThrow(/explicit PI_STORAGE_DIALECT/);
    await expect(createPostgresBackup({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test", paths: backupPaths(f), age: fakeAge(), pgClient: sourceClient(f), pgProcess: new FakePgProcess() })).rejects.toThrow(/database/);
  });

  it("strict mode fails closed on any missing session reference before publish/COMPLETE and is desensitized", async () => {
    const f = fixture();
    const missing = path.join(f.dataDir, "sessions", "gone", "history.jsonl");
    const source = sourceClient(f);
    const strictClient: PgBackupClient = {
      async query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
        if (text.includes("FROM \"app_schema\".\"sessions\"")) return { rows: [{ id: "missing-strict", pi_session_file: missing } as unknown as T] };
        return source.query<T>(text, values);
      },
    };
    let error: unknown;
    try {
      await createPostgresBackup({
        storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(),
        pgClient: strictClient, pgProcess: pgProcessAdapter, pgDumpBinary: controlledPgExecutable(f), pgRestoreBinary: controlledPgExecutable(f, "pg_restore"),
        requireCompleteSessionReferences: true,
      });
    } catch (caught) { error = caught; }
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/strict completeness: 1 session reference\(s\) are missing/);
    // 错误稳定脱敏：只含计数，绝不泄露 session id、缺失路径或本机路径。
    expect(message).not.toContain("missing-strict");
    expect(message).not.toContain("gone");
    expect(message).not.toContain(f.root);
    expect(existsSync(f.backupRoot)).toBe(false);
    // dry-run 同样 fail-closed。
    await expect(createPostgresBackup({
      storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(),
      pgClient: strictClient, pgProcess: new FakePgProcess(), requireCompleteSessionReferences: true, dryRun: true,
    })).rejects.toThrow(/strict completeness/);
    expect(existsSync(f.backupRoot)).toBe(false);
  });

  it("strict mode publishes COMPLETE when every session reference is present", async () => {
    const f = fixture();
    const result = await createPostgresBackup({
      storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(),
      pgClient: sourceClient(f), pgProcess: pgProcessAdapter, pgDumpBinary: controlledPgExecutable(f), pgRestoreBinary: controlledPgExecutable(f, "pg_restore"),
      requireCompleteSessionReferences: true,
    });
    expect(result.finalPath).toBeTruthy();
    expect(existsSync(path.join(result.finalPath!, "COMPLETE"))).toBe(true);
    expect(result.missingSessionReferences).toEqual([]);
    expect(result.manifest?.missingSessionReferences).toEqual([]);
  });
});

/** Object inside a non-system namespace, as reported by the target inventory query. */
interface FakeCatalogObject {
  readonly schema: string;
  readonly kind: string;
  readonly name: string;
}

/**
 * Emulates the PostgreSQL catalogs the restore core inspects. A freshly created
 * `pi_restore_*` database reports the inherent empty `public` namespace, no
 * object at all in any non-system namespace, only the baseline `plpgsql`
 * extension, and no user object inside a system schema; the namespaces the
 * server owns (`pg_catalog`, `information_schema`, and `pg_toast`, which holds
 * the system catalogs' TOAST tables) must never be counted.
 */
class FakeTargetDatabase implements PgRestoreClient {
  namespaces: string[] = ["public"];
  readonly migrationVersion: number | null;
  private readonly hasLedger: boolean;
  private readonly hasOutbox: boolean;
  objects: FakeCatalogObject[] = [];
  /** Database-level objects: any row beyond the initdb baseline (empty set plus
   * the `plpgsql` extension) is a non-empty-target signal (event triggers,
   * other extensions, publications, subscriptions, parameter ACLs). */
  databaseObjects: FakeCatalogObject[] = [{ schema: "(database)", kind: "extension", name: "plpgsql" }];
  /** User-created objects inside system schemas (pg_catalog/pg_toast/pg_temp_*). */
  systemObjects: FakeCatalogObject[] = [];
  readonly queries: string[] = [];
  readonly updates: string[] = [];

  constructor(
    readonly database: string,
    private readonly sessionFile: string,
    readonly schema: string = "public",
    readonly searchPath: string = '"$user", public',
    readonly user: string = "restore_user",
    readonly variant: "v0" | "v1" | "legacy-v0" | "legacy-v1" = "v0",
  ) {
    this.hasLedger = variant !== "legacy-v0" && variant !== "legacy-v1";
    this.hasOutbox = variant === "v1" || variant === "legacy-v1";
    this.migrationVersion = this.hasLedger ? (this.hasOutbox ? 1 : 0) : null;
  }

  /** Mimic the catalog effect of restoring a `--schema=<app>` dump. */
  applyRestore(schema: string, extra: readonly FakeCatalogObject[] = []): void {
    this.namespaces = [...new Set([...this.namespaces, schema])];
    const tables = [
      ...(this.hasLedger ? ["schema_migrations"] : []),
      "idempotency", "projects", "sessions",
      ...(this.hasOutbox ? ["file_operations"] : []),
    ];
    this.objects = [
      ...this.objects,
      ...tables.map((name) => ({ schema, kind: "relation", name })),
      ...extra,
    ];
  }

  async query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly T[] }> {
    this.queries.push(text);
    if (text.includes("current_database()")) return { rows: [{ database: this.database, schema: this.schema, user: this.user, search_path: this.searchPath } as unknown as T] };
    if (text === "SHOW server_version_num") return { rows: [{ server_version_num: "160004" } as unknown as T] };
    if (text.includes("pi-agent-server:pg_target_namespaces")) return { rows: this.namespaces.map((namespace_name) => ({ namespace_name }) as unknown as T) };
    if (text.includes("pi-agent-server:pg_target_object_inventory")) {
      return { rows: this.objects.map((object) => ({ object_schema: object.schema, object_kind: object.kind, object_name: object.name }) as unknown as T) };
    }
    if (text.includes("pi-agent-server:pg_target_database_level_inventory")) {
      return { rows: this.databaseObjects.map((object) => ({ object_schema: object.schema, object_kind: object.kind, object_name: object.name }) as unknown as T) };
    }
    if (text.includes("pi-agent-server:pg_target_system_user_inventory")) {
      return { rows: this.systemObjects.map((object) => ({ object_schema: object.schema, object_kind: object.kind, object_name: object.name }) as unknown as T) };
    }
    if (text.includes("nspname AS schema_name")) return { rows: this.namespaces.filter((name) => name !== "public").map((schema_name) => ({ schema_name }) as unknown as T) };
    if (text.includes("SELECT table_name FROM information_schema.tables")) {
      const tables = [
        ...(this.hasLedger ? ["schema_migrations"] : []),
        "idempotency", "projects", "sessions",
        ...(this.hasOutbox ? ["file_operations"] : []),
      ].sort();
      return { rows: tables.map((table_name) => ({ table_name }) as unknown as T) };
    }
    if (text.includes("FROM \"app_schema\".\"schema_migrations\"")) {
      if (!this.hasLedger) throw Object.assign(new Error("undefined table"), { code: "42P01" });
      const rows = this.hasOutbox
        ? [{ version: 0, name: "initial-schema", checksum: "a".repeat(64), applied_at: 1 }, { version: 1, name: "file-operations-outbox", checksum: "b".repeat(64), applied_at: 2 }]
        : [{ version: 0, name: "initial-schema", checksum: "a".repeat(64), applied_at: 1 }];
      return { rows: rows as unknown as readonly T[] };
    }
    if (text.includes("SELECT id, operation_key, kind, relative_path")) {
      return this.hasOutbox
        ? { rows: [{ id: "operation-1", operation_key: "delete-session:session-1:hash", kind: "delete", relative_path: "sessions/s1/history.jsonl", session_id: "session-1", project_id: "project-1", state: "pending", attempt_count: 0, available_at: 1, lease_until: null, lease_token: null, last_error: null, created_at: 1, updated_at: 1 }] as unknown as readonly T[] }
        : { rows: [] as unknown as readonly T[] };
    }
    if (text.includes("SELECT id, pi_session_file, capability_versions")) return { rows: [{ id: "session-1", pi_session_file: this.sessionFile, capability_versions: "{}" } as unknown as T] };
    if (text.includes("SELECT id, pi_session_file FROM")) return { rows: [{ id: "session-1", pi_session_file: this.sessionFile } as unknown as T] };
    if (text.includes("SELECT id, name, cwd, owner_key")) return { rows: [{ id: "project-1", name: "project", cwd: "/tmp/project", owner_key: "owner" } as unknown as T] };
    if (text.includes("SELECT session_id, request_id, result")) return { rows: [{ session_id: "session-1", request_id: "request-1", result: "{}" } as unknown as T] };
    if (text.includes("count(*)::int")) return { rows: [{ total: 1, invalid: 0 } as unknown as T] };
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.startsWith("UPDATE ")) {
      if (text.startsWith("UPDATE ")) this.updates.push(String(values?.[0]));
      return { rows: [] as T[] };
    }
    throw new Error(`unexpected fake target query: ${text}`);
  }
}

/** pg_restore stand-in: records every invocation and applies the dump to the fake catalog. */
class FakeRestoreProcess implements PgProcessAdapter {
  readonly requests: PgProcessRequest[] = [];
  constructor(private readonly target: FakeTargetDatabase, private readonly restoreSchema = "app_schema", private readonly extra: readonly FakeCatalogObject[] = [], private readonly version = "16.4") {}
  async run(request: PgProcessRequest) {
    this.requests.push(request);
    expect(request.args.join(" ")).not.toContain("postgres://");
    expect(request.args.join(" ")).not.toContain("target-password");
    if (request.args[0] === "--version") return { code: 0, stdout: Buffer.from(`pg_restore (PostgreSQL) ${this.version}\n`), stderr: Buffer.alloc(0) };
    this.target.applyRestore(this.restoreSchema, this.extra);
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

interface FakeRestoreOverrides {
  readonly objects?: FakeCatalogObject[];
  readonly namespaces?: string[];
  readonly databaseObjects?: FakeCatalogObject[];
  readonly systemObjects?: FakeCatalogObject[];
  readonly restoreSchema?: string;
  readonly stray?: FakeCatalogObject[];
  readonly searchPath?: string;
  readonly authenticatedSchema?: string;
  readonly variant?: "v0" | "v1" | "legacy-v0" | "legacy-v1";
}

function fakeRestoreHarness(f: ReturnType<typeof fixture>, backupPath: string, targetDb: string, overrides: FakeRestoreOverrides = {}) {
  const target = new FakeTargetDatabase(targetDb, f.session, overrides.authenticatedSchema ?? "public", overrides.searchPath ?? '"$user", public', "restore_user", overrides.variant ?? "v0");
  if (overrides.namespaces) target.namespaces = overrides.namespaces;
  if (overrides.objects) target.objects = overrides.objects;
  // databaseObjects defaults to the baseline plpgsql extension; an override
  // REPLACES the whole database-level set (tests supply offenders explicitly).
  if (overrides.databaseObjects) target.databaseObjects = overrides.databaseObjects;
  if (overrides.systemObjects) target.systemObjects = overrides.systemObjects;
  const pgProcess = new FakeRestoreProcess(target, overrides.restoreSchema ?? "app_schema", overrides.stray ?? []);
  const targetRoot = path.join(f.root, `target-${targetDb}-${Math.random().toString(36).slice(2, 8)}`);
  const restore = () => restorePostgresBackup({
    paths: { inputBackup: backupPath, targetRoot, ageIdentityFile: f.identity },
    targetDatabaseUrl: `postgres://u:target-password@example.test/${targetDb}`,
    safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT,
    age: fakeAge(),
    pgClient: target,
    pgProcess,
    verifyMigrations: async () => ({ version: target.migrationVersion ?? -1, pending: 0 }),
  });
  return { target, pgProcess, targetRoot, restore };
}

describe("PostgreSQL restore new-empty-target gate (fake catalog)", () => {
  it("fails before pg_restore when the restore client major does not match the target server", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const target = new FakeTargetDatabase("pi_restore_version_mismatch", f.session);
    const process = new FakeRestoreProcess(target, "app_schema", [], "18.6");
    const targetRoot = path.join(f.root, "target-version-mismatch");
    await expect(restorePostgresBackup({ paths: { inputBackup: backup.finalPath!, targetRoot, ageIdentityFile: f.identity }, targetDatabaseUrl: "postgres://u:p@example.test/pi_restore_version_mismatch", safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT, age: fakeAge(), pgClient: target, pgProcess: process, verifyMigrations: async () => ({ version: 0, pending: 0 }) })).rejects.toThrow(/client major 18, server major 16; install matching client/);
    expect(process.requests.map((request) => request.args[0])).toEqual(["--version"]);
    expect(existsSync(targetRoot)).toBe(false);
  });
  it("accepts a freshly created pi_restore_* database whose inherent public schema is empty", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_fresh");
    const result = await harness.restore();
    expect(result.dryRun).toBe(false);
    // The emptiness decision is object-driven and never counts server-owned
    // namespaces: pg_toast holds the system catalogs' TOAST tables in every database.
    const inventory = harness.target.queries.find((text) => text.includes("pi-agent-server:pg_target_object_inventory"));
    expect(inventory).toContain(`NOT LIKE 'pg\\_%'`);
    expect(inventory).toContain("nspname <> 'information_schema'");
    for (const catalog of ["pg_class", "pg_proc", "pg_type", "pg_operator", "pg_collation", "pg_ts_config", "pg_largeobject_metadata"]) expect(inventory).toContain(`FROM ${catalog} `);
    expect(harness.target.queries.some((text) => text.includes("pi-agent-server:pg_target_namespaces"))).toBe(true);
    const restore = harness.pgProcess.requests.find((request) => request.args[0] !== "--version");
    expect(restore?.args).toContain("--single-transaction");
    expect(restore?.args).toContain("--dbname=pi_restore_fresh");
    expect(restore?.args).not.toContain("--schema=app_schema");
    // The dump landed in the authenticated non-public schema; public stayed the bootstrap namespace.
    expect(harness.target.namespaces).toEqual(["public", "app_schema"]);
    expect(harness.target.objects.every((object) => object.schema === "app_schema")).toBe(true);
    expect(result.report.target.schemaSummary.tableCount).toBe(4);
    expect(existsSync(path.join(result.finalPath!, "sessions/s1/history.jsonl"))).toBe(true);
  });

  it("rejects a target whose public schema holds any object and never invokes pg_restore", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const offenders: FakeCatalogObject[][] = [
      [{ schema: "public", kind: "relation", name: "canary_table" }],
      [{ schema: "public", kind: "type", name: "canary_type" }],
      [{ schema: "public", kind: "routine", name: "canary_function" }],
      [{ schema: "public", kind: "collation", name: "canary_collation" }],
      [{ schema: "(database)", kind: "large object", name: "16400" }],
      [{ schema: "public", kind: "relation", name: "canary_table" }, { schema: "public", kind: "operator", name: "===" }],
    ];
    for (const [index, objects] of offenders.entries()) {
      const harness = fakeRestoreHarness(f, backup.finalPath!, `pi_restore_dirty_${index}`, { objects });
      await expect(harness.restore()).rejects.toThrow(/must be a new empty database; automatic drop is forbidden/);
      expect(harness.pgProcess.requests).toEqual([]);
      expect(existsSync(harness.targetRoot)).toBe(false);
      expect(harness.target.queries.some((text) => text.includes("current_database()"))).toBe(true);
    }
  });

  it("rejects a leftover non-system schema in the target even when it holds no object", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_leftover", { namespaces: ["public", "leftover_schema"] });
    await expect(harness.restore()).rejects.toThrow(/non-system schema\(s\): leftover_schema/);
    expect(harness.pgProcess.requests).toEqual([]);
  });

  it("names the offending object so a real gate failure is diagnosable without leaking data", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_named", { objects: [{ schema: "public", kind: "relation", name: "orders" }] });
    await expect(harness.restore()).rejects.toThrow(/public\.relation orders/);
    expect(harness.pgProcess.requests).toEqual([]);
  });

  it("rejects database-level objects: event triggers, non-baseline extensions, publications, subscriptions, parameter ACLs", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const offenders: FakeCatalogObject[][] = [
      [{ schema: "(database)", kind: "extension", name: "plpgsql" }, { schema: "(database)", kind: "event trigger", name: "evt_guard" }],
      [{ schema: "(database)", kind: "extension", name: "plpgsql" }, { schema: "(database)", kind: "extension", name: "pgcrypto" }],
      [{ schema: "(database)", kind: "extension", name: "plpgsql" }, { schema: "(database)", kind: "publication", name: "w3b2_pub" }],
      [{ schema: "(database)", kind: "extension", name: "plpgsql" }, { schema: "(database)", kind: "subscription", name: "w3b2_sub" }],
      [{ schema: "(database)", kind: "extension", name: "plpgsql" }, { schema: "(database)", kind: "parameter acl", name: "log_statement" }],
      [{ schema: "(database)", kind: "extension", name: "plpgsql" }, { schema: "(database)", kind: "extension", name: "pgcrypto" }, { schema: "(database)", kind: "event trigger", name: "evt_guard" }],
    ];
    const expectations = [
      /event trigger evt_guard/,
      /extension pgcrypto/,
      /publication w3b2_pub/,
      /subscription w3b2_sub/,
      /parameter acl log_statement/,
      /extension pgcrypto/,
    ];
    for (const [index, databaseObjects] of offenders.entries()) {
      const harness = fakeRestoreHarness(f, backup.finalPath!, `pi_restore_dblevel_${index}`, { databaseObjects });
      await expect(harness.restore()).rejects.toThrow(/must be a new empty database; automatic drop is forbidden/);
      let error: unknown;
      try { await harness.restore(); } catch (caught) { error = caught; }
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/must be a new empty database; automatic drop is forbidden/);
      expect(message).toMatch(/database-level object\(s\): \(database\)\./);
      expect(message).toMatch(expectations[index]!);
      expect(harness.pgProcess.requests).toEqual([]);
      expect(existsSync(harness.targetRoot)).toBe(false);
    }
  });

  it("allows the initdb plpgsql baseline extension on an otherwise fresh target", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    // The fake models what a real fresh database reports: exactly plpgsql in
    // pg_extension, nothing else. The empty-target gate must accept it and the
    // db-level inventory query must actually have been issued.
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_baseline_ext", { databaseObjects: [{ schema: "(database)", kind: "extension", name: "plpgsql" }] });
    const result = await harness.restore();
    expect(result.dryRun).toBe(false);
    const dbLevel = harness.target.queries.find((text) => text.includes("pi-agent-server:pg_target_database_level_inventory"));
    expect(dbLevel).toContain("pg_extension");
    expect(dbLevel).toContain("pg_event_trigger");
    expect(dbLevel).toContain("extname <> 'plpgsql'");
  });

  it("rejects user objects smuggled into system schemas, naming the system-schema owner", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const offenders: FakeCatalogObject[][] = [
      [{ schema: "pg_catalog", kind: "routine", name: "smuggled_routine" }],
      [{ schema: "information_schema", kind: "relation", name: "smuggled_view" }],
      [{ schema: "pg_toast", kind: "relation", name: "pg_toast_99999" }],
      [{ schema: "pg_temp_3", kind: "relation", name: "tmp_probe" }],
      [{ schema: "pg_catalog", kind: "type", name: "smuggled_type" }, { schema: "pg_catalog", kind: "operator", name: "===" }],
    ];
    for (const [index, systemObjects] of offenders.entries()) {
      const harness = fakeRestoreHarness(f, backup.finalPath!, `pi_restore_system_${index}`, { systemObjects });
      const first = systemObjects[0]!;
      let error: unknown;
      try { await harness.restore(); } catch (caught) { error = caught; }
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/must be a new empty database; automatic drop is forbidden/);
      expect(message).toMatch(/user object\(s\) in a system schema/);
      expect(message).toMatch(`${first.schema}.${first.kind} ${first.name}`);
      expect(harness.pgProcess.requests).toEqual([]);
      expect(existsSync(harness.targetRoot)).toBe(false);
    }
  });

  it("rejects a restore that writes outside the authenticated non-public schema", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_stray", { stray: [{ schema: "public", kind: "relation", name: "smuggled_in" }] });
    await expect(harness.restore()).rejects.toThrow(/wrote object\(s\) outside the authenticated source schema/);
    expect(existsSync(harness.targetRoot)).toBe(false);
    expect(harness.pgProcess.requests.length).toBe(2); // version probe + one restore attempt; nothing is dropped
  });

  it("rejects an explicit search_path=public target URL before pg_restore", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_sp_public", { searchPath: "public" });
    await expect(harness.restore()).rejects.toThrow(/schema public is not allowed/);
    expect(harness.pgProcess.requests).toEqual([]);
  });
});

describe("PostgreSQL restore target safety (fake process)", () => {
  it("rejects the source database/schema identity and unsafe public targets before pg_restore", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const processAdapter = new FakeRestoreProcess(new FakeTargetDatabase("pi_restore_unused", f.session));
    const sourceTarget = new FakeTargetDatabase("source_db", f.session, "app_schema", "app_schema, public");
    await expect(restorePostgresBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "target"), ageIdentityFile: f.identity }, targetDatabaseUrl: "postgres://u:p@example.test/source", safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT, age: fakeAge(), pgClient: sourceTarget, pgProcess: processAdapter, verifyMigrations: async () => ({ version: 0, pending: 0 }) })).rejects.toThrow(/matches the authenticated source/);
    expect(processAdapter.requests).toEqual([]);
    const postgresDb = new FakeTargetDatabase("postgres", f.session);
    await expect(restorePostgresBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "target-public"), ageIdentityFile: f.identity }, targetDatabaseUrl: "postgres://u:p@example.test/postgres", safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT, age: fakeAge(), pgClient: postgresDb, pgProcess: processAdapter, verifyMigrations: async () => ({ version: 0, pending: 0 }) })).rejects.toThrow(/pi_restore_/);
    const publicTarget = new FakeTargetDatabase("pi_restore_public", f.session, "public", "public");
    await expect(restorePostgresBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "target-explicit-public"), ageIdentityFile: f.identity }, targetDatabaseUrl: "postgres://u:p@example.test/pi_restore_public", safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT, age: fakeAge(), pgClient: publicTarget, pgProcess: processAdapter, verifyMigrations: async () => ({ version: 0, pending: 0 }) })).rejects.toThrow(/schema public/);
    expect(processAdapter.requests).toEqual([]);
  });

  it("rejects an authenticated source schema even in a different pi_restore_* database before pg_restore", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const processAdapter = new FakeRestoreProcess(new FakeTargetDatabase("pi_restore_unused", f.session));
    const target = new FakeTargetDatabase("pi_restore_schema_collision", f.session, "app_schema", "app_schema, public");
    await expect(restorePostgresBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "target-schema-collision"), ageIdentityFile: f.identity }, targetDatabaseUrl: "postgres://u:p@example.test/pi_restore_schema_collision", safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT, age: fakeAge(), pgClient: target, pgProcess: processAdapter, verifyMigrations: async () => ({ version: 0, pending: 0 }) })).rejects.toThrow(/matches the authenticated source schema/);
    expect(processAdapter.requests).toEqual([]);
  });

  it("enforces the canonical safety contract in the restore core", async () => {
    const f = fixture();
    const processAdapter = new FakeRestoreProcess(new FakeTargetDatabase("pi_restore_contract", f.session));
    const tamperedContract = { ...POSTGRES_RESTORE_SAFETY_CONTRACT, targetDatabasePrefix: "pi_unsafe_" } as unknown as typeof POSTGRES_RESTORE_SAFETY_CONTRACT;
    await expect(restorePostgresBackup({ paths: { inputBackup: path.join(f.root, "backup"), targetRoot: path.join(f.root, "target-contract"), ageIdentityFile: f.identity }, targetDatabaseUrl: "postgres://u:p@example.test/pi_restore_contract", safetyContract: tamperedContract, age: fakeAge(), pgClient: new FakeTargetDatabase("pi_restore_contract", f.session), pgProcess: processAdapter, verifyMigrations: async () => ({ version: 0, pending: 0 }) })).rejects.toThrow(/canonical new-empty-database safety contract/);
    expect(processAdapter.requests).toEqual([]);
    // Relaxing the empty-public bootstrap rule is a contract tamper, not an option.
    const relaxedContract = { ...POSTGRES_RESTORE_SAFETY_CONTRACT, allowEmptyDefaultPublicSchema: false } as unknown as typeof POSTGRES_RESTORE_SAFETY_CONTRACT;
    await expect(restorePostgresBackup({ paths: { inputBackup: path.join(f.root, "backup"), targetRoot: path.join(f.root, "target-contract-relaxed"), ageIdentityFile: f.identity }, targetDatabaseUrl: "postgres://u:p@example.test/pi_restore_contract", safetyContract: relaxedContract, age: fakeAge(), pgClient: new FakeTargetDatabase("pi_restore_contract", f.session), pgProcess: processAdapter, verifyMigrations: async () => ({ version: 0, pending: 0 }) })).rejects.toThrow(/canonical new-empty-database safety contract/);
  });

  it("runs a v1 fake restore, reports the ledger plus file_operations table and rows", async () => {
    const f = fixture();
    const backup = await productionBackup(f, "v1");
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_v1", { variant: "v1" });
    const result = await harness.restore();
    expect(result.report.migration).toEqual({ version: 1, pending: 0, legacy: false });
    expect(result.report.counts.fileOperations).toBe(1);
    expect(result.report.target.schemaSummary).toMatchObject({ tableCount: 5, migrationVersion: 1, foreignKeyViolations: 0 });
    expect(harness.target.queries.some((text) => text.includes('"file_operations"'))).toBe(true);
  });

  it.each([
    ["legacy v0", "legacy-v0", 3, false],
    ["legacy v1", "legacy-v1", 4, true],
  ] as const)("restores %s without a migration ledger or automatic migration", async (_label, variant, tableCount, hasOutbox) => {
    const f = fixture();
    const backup = await productionBackup(f, variant);
    const harness = fakeRestoreHarness(f, backup.finalPath!, `pi_restore_${variant.replace("-", "_")}`, { variant });
    const result = await harness.restore();
    expect(result.report.migration).toEqual({ version: null, pending: 0, legacy: true });
    expect(result.report.counts.fileOperations).toBe(hasOutbox ? 1 : 0);
    expect(result.report.target.schemaSummary.tableCount).toBe(tableCount);
  });

  it("runs fake pg_restore, verifies ledger/data and remaps DB JSONL paths without exposing target URL", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const target = new FakeTargetDatabase("pi_restore_target", f.session);
    const processAdapter = new FakeRestoreProcess(target);
    const result = await restorePostgresBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "target"), ageIdentityFile: f.identity }, targetDatabaseUrl: "postgres://u:target-password@example.test/pi_restore_target", safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT, age: fakeAge(), pgClient: target, pgProcess: processAdapter, verifyMigrations: async () => ({ version: 0, pending: 0 }) });
    expect(result.report.dialect).toBe("PostgreSQL");
    expect(result.report.counts).toMatchObject({ projects: 1, sessions: 1, idempotencyRows: 1, jsonlFiles: 1, sessionHeaders: 1, foreignKeyViolations: 0 });
    expect(result.report.target.schemaSummary).toMatchObject({ identity: result.report.target.schemaIdentity, tableCount: 4, migrationVersion: 0, foreignKeyViolations: 0 });
    expect(target.updates[0]).toContain(path.basename(result.finalPath!));
    const restore = processAdapter.requests.find((request) => request.args[0] !== "--version");
    expect(restore?.args).not.toContain("--schema=app_schema");
    expect(restore?.args.join(" ")).not.toContain("target-password");
    expect(existsSync(path.join(result.finalPath!, "sessions/s1/history.jsonl"))).toBe(true);
  });
});
function databaseUrl(base: string, database: string, schema?: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  url.searchParams.delete("options");
  if (schema) url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

/** Same URL shape, but with a verbatim search_path so the gate can emulate an operator setting. */
function searchPathUrl(base: string, database: string, searchPath: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  url.searchParams.set("options", `-c search_path=${searchPath}`);
  return url.toString();
}

function randomName(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-z0-9_]/gi, "_").slice(0, 55);
}

const PG_IDENTITY_PREFIX_SCHEMA = "pi-agent-server.pg-schema-identity.v1";

/** Records child-process invocations while delegating to the real pg_dump/pg_restore adapter. */
class RecordingPgProcess implements PgProcessAdapter {
  readonly requests: PgProcessRequest[] = [];
  async run(request: PgProcessRequest) {
    this.requests.push(request);
    return pgProcessAdapter.run(request);
  }
  get restoreRuns(): number {
    return this.requests.filter((request) => request.args[0] !== "--version").length;
  }
}

// This suite is deliberately skipped by ordinary/root tests unless all real
// tools exist. test:pg-backup refuses to run as a successful gate in that case.
describeRealPgBackup("real PostgreSQL pg_dump/pg_restore gate (WP3B2)", () => {
  let admin: Pool | undefined;
  let source: { root: string; database: string; schema: string; url: string; identity: string; backupPath: string } | undefined;

  async function adminPool(): Promise<Pool> {
    admin ??= new Pool({ connectionString: pgUrl! });
    return admin;
  }

  /** One real source database + age-encrypted dump is shared by the gated cases. */
  async function sharedSource(): Promise<NonNullable<typeof source>> {
    if (source) return source;
    const root = mkdtempSync(path.join(tmpdir(), "pi-pg-backup-real-"));
    const database = randomName("pi_w3b2_src_");
    const schema = randomName("pi_w3b2_schema_");
    const url = databaseUrl(pgUrl!, database, schema);
    const dataDir = path.join(root, "data");
    // 生命周期唯一所有权：shared source Pool 只经 closeSource 释放一次。Kysely 接管后由
    // destroy()（PostgresDriver.destroy → pool.end()）负责释放，因此绝不能再直接 end；
    // pg 会以「Called end on pool more than once」拒绝第二次 end，并把清理错误盖成用例失败。
    // 只有尚未被 Kysely 接管的 Pool（setup 半路失败）才由 closer 直接 end。
    let sourcePool: Pool | undefined;
    let sourceKysely: Awaited<ReturnType<typeof createPostgresKysely>> | undefined;
    const closeSource = createIdempotentStorageCloser(async () => {
      if (sourceKysely) await sourceKysely.destroy();
      else await sourcePool?.end();
    });
    try {
      const pool = await adminPool();
      await pool.query(`CREATE DATABASE "${database}"`);
      sourcePool = createPostgresPool(url);
      await sourcePool.query(`CREATE SCHEMA "${schema}"`);
      sourceKysely = createPostgresKysely(sourcePool);
      await runPostgresMigrations(sourceKysely);
      await sourcePool.query("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES ($1,$2,$3,$4,$5)", ["00000000-0000-4000-8000-000000000001", "real", "/tmp/real", "owner", 1]);
      const session = path.join(dataDir, "sessions", "real", "history.jsonl");
      mkdirSync(path.dirname(session), { recursive: true, mode: 0o700 });
      mkdirSync(path.join(dataDir, ".pi-agent"), { recursive: true, mode: 0o700 });
      writeFileSync(session, '{"type":"session","id":"real-header"}\n{"type":"message","id":"real-entry","parentId":null}\n', { mode: 0o600 });
      writeFileSync(path.join(dataDir, ".pi-agent", "models.json"), '{"models":[]}\n', { mode: 0o600 });
      await sourcePool.query("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, capability_versions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", ["00000000-0000-4000-8000-000000000002", "owner", "00000000-0000-4000-8000-000000000001", "real", 1, 1, session, "{}"]); await sourcePool.query("INSERT INTO idempotency (session_id, request_id, result, created_at) VALUES ($1,$2,$3,$4)", ["00000000-0000-4000-8000-000000000002", "real-request", "{}", 1]);
      await closeSource();
      const identity = path.join(root, "identity");
      const recipient = path.join(root, "recipient");
      expect(spawnSync("age-keygen", ["--output", identity], { stdio: "ignore" }).status).toBe(0);
      const recipientResult = spawnSync("age-keygen", ["-y", identity], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      expect(recipientResult.status).toBe(0);
      writeFileSync(recipient, `${recipientResult.stdout.trim()}\n`, { mode: 0o600 });
      const backup = await createPostgresBackup({ storageDialect: "postgres", databaseUrl: url, paths: { dataDir, backupRoot: path.join(root, "backups"), ageRecipientFile: recipient, authPath: path.join(root, "auth-not-backed-up.json") } });
      source = { root, database, schema, url, identity, backupPath: backup.finalPath! };
      return source;
    } catch (error) {
      // 部分失败也要释放未被 Kysely 接管的 Pool；closer 幂等，且其错误一律吞掉，
      // 保证原始断言/错误仍是用例失败原因。
      await closeSource().catch(() => undefined);
      const pool = await adminPool();
      await pool.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  async function realVariantSource(variant: "v0" | "legacy-v0" | "legacy-v1"): Promise<{ root: string; database: string; schema: string; url: string; identity: string; backupPath: string }> {
    const root = mkdtempSync(path.join(tmpdir(), `pi-pg-restore-${variant}-`));
    const database = randomName(`pi_w4a_${variant.replace("-", "_")}_`);
    const schema = randomName(`pi_w4a_schema_${variant.replace("-", "_")}_`);
    const url = databaseUrl(pgUrl!, database, schema);
    const dataDir = path.join(root, "data");
    const backupRoot = path.join(root, "backups");
    const identity = path.join(root, "identity");
    const recipient = path.join(root, "recipient");
    const sessionFile = path.join(dataDir, "sessions", "real", "history.jsonl");
    mkdirSync(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(dataDir, ".pi-agent"), { recursive: true, mode: 0o700 });
    writeFileSync(sessionFile, '{"type":"session","id":"real-variant-header"}\n{"type":"message","id":"real-variant-entry","parentId":null}\n', { mode: 0o600 });
    writeFileSync(path.join(dataDir, ".pi-agent", "models.json"), '{"models":[]}\n', { mode: 0o600 });
    let setupPool: Pool | undefined;
    let setupKysely: Awaited<ReturnType<typeof createPostgresKysely>> | undefined;
    try {
      const adminConnection = await adminPool();
      await adminConnection.query(`CREATE DATABASE "${database}"`);
      setupPool = createPostgresPool(url);
      await setupPool.query(`CREATE SCHEMA "${schema}"`);
      if (variant === "v0") {
        setupKysely = createPostgresKysely(setupPool);
        await runPostgresMigrations(setupKysely, { migrations: [migrationDefinitions[0]!] });
      } else {
        const operations = migrationDefinitions
          .slice(0, variant === "legacy-v0" ? 1 : 2)
          .flatMap((migration) => migration.operations.PostgreSQL);
        for (const operation of operations) await setupPool.query(operation.sql);
      }
      await setupPool.query("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES ($1,$2,$3,$4,$5)", ["00000000-0000-4000-8000-000000000031", variant, "/tmp/real-variant", "owner", 1]);
      await setupPool.query("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, capability_versions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", ["00000000-0000-4000-8000-000000000032", "owner", "00000000-0000-4000-8000-000000000031", variant, 1, 1, sessionFile, "{}"]);
      await setupPool.query("INSERT INTO idempotency (session_id, request_id, result, created_at) VALUES ($1,$2,$3,$4)", ["00000000-0000-4000-8000-000000000032", "request", "{}", 1]);
      if (setupKysely) await setupKysely.destroy();
      else await setupPool.end();
      setupPool = undefined;
      expect(spawnSync("age-keygen", ["--output", identity], { stdio: "ignore" }).status).toBe(0);
      const publicKey = spawnSync("age-keygen", ["-y", identity], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      expect(publicKey.status).toBe(0);
      writeFileSync(recipient, `${publicKey.stdout.trim()}\n`, { mode: 0o600 });
      const backup = await createPostgresBackup({ storageDialect: "postgres", databaseUrl: url, paths: { dataDir, backupRoot, ageRecipientFile: recipient, authPath: path.join(root, "auth-not-backed-up.json") } });
      return { root, database, schema, url, identity, backupPath: backup.finalPath! };
    } catch (error) {
      await setupKysely?.destroy().catch(() => undefined);
      if (setupPool && !setupPool.ending) await setupPool.end().catch(() => undefined);
      await (await adminPool()).query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  afterAll(async () => {
    if (source) {
      await admin?.query(`DROP DATABASE IF EXISTS "${source.database}"`).catch(() => undefined);
      rmSync(source.root, { recursive: true, force: true });
    }
    await admin?.end().catch(() => undefined);
  }, 120_000);

  it("runs pg_dump with a real pg_export_snapshot --snapshot argv (same-transaction binding)", async () => {
    const fixtureData = await sharedSource();
    const recording = new RecordingPgProcess();
    const backup = await createPostgresBackup({
      storageDialect: "postgres",
      databaseUrl: fixtureData.url,
      paths: { dataDir: path.join(fixtureData.root, "data"), backupRoot: path.join(fixtureData.root, "backups"), ageRecipientFile: path.join(fixtureData.root, "recipient") },
      pgProcess: recording,
    });
    expect(backup.finalPath).toBeTruthy();
    expect(existsSync(path.join(backup.finalPath!, "COMPLETE"))).toBe(true);
    // The production spawn argv must consume an exported snapshot id (the
    // exported snapshot text is dash-separated hex components); a server or
    // dump that rejects the same-snapshot binding fails the backup closed.
    const dump = recording.requests.find((request) => request.args.includes("--format=custom"));
    const snapshotArg = dump?.args.find((arg) => arg.startsWith("--snapshot="));
    expect(snapshotArg).toMatch(/^--snapshot=[0-9A-F]+(?:-[0-9A-F]+)+$/i);
    expect(dump?.args).toContain(`--schema=${fixtureData.schema}`);
    expect(dump?.args.join(" ")).not.toContain("postgres://");
  }, 180_000);

  it.each([
    ["authenticated v0", "v0", 0, 4, false],
    ["legacy v0", "legacy-v0", null, 3, false],
    ["legacy v1", "legacy-v1", null, 4, true],
  ] as const)("restores real PostgreSQL %s without auto-migration and reports the v0/v1 physical contract", async (_label, variant, version, tableCount, hasOutbox) => {
    const fixtureData = await realVariantSource(variant);
    const targetDb = randomName("pi_restore_w4a_");
    const pool = await adminPool();
    await pool.query(`CREATE DATABASE "${targetDb}"`);
    const targetPool = createPostgresPool(databaseUrl(pgUrl!, targetDb));
    try {
      const restored = await restorePostgresBackup({
        paths: { inputBackup: fixtureData.backupPath, targetRoot: path.join(fixtureData.root, "restored"), ageIdentityFile: fixtureData.identity },
        targetDatabaseUrl: databaseUrl(pgUrl!, targetDb),
        safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT,
      });
      expect(restored.report.migration).toEqual({ version, pending: 0, legacy: variant !== "v0" });
      expect(restored.report.counts).toMatchObject({ projects: 1, sessions: 1, idempotencyRows: 1, fileOperations: 0 });
      expect(restored.report.target.schemaSummary).toMatchObject({ tableCount, migrationVersion: version, foreignKeyViolations: 0 });
      const tables = (await targetPool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name", [fixtureData.schema])).rows.map((row) => row.table_name);
      expect(tables.includes("file_operations")).toBe(hasOutbox);
      expect(tables.includes("schema_migrations")).toBe(variant === "v0");
      if (variant === "v0") {
        // The restored v0 database is migrated only by this separate explicit
        // operation; restore itself has already reported no outbox and v0.
        const migrationPool = createPostgresPool(databaseUrl(pgUrl!, targetDb, fixtureData.schema));
        const migrationKysely = createPostgresKysely(migrationPool);
        try {
          await runPostgresMigrations(migrationKysely);
          expect((await targetPool.query(`SELECT count(*)::int AS n FROM "${fixtureData.schema}".file_operations`)).rows[0]?.n).toBe(0);
        } finally {
          await migrationKysely.destroy();
        }
      }
    } finally {
      await targetPool.end().catch(() => undefined);
      await pool.query(`DROP DATABASE IF EXISTS "${targetDb}"`).catch(() => undefined);
      rmSync(fixtureData.root, { recursive: true, force: true });
    }
  }, 180_000);

  it("restores into a freshly created pi_restore_* database whose default public schema is empty", async () => {
    const fixtureData = await sharedSource();
    const targetDb = randomName("pi_restore_");
    const pool = await adminPool();
    await pool.query(`CREATE DATABASE "${targetDb}"`);
    // Deliberately use libpq's default public search_path: the restore must
    // locate the authenticated non-public schema from the catalog afterwards.
    const targetUrl = databaseUrl(pgUrl!, targetDb);
    const targetPool = createPostgresPool(targetUrl);
    const root = mkdtempSync(path.join(tmpdir(), "pi-pg-restore-real-"));
    cleanups.push(root);
    try {
      // A new database is not catalog-empty: the system catalogs' TOAST tables live in
      // pg_toast. Only namespaces the server does not own may hold user objects, and
      // `public` must be one of them while empty.
      const outsideCoreCatalogs = await targetPool.query(
        `SELECT n.nspname AS schema_name, c.relname AS relation_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2`,
      );
      expect(outsideCoreCatalogs.rows.every((row) => String(row.schema_name).startsWith("pg_"))).toBe(true);
      const userObjects = await targetPool.query(
        `SELECT n.nspname AS schema_name, c.relname AS relation_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' ORDER BY 1, 2`,
      );
      expect(userObjects.rows).toEqual([]);
      const namespaces = await targetPool.query(`SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`);
      expect(namespaces.rows.map((row) => row.nspname)).toContain("public");

      const restored = await restorePostgresBackup({
        paths: { inputBackup: fixtureData.backupPath, targetRoot: path.join(root, "restored"), ageIdentityFile: fixtureData.identity },
        targetDatabaseUrl: targetUrl,
        safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT,
      });
      expect(restored.report.counts).toMatchObject({ projects: 1, sessions: 1, idempotencyRows: 1, fileOperations: 0, jsonlFiles: 1, foreignKeyViolations: 0 });
      // The report points at the unique authenticated non-public schema, never at public.
      expect(restored.report.target.schemaIdentity).toBe(createHash("sha256").update(`${PG_IDENTITY_PREFIX_SCHEMA}\0${fixtureData.schema}`, "utf8").digest("hex"));
      expect(restored.report.target.schemaSummary).toMatchObject({ tableCount: 5, migrationVersion: 1, foreignKeyViolations: 0 });
      const row = (await targetPool.query(`SELECT pi_session_file FROM "${fixtureData.schema}"."sessions" WHERE id = $1`, ["00000000-0000-4000-8000-000000000002"])).rows[0] as { pi_session_file: string };
      expect(row.pi_session_file).toContain(path.basename(restored.finalPath!));
      expect(readFileSync(path.join(restored.finalPath!, "sessions/real/history.jsonl")).toString()).toContain("real-entry");

      // After the restore, public is still the empty bootstrap namespace and the
      // authenticated non-public schema is the only other non-system namespace.
      const restoredNamespaces = await targetPool.query(`SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`);
      expect(new Set(restoredNamespaces.rows.map((entry) => entry.nspname) as string[])).toEqual(new Set(["public", fixtureData.schema]));
      const publicTables = await targetPool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
      expect(publicTables.rows).toEqual([]);
      const publicObjects = await targetPool.query(
        `SELECT n.nspname AS schema_name, c.relname AS relation_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`,
      );
      expect(publicObjects.rows).toEqual([]);
      const schemaTables = await targetPool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name", [fixtureData.schema]);
      expect(schemaTables.rows.map((entry) => entry.table_name)).toEqual(["file_operations", "idempotency", "projects", "schema_migrations", "sessions"]);
    } finally {
      await targetPool.end().catch(() => undefined);
      await pool.query(`DROP DATABASE IF EXISTS "${targetDb}"`).catch(() => undefined);
    }
  }, 180_000);

  it("rejects a non-empty public schema and an explicit search_path=public target without running pg_restore", async () => {
    const fixtureData = await sharedSource();
    const pool = await adminPool();
    const dirtyDb = randomName("pi_restore_");
    const publicPathDb = randomName("pi_restore_");
    const root = mkdtempSync(path.join(tmpdir(), "pi-pg-restore-real-reject-"));
    cleanups.push(root);
    try {
      await pool.query(`CREATE DATABASE "${dirtyDb}"`);
      await pool.query(`CREATE DATABASE "${publicPathDb}"`);

      const dirtyPool = createPostgresPool(databaseUrl(pgUrl!, dirtyDb));
      try {
        await dirtyPool.query("CREATE TABLE public.canary_pi_w3b2 (id integer)");
        await dirtyPool.query("CREATE FUNCTION public.canary_pi_w3b2_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
      } finally {
        await dirtyPool.end();
      }
      const dirtyTargetRoot = path.join(root, "restored-dirty");
      const dirtyProcess = new RecordingPgProcess();
      await expect(restorePostgresBackup({
        paths: { inputBackup: fixtureData.backupPath, targetRoot: dirtyTargetRoot, ageIdentityFile: fixtureData.identity },
        targetDatabaseUrl: databaseUrl(pgUrl!, dirtyDb),
        safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT,
        pgProcess: dirtyProcess,
      })).rejects.toThrow(/must be a new empty database; automatic drop is forbidden/);
      expect(dirtyProcess.requests).toEqual([]);
      expect(dirtyProcess.restoreRuns).toBe(0);
      expect(existsSync(dirtyTargetRoot)).toBe(false);

      // Same database: the rejection names the objects, so a gate failure is diagnosable.
      await expect(restorePostgresBackup({
        paths: { inputBackup: fixtureData.backupPath, targetRoot: path.join(root, "restored-dirty-named"), ageIdentityFile: fixtureData.identity },
        targetDatabaseUrl: databaseUrl(pgUrl!, dirtyDb),
        safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT,
        pgProcess: new RecordingPgProcess(),
      })).rejects.toThrow(/public\.(relation canary_pi_w3b2|routine canary_pi_w3b2_fn)/);

      // An operator who points the target URL's search_path at public is refused too:
      // public is only ever the bootstrap namespace, never a restore schema.
      const publicPathProcess = new RecordingPgProcess();
      await expect(restorePostgresBackup({
        paths: { inputBackup: fixtureData.backupPath, targetRoot: path.join(root, "restored-public-path"), ageIdentityFile: fixtureData.identity },
        targetDatabaseUrl: searchPathUrl(pgUrl!, publicPathDb, "public"),
        safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT,
        pgProcess: publicPathProcess,
      })).rejects.toThrow(/schema public is not allowed/);
      expect(publicPathProcess.requests).toEqual([]);
      const confirmTarget = createPostgresPool(searchPathUrl(pgUrl!, publicPathDb, "public"));
      try {
        const identity = await confirmTarget.query("SELECT current_database() AS database, current_schema() AS schema, current_setting('search_path') AS search_path");
        expect(identity.rows[0]).toMatchObject({ database: publicPathDb, schema: "public", search_path: "public" });
      } finally {
        await confirmTarget.end();
      }
    } finally {
      await pool.query(`DROP DATABASE IF EXISTS "${dirtyDb}"`).catch(() => undefined);
      await pool.query(`DROP DATABASE IF EXISTS "${publicPathDb}"`).catch(() => undefined);
    }
  }, 180_000);

  it("rejects event triggers, database-level objects, non-baseline extensions, and system-schema user objects in a pi_restore_* target before pg_restore", async () => {
    const fixtureData = await sharedSource();
    const pool = await adminPool();
    const root = mkdtempSync(path.join(tmpdir(), "pi-pg-restore-real-dblevel-"));
    cleanups.push(root);
    const victims = ["pi_restore_evt", "pi_restore_pub", "pi_restore_ext", "pi_restore_sys"]
      .map((prefix) => ({ name: randomName(prefix), expectations: new RegExp(prefix.replace("pi_restore_", "")) }));
    try {
      for (const target of victims) {
        await pool.query(`CREATE DATABASE "${target.name}"`);
        const offenderPool = createPostgresPool(databaseUrl(pgUrl!, target.name));
        try {
          if (target.name.startsWith("pi_restore_evt")) {
            // An event trigger needs its trigger function; keep it in pg_catalog
            // so no non-system-schema object distracts from the db-level rejection.
            await offenderPool.query("CREATE FUNCTION pg_catalog.w3b2_evt_fn() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN NULL; END $$");
            await offenderPool.query("CREATE EVENT TRIGGER w3b2_evt ON ddl_command_start EXECUTE FUNCTION pg_catalog.w3b2_evt_fn()");
          } else if (target.name.startsWith("pi_restore_pub")) {
            // A publication is a pure database-level object: no schema content at all.
            await offenderPool.query("CREATE PUBLICATION w3b2_pub");
          } else if (target.name.startsWith("pi_restore_ext")) {
            // A non-baseline extension (beyond the initdb plpgsql).
            await offenderPool.query("CREATE EXTENSION pg_stat_statements");
          } else {
            // A user function smuggled into a system schema (pg_catalog).
            await offenderPool.query("CREATE FUNCTION pg_catalog.w3b2_sys_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
          }
        } finally {
          await offenderPool.end();
        }
        const process = new RecordingPgProcess();
        let error: unknown;
        try {
          await restorePostgresBackup({
            paths: { inputBackup: fixtureData.backupPath, targetRoot: path.join(root, "restored-" + target.name), ageIdentityFile: fixtureData.identity },
            targetDatabaseUrl: databaseUrl(pgUrl!, target.name),
            safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT,
            pgProcess: process,
          });
        } catch (caught) { error = caught; }
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toMatch(/must be a new empty database; automatic drop is forbidden/);
        if (target.name.startsWith("pi_restore_evt")) expect(message).toMatch(/database-level object\(s\): \(database\)\.event trigger w3b2_evt/);
        if (target.name.startsWith("pi_restore_pub")) expect(message).toMatch(/database-level object\(s\): \(database\)\.publication w3b2_pub/);
        if (target.name.startsWith("pi_restore_ext")) expect(message).toMatch(/target already contains object\(s\): public\.relation pg_stat_statements/);
        if (target.name.startsWith("pi_restore_sys")) expect(message).toMatch(/user object\(s\) in a system schema: pg_catalog\.routine w3b2_sys_fn/);
        expect(process.requests).toEqual([]); // the empty-target gate failed before pg_restore
        expect(existsSync(path.join(root, "restored-" + target.name))).toBe(false);
      }
    } finally {
      for (const target of victims) {
        await pool.query(`DROP DATABASE IF EXISTS "${target.name}"`).catch(() => undefined);
      }
    }
  }, 180_000);

  it("strict completeness: a missing session reference publishes no package", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-pg-strict-real-"));
    const database = randomName("pi_w3b2_strict_");
    const schema = randomName("pi_w3b2_strict_schema_");
    const url = databaseUrl(pgUrl!, database, schema);
    const dataDir = path.join(root, "data");
    const backupRoot = path.join(root, "backups");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // 引用必须位于白名单根内（sessions/<id>/<file> 布局）但文件缺失。
    const missing = path.join(dataDir, "sessions", "gone", "history.jsonl");
    const recipient = path.join(root, "recipient");
    let pool: Pool | undefined;
    let kysely: Awaited<ReturnType<typeof createPostgresKysely>> | undefined;
    try {
      await (await adminPool()).query(`CREATE DATABASE "${database}"`);
      pool = createPostgresPool(url);
      await pool.query(`CREATE SCHEMA "${schema}"`);
      kysely = createPostgresKysely(pool);
      await runPostgresMigrations(kysely);
      await pool.query("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES ($1,$2,$3,$4,$5)", ["00000000-0000-4000-8000-000000000041", "strict", "/tmp/strict", "owner", 1]);
      await pool.query("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, capability_versions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", ["00000000-0000-4000-8000-000000000042", "owner", "00000000-0000-4000-8000-000000000041", "strict", 1, 1, missing, "{}"]);
      await kysely.destroy();
      kysely = undefined;
      pool = undefined;
      expect(spawnSync("age-keygen", ["--output", path.join(root, "identity")], { stdio: "ignore" }).status).toBe(0);
      const publicKey = spawnSync("age-keygen", ["-y", path.join(root, "identity")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      expect(publicKey.status).toBe(0);
      writeFileSync(recipient, `${publicKey.stdout.trim()}\n`, { mode: 0o600 });
      let error: unknown;
      try {
        await createPostgresBackup({
          storageDialect: "postgres",
          databaseUrl: url,
          paths: { dataDir, backupRoot, ageRecipientFile: recipient, authPath: path.join(root, "auth-not-backed-up.json") },
          requireCompleteSessionReferences: true,
        });
      } catch (caught) { error = caught; }
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/strict completeness: 1 session reference\(s\) are missing/);
      expect(message).not.toContain("gone");
      // 严格缺失 → 零发布：backup root 下没有任何 backup-* 包（也没有 staging 残留）。
      const entries = existsSync(backupRoot) ? readdirSync(backupRoot) : [];
      expect(entries.filter((entry) => entry.startsWith("backup-") || entry.includes("staging") || entry === "COMPLETE")).toEqual([]);
    } finally {
      await kysely?.destroy().catch(() => undefined);
      if (pool && !pool.ending) await pool.end().catch(() => undefined);
      await (await adminPool()).query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  /** Dedicated database/schema + age keys for running the REAL backup CLI. */
  async function cliStrictFixture(complete: boolean): Promise<{ root: string; database: string; schema: string; url: string; dataDir: string; backupRoot: string; recipient: string; staging: string }> {
    const root = mkdtempSync(path.join(tmpdir(), "pi-pg-cli-strict-"));
    // Plaintext staging must stay OUTSIDE the backup root AND its parent
    // (see assertStagingOutsideBackupSurface): a staging path under this
    // fixture root would sit inside the backup root's parent (root/backups)
    // and be rejected by the product's deliberate safety contract. Use a
    // dedicated private root like the smoke scripts do.
    const staging = mkdtempSync(path.join(tmpdir(), "pi-pg-cli-strict-staging-"));
    const database = randomName("pi_w3b2_cli_");
    const schema = randomName("pi_w3b2_cli_schema_");
    const url = databaseUrl(pgUrl!, database, schema);
    const dataDir = path.join(root, "data");
    const backupRoot = path.join(root, "backups");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const session = path.join(dataDir, "sessions", "cli", "history.jsonl");
    if (complete) {
      mkdirSync(path.dirname(session), { recursive: true, mode: 0o700 });
      writeFileSync(session, '{"type":"session","id":"cli-header"}\n', { mode: 0o600 });
    }
    const recipient = path.join(root, "recipient");
    let pool: Pool | undefined;
    let kysely: Awaited<ReturnType<typeof createPostgresKysely>> | undefined;
    try {
      await (await adminPool()).query(`CREATE DATABASE "${database}"`);
      pool = createPostgresPool(url);
      await pool.query(`CREATE SCHEMA "${schema}"`);
      kysely = createPostgresKysely(pool);
      await runPostgresMigrations(kysely);
      await pool.query("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES ($1,$2,$3,$4,$5)", ["00000000-0000-4000-8000-000000000051", "cli-strict", "/tmp/cli-strict", "owner", 1]);
      await pool.query("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, capability_versions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", ["00000000-0000-4000-8000-000000000052", "owner", "00000000-0000-4000-8000-000000000051", "cli-strict", 1, 1, complete ? session : path.join(dataDir, "sessions", "gone", "history.jsonl"), "{}"]);
      await kysely.destroy();
      kysely = undefined;
      pool = undefined;
      expect(spawnSync("age-keygen", ["--output", path.join(root, "identity")], { stdio: "ignore" }).status).toBe(0);
      const publicKey = spawnSync("age-keygen", ["-y", path.join(root, "identity")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      expect(publicKey.status).toBe(0);
      writeFileSync(recipient, `${publicKey.stdout.trim()}\n`, { mode: 0o600 });
      return { root, database, schema, url, dataDir, backupRoot, recipient, staging };
    } catch (error) {
      await kysely?.destroy().catch(() => undefined);
      if (pool && !pool.ending) await pool.end().catch(() => undefined);
      await (await adminPool()).query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  it("CLI strict completeness: a real PostgreSQL strict published success emits exactly one machine report line, redacted", async () => {
    const fixtureData = await cliStrictFixture(true);
    const { root, database, url, backupRoot, recipient, staging } = fixtureData;
    try {
      const cli = spawnSync("pnpm", ["exec", "tsx", "scripts/backup.ts", "--", "create", "--backup-root", backupRoot, "--age-recipient-file", recipient, "--require-complete-session-references"], {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: fixtureData.dataDir, PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: url, PI_AUTH_PATH: path.join(root, "auth-not-backed-up.json"), PI_BACKUP_STAGING_ROOT: staging },
        encoding: "utf8",
      });
      const output = `${cli.stdout}${cli.stderr}`;
      // 诊断可见：断言失败时完整 stdout+stderr 随消息展示，避免再次抓不到 CLI 根因。
      expect(cli.status, `CLI exited ${cli.status}, expected 0; stdout+stderr:\n${output}`).toBe(0);
      // 机器契约：恰好一行 backup-json-report（绝不重复、绝不缺少）。
      const lines = cli.stdout.split(/\r?\n/).filter((line) => line.startsWith("backup-json-report: "));
      expect(lines).toHaveLength(1);
      const report = JSON.parse(lines[0]!.slice("backup-json-report: ".length));
      expect(report).toMatchObject({ dialect: "postgres", status: "published", strict: true, dryRun: false, missingSessionReferences: 0 });
      expect(typeof report.payloadCount).toBe("number");
      expect(report.finalPath.startsWith(backupRoot)).toBe(true);
      expect(existsSync(path.join(report.finalPath, "COMPLETE"))).toBe(true);
      // 脱敏：URL、postgres:// 凭证形态、密码都不允许出现在 CLI 输出里。
      expect(output).not.toContain(url);
      expect(output).not.toMatch(/postgres(?:ql)?:\/\//);
      const password = new URL(url).password;
      if (password) expect(output).not.toContain(password);
      expect(cli.stdout).not.toContain("dry-run");
    } finally {
      await (await adminPool()).query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  }, 240_000);

  it("CLI strict completeness: a missing session reference publishes nothing, leaves no staging and emits no machine report", async () => {
    const fixtureData = await cliStrictFixture(false);
    const { root, database, backupRoot, recipient, staging } = fixtureData;
    try {
      const cli = spawnSync("pnpm", ["exec", "tsx", "scripts/backup.ts", "--", "create", "--backup-root", backupRoot, "--age-recipient-file", recipient, "--require-complete-session-references"], {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: fixtureData.dataDir, PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: fixtureData.url, PI_AUTH_PATH: path.join(root, "auth-not-backed-up.json"), PI_BACKUP_STAGING_ROOT: staging },
        encoding: "utf8",
      });
      const output = `${cli.stdout}${cli.stderr}`;
      // 诊断可见：断言失败时完整 stdout+stderr 随消息展示。
      expect(cli.status, `unexpected CLI success; stdout+stderr:\n${output}`).not.toBe(0);
      // 稳定脱敏的计数错误：绝不泄露 session id、缺失路径或 URL。
      expect(output).toMatch(/strict completeness: 1 session reference\(s\) are missing/);
      expect(output).not.toContain("gone");
      expect(output).not.toContain("backup-json-report:");
      expect(output).not.toContain(fixtureData.url);
      // 零发布、零 staging：backup root 未创建；staging 根下无可疑子目录。
      expect(existsSync(backupRoot)).toBe(false);
      const stagingEntries = existsSync(staging) ? readdirSync(staging) : [];
      expect(stagingEntries.filter((entry) => entry.includes("staging") || entry === "COMPLETE")).toEqual([]);
    } finally {
      await (await adminPool()).query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  }, 240_000);
});
