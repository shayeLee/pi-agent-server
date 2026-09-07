import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPostgresKysely, createPostgresPool } from "../../src/storage/postgres-bootstrap.js";
import { createIdempotentStorageCloser } from "../../src/server/storage-close.js";
import { migrationDefinitions, migrationChecksum, POSTGRES_PHYSICAL_TYPES } from "../../src/storage/migration-manifest.js";
import { runPostgresMigrations } from "../../src/storage/migration-engine.js";
import { assertPostgresClientServerMajor, assertPostgresToolMajorMatch, createPostgresBackup, createPostgresBackupForTest, defaultVerifyPostgresSourceSchema, parseClientMajor, parseServerVersionNumMajor, parseVersion, pgProcessAdapter, postgresIdentity, redactPgDiagnostic, runPgProcess, type PgBackupClient, type PgProcessAdapter, type PgProcessRequest } from "../../src/backup/postgres-backup-core.js";
import { POSTGRES_RESTORE_SAFETY_CONTRACT, restorePostgresBackup, type PgRestoreClient } from "../../src/backup/restore-core.js";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
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
  const session = path.join(dataDir, "sessions", "session-1", "history.jsonl");
  mkdirSync(path.dirname(session), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, ".pi-agent"), { recursive: true, mode: 0o700 });
  writeFileSync(session, '{"type":"session","version":3,"id":"header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/source/project"}\n{"type":"message","id":"entry","parentId":null,"timestamp":"2024-01-01T00:00:00.000Z","message":{"role":"user","content":"entry","timestamp":1}}\n', { mode: 0o600 });
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
 * single client. Every query is recorded for ordering assertions. The source
 * always reports the canonical single baseline (ledger + outbox).
 */
function sourceClient(f: ReturnType<typeof fixture>, schema = "app_schema"): PgBackupClient & { readonly queries: string[] } {
  const queries: string[] = [];
  const canonicalChecksum = migrationChecksum(migrationDefinitions[0]!);
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
      if (text.includes("current_database()")) return { rows: [{ database: "source_db", schema, user: "backup_user" } as unknown as T] };
      if (text === "SHOW server_version_num") return { rows: [{ server_version_num: "160004" } as unknown as T] };
      if (text.includes("information_schema.tables")) {
        const table = values?.[1];
        return { rows: [{ present: table === "schema_migrations" || table === "sessions" || table === "file_operations" } as unknown as T] };
      }
      if (text.includes(`FROM "${schema}"."schema_migrations"`)) {
        const rows = [{ version: 0, name: "initial-schema", checksum: canonicalChecksum, applied_at: 1 }];
        return { rows: rows as unknown as readonly T[] };
      }
      if (text.includes(`FROM "${schema}"."sessions"`)) return { rows: [{ id: "session-1", project_id: DEFAULT_PROJECT_ID, agent_kind: "pi", conversation_format: "pi-jsonl-v3", conversation_ref: f.session } as unknown as T] };
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

async function productionBackup(f: ReturnType<typeof fixture>) {
  return createPostgresBackupForTest({
    storageDialect: "postgres",
    databaseUrl: "postgres://u:source-password@example.test/source_db",
    paths: backupPaths(f),
    age: fakeAge(),
    pgClient: sourceClient(f),
    pgProcess: pgProcessAdapter,
    pgDumpBinary: controlledPgExecutable(f),
    pgRestoreBinary: controlledPgExecutable(f, "pg_restore"),
}, async () => ({ version: 0, pending: 0 }));
}

describe("PostgreSQL default physical-schema verify runs on the dump's snapshot connection", () => {
  it("issues its catalog verification on the caller-owned dedicated client, never a separate connection", async () => {
    // A sentinel client proves defaultVerifyPostgresSourceSchema drives its
    // (read-only) catalog queries through the SAME client that pg_dump's
    // snapshot transaction uses, instead of opening its own pool/connection.
    // A separate-connection verify would never touch this client.
    const queries: string[] = [];
    const dedicated: PgBackupClient = {
      async query<T extends Record<string, unknown>>(text: string) {
        queries.push(text);
        // current_schema() is the very first guard query the gate issues. Match
        // the exact application-schema probe (not the catalog WHERE clauses that
        // also happen to contain current_schema()).
        if (text.toLowerCase().includes("current_schema() as schema")) return { rows: [{ schema: "app_schema" } as unknown as T] };
        // The ledger physical-contract and catalog checks must NOT use a
        // separate connection; once they run they fail faster than any real
        // server here, proving verification is on this same client.
        throw new Error("verify-queried-same-client");
      },
    };
    await expect(defaultVerifyPostgresSourceSchema(dedicated, "app_schema")).rejects.toThrow("verify-queried-same-client");
    expect(queries.length).toBeGreaterThan(0);
  });
});

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
    await expect(createPostgresBackupForTest({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: sourceClient(f), pgProcess: process,
}, async () => ({ version: 0, pending: 0 }))).rejects.toThrow(/client major 18, server major 16; install matching client/);
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
    await expect(createPostgresBackupForTest({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: sourceClient(f), pgProcess: missingRestore,
}, async () => ({ version: 0, pending: 0 }))).rejects.toThrow(/pg_restore binary is unavailable/);
    expect(requests.map((request) => request.args[0])).toEqual(["--version", "--version"]);

    const mismatch: PgProcessAdapter = { async run(request) {
      requests.push(request);
      if (request.args[0] === "--version") return { code: 0, stdout: Buffer.from(`${request.command} (PostgreSQL) ${request.command === "pg_dump" ? "16.4" : "17.2"}`), stderr: Buffer.alloc(0) };
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    } };
    await expect(createPostgresBackupForTest({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: sourceClient(f), pgProcess: mismatch,
}, async () => ({ version: 0, pending: 0 }))).rejects.toThrow(/pg_restore.*client major 17, server major 16/);
  });

  it("validates the staged archive with pg_restore --list before publishing or encrypting", async () => {
    const f = fixture();
    let encryptCalls = 0;
    const age = { encrypt(bytes: Buffer): Buffer { encryptCalls++; return fakeAge().encrypt(bytes); } };
    await expect(createPostgresBackupForTest({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age, pgClient: sourceClient(f), pgProcess: pgProcessAdapter, pgDumpBinary: controlledPgExecutable(f), pgRestoreBinary: controlledPgExecutable(f, "pg_restore", "", 2),
}, async () => ({ version: 0, pending: 0 }))).rejects.toThrow(/pg_restore failed/);
    expect(encryptCalls).toBe(0);
    expect(!existsSync(f.backupRoot) || readdirSync(f.backupRoot).length === 0).toBe(true);
  });

  it("requires explicit postgres selection and writes schema-only pg_dump argv with a private PGPASSFILE", async () => {
    const f = fixture();
    const process = recordingProductionAdapter();
    const url = "postgresql://backup_user:source-password@example.test:5433/source_db";
    const dumpBinary = controlledPgExecutable(f);
    const result = await createPostgresBackupForTest({ storageDialect: "postgres", databaseUrl: url, paths: backupPaths(f), age: fakeAge(), pgClient: sourceClient(f), pgProcess: process.adapter, pgDumpBinary: dumpBinary, pgRestoreBinary: controlledPgExecutable(f, "pg_restore"),
}, async () => ({ version: 0, pending: 0 }));
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
    const result = await createPostgresBackupForTest({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: source, pgProcess: process.adapter, pgDumpBinary: controlledPgExecutable(f), pgRestoreBinary: controlledPgExecutable(f, "pg_restore"),
}, async () => ({ version: 0, pending: 0 }));
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
        if (text.includes("information_schema.tables")) return { rows: [{ present: true }] as unknown as readonly T[] };
        if (text.includes('FROM "app_schema"."schema_migrations"')) return { rows: [{ version: 0, name: "initial-schema", checksum: migrationChecksum(migrationDefinitions[0]!), applied_at: 1 }] as unknown as readonly T[] };
        if (text.includes('FROM "app_schema"."sessions"')) return { rows: [] as unknown as readonly T[] };
        throw new Error(`unexpected fake source query: ${text}`);
      },
    };
    const process = recordingProductionAdapter();
    await expect(createPostgresBackupForTest({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: noExport, pgProcess: process.adapter,
}, async () => ({ version: 0, pending: 0 })))
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
        if (text.includes("information_schema.tables")) return { rows: [{ present: true }] as unknown as readonly T[] };
        if (text.includes('FROM "app_schema"."schema_migrations"')) return { rows: [{ version: 0, name: "initial-schema", checksum: migrationChecksum(migrationDefinitions[0]!), applied_at: 1 }] as unknown as readonly T[] };
        if (text.includes('FROM "app_schema"."sessions"')) return { rows: [] as unknown as readonly T[] };
        throw new Error(`unexpected fake source query: ${text}`);
      },
    };
    await expect(createPostgresBackupForTest({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: emptyClient, pgProcess: process.adapter,
}, async () => ({ version: 0, pending: 0 })))
      .rejects.toThrow(/no usable snapshot id/);
    expect(existsSync(f.backupRoot)).toBe(false);

    // BEGIN 失败 → 拒绝，且不执行任何 identity 查询。
    const beginFails: PgBackupClient = {
      async query<T extends Record<string, unknown>>(text: string): Promise<{ readonly rows: readonly T[] }> {
        if (text.startsWith("BEGIN ")) throw new Error("server refused the transaction");
        throw new Error(`unexpected fake source query: ${text}`);
      },
    };
    await expect(createPostgresBackupForTest({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: beginFails, pgProcess: process.adapter,
}, async () => ({ version: 0, pending: 0 })))
      .rejects.toThrow(/snapshot transaction could not be started/);
    expect(existsSync(f.backupRoot)).toBe(false);
  });

  it("rolls back the snapshot transaction and publishes nothing when pg_dump fails", async () => {
    const f = fixture();
    const source = sourceClient(f);
    const dumpFailed = createPostgresBackupForTest({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: source, pgProcess: new FakePgProcess(true),
}, async () => ({ version: 0, pending: 0 }));
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
    const result = createPostgresBackupForTest({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: sourceClient(f), pgProcess: new FakePgProcess(true),
}, async () => ({ version: 0, pending: 0 }));
    await expect(result).rejects.toThrow(/pg_dump failed/);
    expect(existsSync(f.backupRoot) && readdirSync(f.backupRoot).some((name) => name === "COMPLETE" || name.includes("staging"))).toBe(false);
    const timedOut = createPostgresBackupForTest({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: sourceClient(f), pgProcess: { async run(request) { return request.args[0] === "--version" ? { code: 0, stdout: Buffer.from(`${path.basename(request.command)} (PostgreSQL) 16.4`), stderr: Buffer.alloc(0) } : { code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; } },
}, async () => ({ version: 0, pending: 0 }));
    await expect(timedOut).rejects.toThrow(/pg_dump failed/);
    let encryptCalls = 0;
    const emptyAge = fakeAge();
    const trackedAge = {
      encrypt(bytes: Buffer): Buffer { encryptCalls++; return emptyAge.encrypt(bytes); },
      decrypt: emptyAge.decrypt,
    };
    const emptyDump = createPostgresBackupForTest({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: trackedAge, pgClient: sourceClient(f), pgProcess: pgProcessAdapter, pgDumpBinary: controlledPgExecutable(f, "pg_dump", ""),
}, async () => ({ version: 0, pending: 0 }));
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
    await expect(createPostgresBackupForTest({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: redirected, pgProcess: new FakePgProcess(),
}, async () => ({ version: 0, pending: 0 })))
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
        if (text.includes("information_schema.tables")) return { rows: [{ present: true }] as unknown as readonly T[] };
        if (text.includes('FROM "app_schema"."schema_migrations"')) return { rows: [{ version: 0, name: "initial-schema", checksum: migrationChecksum(migrationDefinitions[0]!), applied_at: 1 }] as unknown as readonly T[] };
        if (text.includes('FROM "app_schema"."sessions"')) return { rows: [] as unknown as readonly T[] };
        throw new Error(`unexpected fake source query: ${text}`);
      },
    };
    const degraded = await createPostgresBackupForTest({
      storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(restricted), age: fakeAge(), pgClient: noClusterIdentity,
      pgProcess: pgProcessAdapter, pgDumpBinary: controlledPgExecutable(restricted), pgRestoreBinary: controlledPgExecutable(restricted, "pg_restore"),
}, async () => ({ version: 0, pending: 0 }));
    expect(degraded.manifest?.postgres.systemIdentifier).toBeNull();
    expect(degraded.manifest?.postgres.databaseOid).toBe("16384");
  });

  it("rejects implicit SQLite selection and malformed URLs before connecting", async () => {
    const f = fixture();
    await expect(createPostgresBackupForTest({ storageDialect: "sqlite", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), pgClient: sourceClient(f), pgProcess: new FakePgProcess(),
}, async () => ({ version: 0, pending: 0 }))).rejects.toThrow(/explicit PI_STORAGE_DIALECT/);
    await expect(createPostgresBackupForTest({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test", paths: backupPaths(f), age: fakeAge(), pgClient: sourceClient(f), pgProcess: new FakePgProcess(),
}, async () => ({ version: 0, pending: 0 }))).rejects.toThrow(/database/);
  });

  it("fails closed before pg_dump, encryption, publication, or dry-run success for missing, multi-row, or checksum-mismatched source ledgers", async () => {
    const f = fixture();
    const canonical = sourceClient(f);
    const cases: Array<(text: string, values: readonly unknown[] | undefined) => readonly Record<string, unknown>[]> = [
      (text) => text.includes("information_schema.tables") ? [{ present: false }] : [],
      (text) => text.includes('FROM "app_schema"."schema_migrations"')
        ? [
            { version: 0, name: "initial-schema", checksum: migrationChecksum(migrationDefinitions[0]!), applied_at: 1 },
            { version: 1, name: "legacy-extra", checksum: "b".repeat(64), applied_at: 2 },
          ]
        : [],
      (text) => text.includes('FROM "app_schema"."schema_migrations"')
        ? [{ version: 0, name: "initial-schema", checksum: "0".repeat(64), applied_at: 1 }]
        : [],
    ];
    for (const override of cases) {
      const source: PgBackupClient = {
        async query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
          const rows = override(text, values);
          if (rows.length > 0 || text.includes("information_schema.tables")) return { rows: rows as readonly T[] };
          return canonical.query<T>(text, values);
        },
      };
      for (const dryRun of [false, true]) {
        await expect(createPostgresBackupForTest({
          storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f),
          age: fakeAge(), pgClient: source, pgProcess: new FakePgProcess(), dryRun,
}, async () => ({ version: 0, pending: 0 }))).rejects.toThrow(/migration ledger|single-baseline/);
      }
      expect(existsSync(f.backupRoot)).toBe(false);
    }
  });
  it("rejects a public source schema for every backup kind including pre-owner-transfer", async () => {
    const f = fixture();
    // There is no business `public` schema: the option is gone and the
    // pre-owner-transfer kind must reject public exactly like every other kind.
    for (const kind of [undefined, "postgresql", "pre-migration", "pre-owner-transfer"] as const) {
      await expect(createPostgresBackupForTest({ storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(), backupKind: kind, pgClient: sourceClient(f, "public"), pgProcess: new FakePgProcess(),
}, async () => ({ version: 0, pending: 0 }))).rejects.toThrow(/source schema is not an allowed non-public application schema/);
    }
  });

  it("records a missing session reference as missing-as-empty and publishes (never fail-closed)", async () => {
    const f = fixture();
    const missing = path.join(f.dataDir, "sessions", "missing-session", "history.jsonl");
    const source = sourceClient(f);
    const missingClient: PgBackupClient = {
      async query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
        if (text.includes("FROM \"app_schema\".\"sessions\"")) return { rows: [{ id: "missing-session", project_id: DEFAULT_PROJECT_ID, agent_kind: "pi", conversation_format: "pi-jsonl-v3", conversation_ref: missing } as unknown as T] };
        return source.query<T>(text, values);
      },
    };
    const result = await createPostgresBackupForTest({
      storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(),
      pgClient: missingClient, pgProcess: pgProcessAdapter, pgDumpBinary: controlledPgExecutable(f), pgRestoreBinary: controlledPgExecutable(f, "pg_restore"),
}, async () => ({ version: 0, pending: 0 }));
    expect(result.finalPath).toBeTruthy();
    expect(existsSync(path.join(result.finalPath!, "COMPLETE"))).toBe(true);
    expect(result.missingSessionReferences).toEqual([{ sessionId: "missing-session", path: "sessions/missing-session/history.jsonl", status: "missing" }]);
    // dry-run 同样成功并记录缺失（不再 fail-closed）。
    const dry = await createPostgresBackupForTest({
      storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(),
      pgClient: missingClient, pgProcess: new FakePgProcess(), dryRun: true,
}, async () => ({ version: 0, pending: 0 }));
    expect(dry.dryRun).toBe(true);
    expect(dry.finalPath).toBeNull();
    expect(dry.missingSessionReferences).toHaveLength(1);
  });

  it("publishes COMPLETE when every session reference is present", async () => {
    const f = fixture();
    const result = await createPostgresBackupForTest({
      storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(),
      pgClient: sourceClient(f), pgProcess: pgProcessAdapter, pgDumpBinary: controlledPgExecutable(f), pgRestoreBinary: controlledPgExecutable(f, "pg_restore"),
}, async () => ({ version: 0, pending: 0 }));
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
  readonly migrationVersion: number | null = 0;
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
  ) {
    // The canonical single baseline always ships the ledger and the outbox.
  }

  /** Mimic the catalog effect of restoring a `--schema=<app>` dump. */
  applyRestore(schema: string, extra: readonly FakeCatalogObject[] = []): void {
    this.namespaces = [...new Set([...this.namespaces, schema])];
    const tables = ["schema_migrations", "idempotency", "projects", "sessions", "file_operations"];
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
      const tables = ["schema_migrations", "idempotency", "projects", "sessions", "file_operations"].sort();
      return { rows: tables.map((table_name) => ({ table_name }) as unknown as T) };
    }
    if (/FROM "[A-Za-z_][A-Za-z0-9_]*"\."schema_migrations"/.test(text)) {
      const canonicalChecksum = migrationChecksum(migrationDefinitions[0]!);
      const rows = [{ version: 0, name: "initial-schema", checksum: canonicalChecksum, applied_at: 1 }];
      return { rows: rows as unknown as readonly T[] };
    }
    if (text.includes("SELECT id, operation_key, kind, relative_path")) {
      return { rows: [{ id: "operation-1", operation_key: "delete-session:session-1:hash", kind: "delete", relative_path: "sessions/s1/history.jsonl", session_id: "session-1", project_id: "project-1", state: "pending", attempt_count: 0, available_at: 1, lease_until: null, lease_token: null, last_error: null, created_at: 1, updated_at: 1 }] as unknown as readonly T[] };
    }
    if (text.includes("SELECT id, agent_kind, conversation_format, conversation_ref, capability_versions")) return { rows: [{ id: "session-1", agent_kind: "pi", conversation_format: "pi-jsonl-v3", conversation_ref: this.sessionFile, capability_versions: "{}" } as unknown as T] };
    if (text.includes("SELECT id, project_id, agent_kind, conversation_format, conversation_ref FROM")) return { rows: [{ id: "session-1", project_id: DEFAULT_PROJECT_ID, agent_kind: "pi", conversation_format: "pi-jsonl-v3", conversation_ref: this.sessionFile } as unknown as T] };
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

/** pg_restore stand-in: records every invocation, answers --list with the archive's TOC, and applies the dump to the fake catalog. */
class FakeRestoreProcess implements PgProcessAdapter {
  readonly requests: PgProcessRequest[] = [];
  constructor(private readonly target: FakeTargetDatabase, private readonly restoreSchema = "app_schema", private readonly extra: readonly FakeCatalogObject[] = [], private readonly version = "16.4", private readonly archiveSchemas: readonly string[] = [restoreSchema], private readonly listOutput?: string) {}
  async run(request: PgProcessRequest) {
    this.requests.push(request);
    expect(request.args.join(" ")).not.toContain("postgres://");
    expect(request.args.join(" ")).not.toContain("target-password");
    if (request.args[0] === "--version") return { code: 0, stdout: Buffer.from(`pg_restore (PostgreSQL) ${this.version}\n`), stderr: Buffer.alloc(0) };
    // `--list` only reads the archive and returns the TOC entries; it never
    // touches the target catalog. The catalog is mutated only by the restore run.
    if (request.args[0] === "--list") return { code: 0, stdout: this.listOutput !== undefined ? Buffer.from(this.listOutput, "utf8") : listArchiveOutput(this.archiveSchemas), stderr: Buffer.alloc(0) };
    this.target.applyRestore(this.restoreSchema, this.extra);
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

/** Emit a realistic `pg_restore --list` TOC listing naming the given schemas. */
function listArchiveOutput(schemas: readonly string[]): Buffer {
  const header = `;
; Archive created at 1970-01-01T00:00:00Z
;     dbname: source
;     TOC Entries: ${schemas.length + 1}
;     Format: CUSTOM
;
; Selected TOC Entries:
;
`;
  const lines: string[] = [];
  for (const [index, schema] of schemas.entries()) {
    lines.push(`${2000 + index}; 2200 0 SCHEMA - ${schema} postgres`);
    lines.push(`${3000 + index}; 0 0 TABLE ${schema} schema_migrations postgres`);
    // A multi-word desc type: the end-anchored parser must still read the schema.
    lines.push(`${4000 + index}; 0 0 TABLE DATA ${schema} schema_migrations postgres`);
  }
  return Buffer.from(header + lines.join("\n") + "\n", "utf8");
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
  /** Schemas the fake --list reports as present in the archive (defaults to [restoreSchema]). */
  readonly archiveSchemas?: string[];
  /** Raw `pg_restore --list` bytes to replay verbatim; when set, archiveSchemas is ignored. */
  readonly listOutput?: string;
}

function fakeRestoreHarness(f: ReturnType<typeof fixture>, backupPath: string, targetDb: string, overrides: FakeRestoreOverrides = {}) {
  const target = new FakeTargetDatabase(targetDb, f.session, overrides.authenticatedSchema ?? "public", overrides.searchPath ?? '"$user", public', "restore_user");
  if (overrides.namespaces) target.namespaces = overrides.namespaces;
  if (overrides.objects) target.objects = overrides.objects;
  // databaseObjects defaults to the baseline plpgsql extension; an override
  // REPLACES the whole database-level set (tests supply offenders explicitly).
  if (overrides.databaseObjects) target.databaseObjects = overrides.databaseObjects;
  if (overrides.systemObjects) target.systemObjects = overrides.systemObjects;
  const pgProcess = new FakeRestoreProcess(target, overrides.restoreSchema ?? "app_schema", overrides.stray ?? [], undefined, overrides.archiveSchemas, overrides.listOutput);
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

/** Re-encrypt one payload with new bytes and re-bind the manifest + COMPLETE (authentic package, changed content). */
function rewritePgPayload(packagePath: string, relative: string, bytes: Buffer): void {
  const age = fakeAge();
  const payloadPath = path.join(packagePath, relative);
  const ciphertext = age.encrypt(bytes);
  writeFileSync(payloadPath, ciphertext, { mode: 0o600 });
  const manifestPath = path.join(packagePath, "manifest.json.age");
  const manifest = JSON.parse(age.decrypt(readFileSync(manifestPath)).toString()) as { files: Array<Record<string, unknown>> };
  const record = manifest.files.find((item) => item.path === relative);
  if (!record) throw new Error(`missing test payload ${relative}`);
  record.size = bytes.length;
  record.sha256 = createHash("sha256").update(bytes).digest("hex");
  record.encryptedSize = ciphertext.length;
  record.encryptedSha256 = createHash("sha256").update(ciphertext).digest("hex");
  const newManifestCipher = age.encrypt(Buffer.from(JSON.stringify(manifest), "utf8"));
  writeFileSync(manifestPath, newManifestCipher, { mode: 0o600 });
  writeFileSync(path.join(packagePath, "COMPLETE"), `${createHash("sha256").update(newManifestCipher).digest("hex")}\n`, { mode: 0o600 });
}

/** Re-encrypt a whole manifest with a change and re-bind COMPLETE (authentic package, changed metadata). */
function rewriteManifestForPgSource(packagePath: string, change: (manifest: Record<string, any>) => void): void {
  const age = fakeAge();
  const manifestPath = path.join(packagePath, "manifest.json.age");
  const manifest = JSON.parse(age.decrypt(readFileSync(manifestPath)).toString()) as Record<string, any>;
  change(manifest);
  const ciphertext = age.encrypt(Buffer.from(JSON.stringify(manifest), "utf8"));
  writeFileSync(manifestPath, ciphertext, { mode: 0o600 });
  writeFileSync(path.join(packagePath, "COMPLETE"), `${createHash("sha256").update(ciphertext).digest("hex")}\n`, { mode: 0o600 });
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
    const restore = harness.pgProcess.requests.find((request) => request.args[0] !== "--version" && request.args[0] !== "--list");
    expect(restore?.args).toContain("--single-transaction");
    expect(restore?.args).toContain("--dbname=pi_restore_fresh");
    expect(restore?.args).not.toContain("--schema=app_schema");
    // The dump landed in the authenticated non-public schema; public stayed the bootstrap namespace.
    expect(harness.target.namespaces).toEqual(["public", "app_schema"]);
    expect(harness.target.objects.every((object) => object.schema === "app_schema")).toBe(true);
    expect(result.report.target.schemaSummary.tableCount).toBe(5);
    expect(existsSync(path.join(result.finalPath!, "sessions/session-1/history.jsonl"))).toBe(true);
  });

  it("rejects a public-source package before pg_restore (no business public schema)", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    // Rewrite the authenticated package to claim the public source schema; the
    // restore must reject it before any payload staging or pg_restore run.
    rewriteManifestForPgSource(backup.finalPath!, (manifest) => {
      manifest.postgres.schemaIdentity = postgresIdentity("public", "schema");
    });
    const target = new FakeTargetDatabase("pi_restore_public_anchor", f.session);
    const process = new FakeRestoreProcess(target, "public");
    await expect(restorePostgresBackup({
      paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "target-public-anchor"), ageIdentityFile: f.identity },
      targetDatabaseUrl: "postgres://u:target-password@example.test/pi_restore_public_anchor",
      safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT,
      age: fakeAge(), pgClient: target, pgProcess: process,
      verifyMigrations: async () => ({ version: 0, pending: 0 }),
    })).rejects.toThrow(/authenticated PostgreSQL source schema public is not allowed/);
    expect(process.requests).toEqual([]);
    expect(existsSync(path.join(f.root, "target-public-anchor"))).toBe(false);
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
    expect(harness.pgProcess.requests.length).toBe(3); // version probe + one --list preflight + one restore attempt; nothing is dropped
  });

  it("rejects an explicit search_path=public target URL before pg_restore", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_sp_public", { searchPath: "public" });
    await expect(harness.restore()).rejects.toThrow(/schema public is not allowed/);
    expect(harness.pgProcess.requests).toEqual([]);
  });

  it("rejects a backup archive whose actual schema is a system schema before pg_restore (P1)", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const offenders = ["public", "information_schema", "pg_catalog", "pg_toast"];
    for (const [index, schema] of offenders.entries()) {
      const harness = fakeRestoreHarness(f, backup.finalPath!, `pi_restore_archive_system_${index}`, { archiveSchemas: [schema] });
      let error: unknown;
      try { await harness.restore(); } catch (caught) { error = caught; }
      const text = error instanceof Error ? error.message : String(error);
      expect(text).toMatch(/restore PostgreSQL archive contains a system schema/);
      expect(text).toContain(schema);
      expect(harness.pgProcess.requests.map((request) => request.args[0])).toEqual(["--version", "--list"]);
      expect(harness.pgProcess.requests.some((request) => request.args[0] !== "--version" && request.args[0] !== "--list")).toBe(false);
      expect(existsSync(harness.targetRoot)).toBe(false);
      expect(harness.target.namespaces).toEqual(["public"]);
    }
  });

  it("rejects a backup archive that contains more than one safe schema before pg_restore (P1)", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_archive_multi", { archiveSchemas: ["app_schema", "other_schema"] });
    await expect(harness.restore()).rejects.toThrow(/must contain exactly one safe non-public application schema; found 2/);
    expect(harness.pgProcess.requests.map((request) => request.args[0])).toEqual(["--version", "--list"]);
    expect(harness.pgProcess.requests.some((request) => request.args[0] !== "--version" && request.args[0] !== "--list")).toBe(false);
    expect(existsSync(harness.targetRoot)).toBe(false);
  });

  it("rejects a backup archive whose schema does not match the authenticated source identity before pg_restore (P1)", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_archive_mismatch", { archiveSchemas: ["unexpected_schema"] });
    await expect(harness.restore()).rejects.toThrow(/does not match the authenticated source schema identity/);
    expect(harness.pgProcess.requests.map((request) => request.args[0])).toEqual(["--version", "--list"]);
    expect(harness.pgProcess.requests.some((request) => request.args[0] !== "--version" && request.args[0] !== "--list")).toBe(false);
    expect(existsSync(harness.targetRoot)).toBe(false);
  });

  it("rejects a fully malformed pg_restore --list before pg_restore (P1)", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    // Every non-comment line is malformed: a non-numeric entry id and a line
    // truncated below the minimum TOC field count. The parser must reject the
    // whole listing (never skip the bad lines) and must not reach pg_restore.
    const malformedOnly = [
      ";",
      "; Archive created at 1970-01-01T00:00:00Z",
      ";     dbname: source",
      ";",
      "XYZ; 0 0 TABLE DATA app_schema schema_migrations postgres",
      "9999; 0 0 TABLE DATA",
    ].join("\n") + "\n";
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_archive_malformed", { listOutput: malformedOnly });
    await expect(harness.restore()).rejects.toThrow(/pg_restore --list output is not a valid PostgreSQL restore TOC/);
    expect(harness.pgProcess.requests.map((request) => request.args[0])).toEqual(["--version", "--list"]);
    expect(harness.pgProcess.requests.some((request) => request.args[0] !== "--version" && request.args[0] !== "--list")).toBe(false);
    expect(existsSync(harness.targetRoot)).toBe(false);
  });

  it("rejects a valid pg_restore --list that also carries a malformed line before pg_restore (P1)", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    // A valid multi-word-descriptor entry followed by a truncated entry line
    // (fewer than the minimum TOC field count) that the old parser silently
    // skipped. The strict parser must reject the whole listing (never skip the
    // malformed line), instead of passing on the single valid schema.
    const validThenMalformed = [
      ";",
      "; Archive created at 1970-01-01T00:00:00Z",
      ";     dbname: source",
      ";",
      "2000; 2200 0 SCHEMA - app_schema postgres",
      "4000; 0 0 TABLE DATA app_schema schema_migrations postgres",
      "9999; 0 0 TABLE DATA",
    ].join("\n") + "\n";
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_archive_mixed", { listOutput: validThenMalformed });
    await expect(harness.restore()).rejects.toThrow(/pg_restore --list output is not a valid PostgreSQL restore TOC/);
    expect(harness.pgProcess.requests.map((request) => request.args[0])).toEqual(["--version", "--list"]);
    expect(harness.pgProcess.requests.some((request) => request.args[0] !== "--version" && request.args[0] !== "--list")).toBe(false);
    expect(existsSync(harness.targetRoot)).toBe(false);
  });

  it("rejects an empty pg_restore --list (no applicable TOC) before pg_restore (P1)", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    // Comment/header-only output: no applicable TOC entry at all. A listing that
    // yields no application schema is rejected, never treated as an empty set.
    const emptyListing = [
      ";",
      "; Archive created at 1970-01-01T00:00:00Z",
      ";     dbname: source",
      ";     TOC Entries: 0",
      ";",
      "; Selected TOC Entries:",
      ";",
    ].join("\n") + "\n";
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_archive_empty", { listOutput: emptyListing });
    await expect(harness.restore()).rejects.toThrow(/pg_restore --list output contains no applicable archive schema/);
    expect(harness.pgProcess.requests.map((request) => request.args[0])).toEqual(["--version", "--list"]);
    expect(harness.pgProcess.requests.some((request) => request.args[0] !== "--version" && request.args[0] !== "--list")).toBe(false);
    expect(existsSync(harness.targetRoot)).toBe(false);
  });

  it("preserves a standard pg_restore --list with a multi-word descriptor and an empty owner (P1)", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    // A present-but-empty owner leaves a single trailing space before the newline
    // (pg_restore prints the owner field as `%s`). The parser must still anchor
    // namespace/tag from the END, read the multi-word `TABLE DATA` descriptor,
    // and treat the archive as containing exactly app_schema (never degrade the
    // trailing-space line into a malformed single-word-descriptor entry).
    const emptyOwnerListing = [
      ";",
      "; Archive created at 1970-01-01T00:00:00Z",
      ";     dbname: source",
      ";",
      "2000; 2200 0 SCHEMA - app_schema postgres",
      "3000; 0 0 TABLE app_schema schema_migrations postgres",
      "4000; 0 0 TABLE DATA app_schema schema_migrations ",
    ].join("\n") + "\n";
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_archive_empty_owner", { listOutput: emptyOwnerListing });
    const result = await harness.restore();
    expect(result.dryRun).toBe(false);
    expect(result.report.target.schemaSummary.tableCount).toBe(5);
    expect(harness.pgProcess.requests.some((request) => request.args[0] !== "--version" && request.args[0] !== "--list")).toBe(true);
  });

  it("accepts a real pg_restore --list whose tag contains spaces (COMMENT/ACL/DEFAULT/CONSTRAINT/EXTENSION) (P1)", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    // A real `pg_restore --list` prints entries whose TAG is multi-word (e.g.
    // `COMMENT app TABLE users`, `DEFAULT app projects id`, `CONSTRAINT app
    // projects projects_pkey`) and a present-but-empty owner for database-level
    // objects (`EXTENSION - plpgsql `). The parser must anchor the known
    // descriptor from the START (not the end of the line), take the first token
    // after it as the namespace, the final token as the owner, and everything
    // between as the tag, so these real lines still yield exactly app_schema.
    const realListing = [
      ";",
      "; Archive created at 1970-01-01T00:00:00Z",
      ";     dbname: source",
      ";",
      "2000; 2615 16401 SCHEMA - app_schema postgres",
      "2001; 0 0 COMMENT - SCHEMA app_schema postgres",
      "2002; 0 0 ACL - SCHEMA app_schema postgres",
      "2003; 3079 16427 EXTENSION - plpgsql ",
      "2004; 0 0 COMMENT - EXTENSION plpgsql ",
      "2005; 1259 16403 TABLE app_schema projects postgres",
      "2006; 0 0 COMMENT app_schema TABLE projects postgres",
      "2007; 2604 16406 DEFAULT app_schema projects id postgres",
      "2008; 0 16403 TABLE DATA app_schema projects postgres",
      "2009; 2606 16411 CONSTRAINT app_schema projects projects_pkey postgres",
      "2010; 1259 16412 INDEX app_schema projects_owner_idx postgres",
      "2011; 0 0 SEQUENCE SET app_schema projects_id_seq postgres",
      "2012; 2606 16655 FK CONSTRAINT app_schema sessions sessions_project_id_fk postgres",
    ].join("\n") + "\n";
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_archive_real_multiword_tag", { listOutput: realListing });
    const result = await harness.restore();
    expect(result.dryRun).toBe(false);
    expect(result.report.target.schemaSummary.tableCount).toBe(5);
    expect(harness.pgProcess.requests.some((request) => request.args[0] !== "--version" && request.args[0] !== "--list")).toBe(true);
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

  it("runs an authenticated baseline fake restore, reports the ledger plus file_operations table and rows", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_v1");
    const result = await harness.restore();
    expect(result.report.migration).toEqual({ version: 0, pending: 0 });
    expect(result.report.counts.fileOperations).toBe(1);
    expect(result.report.target.schemaSummary).toMatchObject({ tableCount: 5, migrationVersion: 0, foreignKeyViolations: 0 });
    expect(harness.target.queries.some((text) => text.includes('"file_operations"'))).toBe(true);
  });

  it("rejects a package without the canonical single-baseline migration ledger before payload staging", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    // Legacy RC packages carry no ledger at all; they are not recoverable.
    rewriteManifestForPgSource(backup.finalPath!, (manifest) => {
      manifest.migrationLedger = { present: false, appliedCount: 0, appliedVersion: null, checksums: [], rows: [], pending: 0 };
    });
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_no_ledger");
    await expect(harness.restore()).rejects.toThrow(/no authenticated migration ledger/);
    expect(harness.pgProcess.requests).toEqual([]);
    expect(existsSync(harness.targetRoot)).toBe(false);
  });

  it("runs fake pg_restore, verifies ledger/data and remaps DB JSONL paths without exposing target URL", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    const target = new FakeTargetDatabase("pi_restore_target", f.session);
    const processAdapter = new FakeRestoreProcess(target);
    const result = await restorePostgresBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "target"), ageIdentityFile: f.identity }, targetDatabaseUrl: "postgres://u:target-password@example.test/pi_restore_target", safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT, age: fakeAge(), pgClient: target, pgProcess: processAdapter, verifyMigrations: async () => ({ version: 0, pending: 0 }) });
    expect(result.report.dialect).toBe("PostgreSQL");
    expect(result.report.counts).toMatchObject({ projects: 1, sessions: 1, idempotencyRows: 1, jsonlFiles: 1, sessionHeaders: 1, invalidSessionHistories: 0, foreignKeyViolations: 0 });
    expect(result.report.target.schemaSummary).toMatchObject({ identity: result.report.target.schemaIdentity, tableCount: 5, migrationVersion: 0, foreignKeyViolations: 0 });
    expect(target.updates[0]).toContain(path.basename(result.finalPath!));
    const restore = processAdapter.requests.find((request) => request.args[0] !== "--version" && request.args[0] !== "--list");
    expect(restore?.args).not.toContain("--schema=app_schema");
    expect(restore?.args.join(" ")).not.toContain("target-password");
    expect(existsSync(path.join(result.finalPath!, "sessions/session-1/history.jsonl"))).toBe(true);
  });

  it("restores a PG backup whose referenced session history is missing: normalizes the reference to NULL (missing-as-empty)", async () => {
    const f = fixture();
    // 引用存在 but 文件缺失：备份记录 missing，恢复后引用归一为 NULL。
    rmSync(f.session, { force: true });
    const source = sourceClient(f);
    const missingSource: PgBackupClient = {
      async query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
        if (text.includes("FROM \"app_schema\".\"sessions\"")) return { rows: [{ id: "session-1", project_id: DEFAULT_PROJECT_ID, agent_kind: "pi", conversation_format: "pi-jsonl-v3", conversation_ref: f.session } as unknown as T] };
        return source.query<T>(text, values);
      },
    };
    const backup = await createPostgresBackupForTest({
      storageDialect: "postgres", databaseUrl: "postgres://u:p@example.test/source_db", paths: backupPaths(f), age: fakeAge(),
      pgClient: missingSource, pgProcess: pgProcessAdapter, pgDumpBinary: controlledPgExecutable(f), pgRestoreBinary: controlledPgExecutable(f, "pg_restore"),
}, async () => ({ version: 0, pending: 0 }));
    expect(backup.manifest?.missingSessionReferences).toEqual([{ sessionId: "session-1", path: "sessions/session-1/history.jsonl", status: "missing" }]);
    const target = new FakeTargetDatabase("pi_restore_missing", f.session);
    const processAdapter = new FakeRestoreProcess(target);
    const result = await restorePostgresBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "target-missing"), ageIdentityFile: f.identity }, targetDatabaseUrl: "postgres://u:target-password@example.test/pi_restore_missing", safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT, age: fakeAge(), pgClient: target, pgProcess: processAdapter, verifyMigrations: async () => ({ version: 0, pending: 0 }) });
    expect(result.report.counts.missingSessionReferences).toBe(1);
    expect(result.report.counts.invalidSessionHistories).toBe(0);
    // NULL 更新（$1 只有 session id），绝无指向 finalPath 的路径写入。
    expect(target.queries.some((text) => /SET conversation_ref = NULL/.test(text))).toBe(true);
    expect(target.queries.some((text) => /SET conversation_ref = \$1/.test(text))).toBe(false);
  });

  it("degrades a present-but-invalid PG session history (invalid-as-empty): nulls the reference and reports the count", async () => {
    const f = fixture();
    const backup = await productionBackup(f);
    // 包级字节完整性保持（hash 同步重绑定），但内容不是合法 Pi session。
    rewritePgPayload(backup.finalPath!, "payload/sessions/session-1/history.jsonl.age", Buffer.from('{"type":"session","id":"h"},{"not":"jsonl"}\n', "utf8"));
    const harness = fakeRestoreHarness(f, backup.finalPath!, "pi_restore_invalid");
    const result = await harness.restore();
    expect(result.report.status).toBe("success");
    expect(result.report.counts.invalidSessionHistories).toBe(1);
    expect(result.report.counts.sessionHeaders).toBe(0);
    expect(result.report.counts.missingSessionReferences).toBe(0);
    expect(harness.target.queries.some((text) => /SET conversation_ref = NULL/.test(text))).toBe(true);
    expect(existsSync(path.join(result.finalPath!, "sessions/session-1/history.jsonl"))).toBe(false);
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
    return this.requests.filter((request) => request.args[0] !== "--version" && request.args[0] !== "--list").length;
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
      const session = path.join(dataDir, "projects", "00000000-0000-4000-8000-000000000001", "sessions", "00000000-0000-4000-8000-000000000002", "history.jsonl");
      mkdirSync(path.dirname(session), { recursive: true, mode: 0o700 });
      mkdirSync(path.join(dataDir, ".pi-agent"), { recursive: true, mode: 0o700 });
      writeFileSync(session, '{"type":"session","version":3,"id":"real-header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/tmp/real"}\n{"type":"message","id":"real-entry","parentId":null,"timestamp":"2024-01-01T00:00:00.000Z","message":{"role":"user","content":"real","timestamp":1}}\n', { mode: 0o600 });
      writeFileSync(path.join(dataDir, ".pi-agent", "models.json"), '{"models":[]}\n', { mode: 0o600 });
      await sourcePool.query("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref, capability_versions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", ["00000000-0000-4000-8000-000000000002", "owner", "00000000-0000-4000-8000-000000000001", "real", 1, 1, session, "{}"]); await sourcePool.query("INSERT INTO idempotency (session_id, request_id, result, created_at) VALUES ($1,$2,$3,$4)", ["00000000-0000-4000-8000-000000000002", "real-request", "{}", 1]);
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

  async function realVariantSource(): Promise<{ root: string; database: string; schema: string; url: string; identity: string; backupPath: string }> {
    const root = mkdtempSync(path.join(tmpdir(), "pi-pg-restore-real-"));
    const database = randomName(`pi_w4a_real_`);
    const schema = randomName(`pi_w4a_schema_real_`);
    const url = databaseUrl(pgUrl!, database, schema);
    const dataDir = path.join(root, "data");
    const backupRoot = path.join(root, "backups");
    const identity = path.join(root, "identity");
    const recipient = path.join(root, "recipient");
    const sessionFile = path.join(dataDir, "projects", "00000000-0000-4000-8000-000000000031", "sessions", "00000000-0000-4000-8000-000000000032", "history.jsonl");
    mkdirSync(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(dataDir, ".pi-agent"), { recursive: true, mode: 0o700 });
    writeFileSync(sessionFile, '{"type":"session","version":3,"id":"real-variant-header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/tmp/real-variant"}\n{"type":"message","id":"real-variant-entry","parentId":null,"timestamp":"2024-01-01T00:00:00.000Z","message":{"role":"user","content":"variant","timestamp":1}}\n', { mode: 0o600 });
    writeFileSync(path.join(dataDir, ".pi-agent", "models.json"), '{"models":[]}\n', { mode: 0o600 });
    let setupPool: Pool | undefined;
    let setupKysely: Awaited<ReturnType<typeof createPostgresKysely>> | undefined;
    try {
      const adminConnection = await adminPool();
      await adminConnection.query(`CREATE DATABASE "${database}"`);
      setupPool = createPostgresPool(url);
      await setupPool.query(`CREATE SCHEMA "${schema}"`);
      // Current single-baseline world: the canonical v0 baseline builds the
      // full schema and ledger.
      setupKysely = createPostgresKysely(setupPool);
      await runPostgresMigrations(setupKysely);
      await setupPool.query("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES ($1,$2,$3,$4,$5)", ["00000000-0000-4000-8000-000000000031", "real", "/tmp/real-variant", "owner", 1]);
      await setupPool.query("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref, capability_versions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", ["00000000-0000-4000-8000-000000000032", "owner", "00000000-0000-4000-8000-000000000031", "real", 1, 1, sessionFile, "{}"]);
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

  it("fails closed before publication when the canonical ledger is correct but a canonical index is missing (real PG)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-pg-backup-failclosed-"));
    const database = randomName("pi_pg_failclosed_");
    const schema = randomName("pi_pg_failclosed_schema_");
    const url = databaseUrl(pgUrl!, database, schema);
    const dataDir = path.join(root, "data");
    const backupRoot = path.join(root, "backups");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    let setupPool: Pool | undefined;
    let setupKysely: Awaited<ReturnType<typeof createPostgresKysely>> | undefined;
    try {
      const adminConnection = await adminPool();
      await adminConnection.query(`CREATE DATABASE "${database}"`);
      setupPool = createPostgresPool(url);
      await setupPool.query(`CREATE SCHEMA "${schema}"`);
      setupKysely = createPostgresKysely(setupPool);
      await runPostgresMigrations(setupKysely);
      // The canonical single-baseline ledger is correct, but the physical schema
      // no longer matches the immutable manifest: a canonical index is missing.
      await setupPool.query(`DROP INDEX "${schema}".idx_projects_owner`);
      if (setupKysely) await setupKysely.destroy();
      else await setupPool.end();
      setupPool = undefined;
      const recipient = path.join(root, "recipient");
      writeFileSync(recipient, "age1clifailclosed\n", { mode: 0o600 });
      await expect(createPostgresBackup({
        storageDialect: "postgres",
        databaseUrl: url,
        paths: { dataDir, backupRoot, ageRecipientFile: recipient },
      })).rejects.toThrow(/physical schema|incompatible|不兼容|物理契约/);
      expect(existsSync(backupRoot)).toBe(false);
    } finally {
      await setupKysely?.destroy().catch(() => undefined);
      if (setupPool && !setupPool.ending) await setupPool.end().catch(() => undefined);
      await (await adminPool()).query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("fails closed before publication when an extra SQLite/PG object exists beyond the canonical schema (real PG)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-pg-backup-extra-object-"));
    const database = randomName("pi_pg_extraobj_");
    const schema = randomName("pi_pg_extraobj_schema_");
    const url = databaseUrl(pgUrl!, database, schema);
    const dataDir = path.join(root, "data");
    const backupRoot = path.join(root, "backups");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    let setupPool: Pool | undefined;
    let setupKysely: Awaited<ReturnType<typeof createPostgresKysely>> | undefined;
    try {
      const adminConnection = await adminPool();
      await adminConnection.query(`CREATE DATABASE "${database}"`);
      setupPool = createPostgresPool(url);
      await setupPool.query(`CREATE SCHEMA "${schema}"`);
      setupKysely = createPostgresKysely(setupPool);
      await runPostgresMigrations(setupKysely);
      // The canonical single-baseline ledger is correct, but an extra relation
      // / object beyond the manifest must be rejected (fail-closed) even though
      // every canonical table/column/index is intact.
      await setupPool.query(`CREATE TABLE "${schema}".extra_table (id BIGINT)`);
      await setupPool.query(`CREATE SEQUENCE "${schema}".extra_seq`);
      await setupPool.query(`CREATE VIEW "${schema}".extra_view AS SELECT id FROM "${schema}".projects`);
      if (setupKysely) await setupKysely.destroy();
      else await setupPool.end();
      setupPool = undefined;
      const recipient = path.join(root, "recipient");
      writeFileSync(recipient, "age1clifailclosed\n", { mode: 0o600 });
      await expect(createPostgresBackup({
        storageDialect: "postgres",
        databaseUrl: url,
        paths: { dataDir, backupRoot, ageRecipientFile: recipient },
      })).rejects.toThrow(/physical schema|incompatible|不兼容|物理契约|额外表/);
      expect(existsSync(backupRoot)).toBe(false);
    } finally {
      await setupKysely?.destroy().catch(() => undefined);
      if (setupPool && !setupPool.ending) await setupPool.end().catch(() => undefined);
      await (await adminPool()).query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

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
    ["authenticated baseline", 0, 5, true],
  ] as const)("restores real PostgreSQL %s without auto-migration and reports the baseline physical contract", async (_label, version, tableCount, hasOutbox) => {
    const fixtureData = await realVariantSource();
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
      expect(restored.report.migration).toEqual({ version, pending: 0 });
      expect(restored.report.counts).toMatchObject({ projects: 1, sessions: 1, idempotencyRows: 1, fileOperations: 0 });
      expect(restored.report.target.schemaSummary).toMatchObject({ tableCount, migrationVersion: version, foreignKeyViolations: 0 });
      const tables = (await targetPool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name", [fixtureData.schema])).rows.map((row) => row.table_name);
      expect(tables.includes("file_operations")).toBe(hasOutbox);
      expect(tables.includes("schema_migrations")).toBe(true);
      // The restored baseline database is migrated only by this separate explicit
      // operation; with the single baseline this is a no-op that keeps the outbox empty.
      const migrationPool = createPostgresPool(databaseUrl(pgUrl!, targetDb, fixtureData.schema));
      const migrationKysely = createPostgresKysely(migrationPool);
      try {
        await runPostgresMigrations(migrationKysely);
        expect((await targetPool.query(`SELECT count(*)::int AS n FROM "${fixtureData.schema}".file_operations`)).rows[0]?.n).toBe(0);
      } finally {
        await migrationKysely.destroy();
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
      expect(restored.report.target.schemaSummary).toMatchObject({ tableCount: 5, migrationVersion: 0, foreignKeyViolations: 0 });
      const row = (await targetPool.query(`SELECT conversation_ref FROM "${fixtureData.schema}"."sessions" WHERE id = $1`, ["00000000-0000-4000-8000-000000000002"])).rows[0] as { conversation_ref: string };
      expect(row.conversation_ref).toContain(path.basename(restored.finalPath!));
      expect(readFileSync(path.join(restored.finalPath!, "projects/00000000-0000-4000-8000-000000000001/sessions/00000000-0000-4000-8000-000000000002/history.jsonl")).toString()).toContain("real-entry");

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

  it("missing session reference: a real PostgreSQL backup publishes with the reference recorded (missing-as-empty)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-pg-missing-real-"));
    const database = randomName("pi_w3b2_missing_");
    const schema = randomName("pi_w3b2_missing_schema_");
    const url = databaseUrl(pgUrl!, database, schema);
    const dataDir = path.join(root, "data");
    const backupRoot = path.join(root, "backups");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // 引用必须位于白名单根内（projects/<projectId>/sessions/<id>/<file> 布局）但文件缺失。
    const missing = path.join(dataDir, "projects", "00000000-0000-4000-8000-000000000041", "sessions", "00000000-0000-4000-8000-000000000042", "history.jsonl");
    const recipient = path.join(root, "recipient");
    let pool: Pool | undefined;
    let kysely: Awaited<ReturnType<typeof createPostgresKysely>> | undefined;
    try {
      await (await adminPool()).query(`CREATE DATABASE "${database}"`);
      pool = createPostgresPool(url);
      await pool.query(`CREATE SCHEMA "${schema}"`);
      kysely = createPostgresKysely(pool);
      await runPostgresMigrations(kysely);
      await pool.query("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES ($1,$2,$3,$4,$5)", ["00000000-0000-4000-8000-000000000041", "missing", "/tmp/missing", "owner", 1]);
      await pool.query("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref, capability_versions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", ["00000000-0000-4000-8000-000000000042", "owner", "00000000-0000-4000-8000-000000000041", "missing", 1, 1, missing, "{}"]);
      await kysely.destroy();
      kysely = undefined;
      pool = undefined;
      expect(spawnSync("age-keygen", ["--output", path.join(root, "identity")], { stdio: "ignore" }).status).toBe(0);
      const publicKey = spawnSync("age-keygen", ["-y", path.join(root, "identity")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      expect(publicKey.status).toBe(0);
      writeFileSync(recipient, `${publicKey.stdout.trim()}\n`, { mode: 0o600 });
      const result = await createPostgresBackup({
        storageDialect: "postgres",
        databaseUrl: url,
        paths: { dataDir, backupRoot, ageRecipientFile: recipient, authPath: path.join(root, "auth-not-backed-up.json") },
      });
      // missing-as-empty：照常发布，缺失引用记入 manifest。
      expect(result.finalPath).toBeTruthy();
      expect(existsSync(path.join(result.finalPath!, "COMPLETE"))).toBe(true);
      expect(result.missingSessionReferences).toEqual([{ sessionId: "00000000-0000-4000-8000-000000000042", path: "projects/00000000-0000-4000-8000-000000000041/sessions/00000000-0000-4000-8000-000000000042/history.jsonl", status: "missing" }]);
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
    const session = path.join(dataDir, "projects", "00000000-0000-4000-8000-000000000051", "sessions", "00000000-0000-4000-8000-000000000052", "history.jsonl");
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
      await pool.query("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref, capability_versions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", ["00000000-0000-4000-8000-000000000052", "owner", "00000000-0000-4000-8000-000000000051", "cli-strict", 1, 1, session, "{}"]);
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

  it("CLI: a real PostgreSQL published success emits exactly one machine report line (missing-as-empty contract), redacted", async () => {
    const fixtureData = await cliStrictFixture(true);
    const { root, database, url, backupRoot, recipient, staging } = fixtureData;
    try {
      const cli = spawnSync("pnpm", ["exec", "tsx", "scripts/backup.ts", "--", "create", "--backup-root", backupRoot, "--age-recipient-file", recipient], {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: fixtureData.dataDir, PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: url, PI_AUTH_PATH: path.join(root, "auth-not-backed-up.json"), PI_BACKUP_STAGING_ROOT: staging },
        encoding: "utf8",
      });
      const output = `${cli.stdout}${cli.stderr}`;
      // 诊断可见：断言失败时完整 stdout+stderr 随消息展示，避免再次抓不到 CLI 根因。
      expect(cli.status, `CLI exited ${cli.status}, expected 0; stdout+stderr:\n${output}`).toBe(0);
      // 机器契约：恰好一行 backup-json-report（绝不重复、绝不缺少；无 strict 字段）。
      const lines = cli.stdout.split(/\r?\n/).filter((line) => line.startsWith("backup-json-report: "));
      expect(lines).toHaveLength(1);
      const report = JSON.parse(lines[0]!.slice("backup-json-report: ".length));
      expect(report).toMatchObject({ dialect: "postgres", status: "published", dryRun: false, missingSessionReferences: 0 });
      expect(report.strict).toBeUndefined();
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

  it("CLI: a real PostgreSQL backup with a missing session reference still publishes and reports the count", async () => {
    const fixtureData = await cliStrictFixture(false);
    const { root, database, backupRoot, recipient, staging } = fixtureData;
    try {
      const cli = spawnSync("pnpm", ["exec", "tsx", "scripts/backup.ts", "--", "create", "--backup-root", backupRoot, "--age-recipient-file", recipient], {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: fixtureData.dataDir, PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: fixtureData.url, PI_AUTH_PATH: path.join(root, "auth-not-backed-up.json"), PI_BACKUP_STAGING_ROOT: staging },
        encoding: "utf8",
      });
      const output = `${cli.stdout}${cli.stderr}`;
      // 诊断可见：断言失败时完整 stdout+stderr 随消息展示。
      expect(cli.status, `CLI failed; stdout+stderr:\n${output}`).toBe(0);
      // missing-as-empty：发布成功，机器报告包含缺失计数；绝不泄露 session id/路径/URL。
      expect(output).not.toContain("00000000-0000-4000-8000-000000000052");
      expect(output).not.toContain(fixtureData.url);
      const lines = cli.stdout.split(/\r?\n/).filter((line) => line.startsWith("backup-json-report: "));
      expect(lines).toHaveLength(1);
      const report = JSON.parse(lines[0]!.slice("backup-json-report: ".length));
      expect(report).toMatchObject({ dialect: "postgres", status: "published", dryRun: false, missingSessionReferences: 1 });
      expect(report.finalPath.startsWith(backupRoot)).toBe(true);
      expect(existsSync(path.join(report.finalPath, "COMPLETE"))).toBe(true);
      expect(existsSync(backupRoot)).toBe(true);
      const stagingEntries = existsSync(staging) ? readdirSync(staging) : [];
      expect(stagingEntries.filter((entry) => entry.includes("staging") || entry === "COMPLETE")).toEqual([]);
    } finally {
      await (await adminPool()).query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  }, 240_000);
});
