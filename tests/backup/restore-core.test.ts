import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteBackup } from "../../src/backup/backup-core.js";
import { decryptAgeBinary, InvalidSessionHistoryError, parseJsonl, restoreSqliteBackup } from "../../src/backup/restore-core.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { migrationDefinitions } from "../../src/storage/migration-manifest.js";

const canRunAge = process.env.PI_RUN_REAL_AGE_RESTORE === "1" &&
  spawnSync("age", ["--version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("age-keygen", ["-h"], { stdio: "ignore" }).status === 0;
const cleanups: string[] = [];
afterEach(() => { for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true }); });

async function fixture(realAge = true, options: { customAgentDir?: boolean; externalDb?: boolean } = {}): Promise<{ root: string; dataDir: string; agentDir: string; dbPath: string; backupRoot: string; recipient: string; identity: string }> {
  const root = mkdtempSync(path.join(tmpdir(), "pi-restore-test-"));
  cleanups.push(root);
  const dataDir = path.join(root, "source-data");
  const agentDir = options.customAgentDir ? path.join(root, "custom-agent") : path.join(dataDir, ".pi-agent");
  const backupRoot = path.join(root, "source-backups");
  mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, "projects"), { recursive: true, mode: 0o700 });
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const dbPath = options.externalDb ? path.join(root, "external-db", "pi-agent-server.db") : path.join(dataDir, "pi-agent-server.db");
  if (options.externalDb) mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  if (options.customAgentDir) writeFileSync(path.join(agentDir, "models.json"), '{"models":["custom"]}\n', { mode: 0o600 });
  const db = new DatabaseSync(dbPath);
  // Current single-baseline world: the canonical v0 baseline builds the full schema.
  await runSqliteMigrations(db, { mode: "apply" });
  db.prepare("INSERT INTO projects (id,name,cwd,owner_key,created_at) VALUES (?,?,?,?,?)").run("p", "project", "/source/project", "owner", 1);
  const sessionFile = path.join(dataDir, "sessions", "s1", "history.jsonl");
  db.prepare("INSERT INTO sessions (id,owner_key,project_id,title,created_at,updated_at,pi_session_file,capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("db-session", "owner", "p", "session", 1, 1, sessionFile, JSON.stringify({ schema: 1 }));
  db.prepare("INSERT INTO idempotency (session_id,request_id,result,created_at) VALUES (?,?,?,?)").run("db-session", "request", JSON.stringify({ accepted: true }), 1);
  db.close();
  writeFileSync(sessionFile, '{"type":"session","version":3,"id":"pi-header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/source/project"}\n{"type":"message","id":"entry","parentId":null,"timestamp":"2024-01-01T00:00:00.000Z","message":{"role":"user","content":"hello","timestamp":1}}\n', { mode: 0o600 });
  const identity = path.join(root, "identity");
  const recipient = path.join(root, "recipient");
  if (realAge) {
    const keygen = spawnSync("age-keygen", ["--output", identity], { stdio: "ignore" });
    if (keygen.status !== 0) throw new Error("age-keygen unavailable");
    const recipientResult = spawnSync("age-keygen", ["-y", identity], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (recipientResult.status !== 0) throw new Error("age recipient extraction failed");
    writeFileSync(recipient, `${recipientResult.stdout.trim()}\n`, { mode: 0o600 });
  } else {
    writeFileSync(identity, "fake identity\n", { mode: 0o600 });
    writeFileSync(recipient, "age1fakeadapter\n", { mode: 0o600 });
  }
  chmodSync(identity, 0o600);
  return { root, dataDir, agentDir, dbPath, backupRoot, recipient, identity };
}

function fakeAge() {
  return {
    encrypt(input: Buffer): Buffer { return Buffer.from(`FAKE-AGE\\n${input.toString("base64")}`, "utf8"); },
    decrypt(ciphertext: Buffer): Buffer { return Buffer.from(ciphertext.toString("utf8").split("\\n")[1]!, "base64"); },
  };
}

function sourceTreeFingerprint(root: string): string {
  return readdirSync(root, { recursive: true, withFileTypes: true }).map((entry) => {
    const relative = path.relative(root, path.join(entry.parentPath, entry.name));
    const stat = statSync(path.join(entry.parentPath, entry.name));
    const bytes = entry.isFile() ? readFileSync(path.join(entry.parentPath, entry.name)) : Buffer.alloc(0);
    return `${relative}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${createHash("sha256").update(bytes).digest("hex")}`;
  }).sort().join("\\n");
}

function sourceRootFingerprint(root: string): string {
  const stat = lstatSync(root);
  if (stat.isDirectory()) return sourceTreeFingerprint(root);
  const bytes = readFileSync(root);
  return `${stat.mode}:${stat.size}:${stat.mtimeMs}:${createHash("sha256").update(bytes).digest("hex")}`;
}

function rewriteManifest(packagePath: string, change: (manifest: Record<string, any>) => void): void {
  const age = fakeAge();
  const manifestPath = path.join(packagePath, "manifest.json.age");
  const manifest = JSON.parse(age.decrypt(readFileSync(manifestPath)).toString()) as Record<string, any>;
  change(manifest);
  const ciphertext = age.encrypt(Buffer.from(JSON.stringify(manifest), "utf8"));
  writeFileSync(manifestPath, ciphertext, { mode: 0o600 });
  writeFileSync(path.join(packagePath, "COMPLETE"), `${createHash("sha256").update(ciphertext).digest("hex")}\n`, { mode: 0o600 });
}

function rewritePayload(packagePath: string, relative: string, change: (bytes: Buffer) => Buffer): void {
  const age = fakeAge();
  const payloadPath = path.join(packagePath, relative);
  const bytes = change(age.decrypt(readFileSync(payloadPath)));
  const ciphertext = age.encrypt(bytes);
  writeFileSync(payloadPath, ciphertext, { mode: 0o600 });
  rewriteManifest(packagePath, (manifest) => {
    const record = manifest.files.find((item: { path: string }) => item.path === relative);
    if (!record) throw new Error(`missing test payload ${relative}`);
    record.size = bytes.length;
    record.sha256 = createHash("sha256").update(bytes).digest("hex");
    record.encryptedSize = ciphertext.length;
    record.encryptedSha256 = createHash("sha256").update(ciphertext).digest("hex");
  });
}

function expectNoTargetStaging(target: string): void {
  expect(existsSync(target)).toBe(false);
  expect(readdirSync(path.dirname(target)).filter((name) => name.startsWith(".pi-agent-restore-staging-") || name.startsWith(".pi-agent-restore-manifest-"))).toEqual([]);
}

function expectNoStaging(parent: string): void {
  expect(readdirSync(parent).filter((name) => name.startsWith(".pi-agent-restore-staging-") || name.startsWith(".pi-agent-restore-manifest-"))).toEqual([]);
}

// ---------------------------------------------------------------------------
// decryptAgeBinary child lifecycle (P1): the real age --decrypt child must
// distinguish a spawn error from runtime/kill errors. A spawn error rejects
// at once (the process never started); a runtime failure is already confirmed
// by its own 'close'. A timeout KILL defers both the cleanup (partial output
// removal) and the rejection until the CONFIRMED child 'close' — never while
// the killed child may still be running, and never settling early.
// ---------------------------------------------------------------------------

type DecryptFakeChild = EventEmitter & {
  stderr: Readable;
  kill: (signal?: NodeJS.Signals) => boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

function decryptStage(): { root: string; input: string; output: string } {
  const root = mkdtempSync(path.join(tmpdir(), "pi-restore-decrypt-"));
  cleanups.push(root);
  const input = path.join(root, "payload.sqlite.age");
  const output = path.join(root, "out.sqlite");
  writeFileSync(input, "CIPHERTEXT", { mode: 0o600 });
  return { root, input, output };
}

describe("decryptAgeBinary child lifecycle", () => {
  it("delayed close (P1): the timeout rejection waits for the killed child's confirmed close and cleans up only after it", async () => {
    const { root, input, output } = decryptStage();
    let killed = 0;
    let closeAt = 0;
    let hadFileAtClose = false;
    const spawnImpl = ((_command: string, _args: readonly string[]) => {
      expect(_command).toBe("age");
      expect(_args[0]).toBe("--decrypt");
      const child = new EventEmitter() as unknown as DecryptFakeChild;
      child.stderr = new Readable({ read() { /* silent stderr */ } });
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => {
        killed++;
        child.signalCode = "SIGKILL";
        // The killed child is still mid-write: it holds the output it was
        // producing. close trails the kill (reap + stdio wind-down round-trip).
        writeFileSync(output, "PARTIAL-DECRYPTED", { mode: 0o600 });
        setTimeout(() => {
          // Before emitting close the partial output must still exist: the
          // cleanup must NOT have run while the killed child was still alive.
          hadFileAtClose = existsSync(output);
          closeAt = Date.now();
          child.emit("close", null, "SIGKILL");
        }, 120);
        return true;
      };
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    const started = Date.now();
    await expect(decryptAgeBinary(input, output, "identity", spawnImpl, 50)).rejects.toThrow(/safety budget/);
    // The rejection may only surface AFTER the child's close was confirmed,
    // never while the killed child (or its output stream) was still winding down.
    expect(killed).toBe(1);
    expect(closeAt).toBeGreaterThan(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(closeAt - started);
    // The cleanup (partial output removal) also only ran after the close.
    expect(hadFileAtClose).toBe(true);
    expect(existsSync(output)).toBe(false);
  }, 5_000);

  it("delayed error (P1): an error that trails the timeout kill does not settle early; the rejection still waits for the confirmed close", async () => {
    const { input, output } = decryptStage();
    let killed = 0;
    const erroredAt = { at: 0 };
    const closeAt = { at: 0 };
    const spawnImpl = ((_command: string, _args: readonly string[]) => {
      const child = new EventEmitter() as unknown as DecryptFakeChild;
      child.stderr = new Readable({ read() { /* silent stderr */ } });
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => {
        killed++;
        child.signalCode = "SIGKILL";
        // A kill-related error trails the kill; the close trails even that.
        setTimeout(() => {
          erroredAt.at = Date.now();
          child.emit("error", new Error("simulated post-kill error"));
        }, 40);
        setTimeout(() => {
          closeAt.at = Date.now();
          child.emit("close", null, "SIGKILL");
        }, 100);
        return true;
      };
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    const started = Date.now();
    await expect(decryptAgeBinary(input, output, "identity", spawnImpl, 30)).rejects.toThrow(/safety budget/);
    expect(killed).toBe(1);
    // Both the error and the close really fired...
    expect(erroredAt.at).toBeGreaterThan(0);
    expect(closeAt.at).toBeGreaterThan(0);
    // ...but the rejection did NOT surface at the error (which fired before
    // the close): it waited for the confirmed close.
    expect(Date.now() - started).toBeGreaterThanOrEqual(closeAt.at - started);
  }, 5_000);

  it("spawn error: rejects immediately (the process never started) without waiting for a close, and removes partial output", async () => {
    const { input, output } = decryptStage();
    const spawnImpl = ((_command: string, _args: readonly string[]) => {
      const child = new EventEmitter() as unknown as DecryptFakeChild;
      child.stderr = new Readable({ read() { /* silent stderr */ } });
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => false; // never spawned: no close will ever follow
      queueMicrotask(() => child.emit("error", new Error("ENOENT")));
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    const started = Date.now();
    await expect(decryptAgeBinary(input, output, "identity", spawnImpl, 500)).rejects.toThrow(/decryption failed/);
    // Immediate rejection: a spawn error must not be deferred to a close that
    // will never fire (with a large budget the test would otherwise hang).
    expect(Date.now() - started).toBeLessThan(400);
    expect(existsSync(output)).toBe(false);
  }, 5_000);

  it("runtime error: rejects at the child's already-confirmed close and removes the partial output", async () => {
    const { input, output } = decryptStage();
    const spawnImpl = ((_command: string, _args: readonly string[]) => {
      const child = new EventEmitter() as unknown as DecryptFakeChild;
      child.stderr = new Readable({ read() { /* silent stderr */ } });
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => false;
      writeFileSync(output, "PARTIAL-DECRYPTED", { mode: 0o600 });
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit("close", 1, null);
      });
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    await expect(decryptAgeBinary(input, output, "identity", spawnImpl, 500)).rejects.toThrow(/decryption failed/);
    expect(existsSync(output)).toBe(false);
  }, 5_000);
});

describe("SQLite restore drill", () => {
  it("keeps staged JSONL read failures distinct from semantic invalidity", () => {
    const missing = path.join(tmpdir(), `pi-restore-missing-${Date.now()}.jsonl`);
    expect(() => parseJsonl(missing)).toThrow(/staged file could not be read/);
    try { parseJsonl(missing); } catch (error) { expect(error).not.toBeInstanceOf(InvalidSessionHistoryError); }
  });
  it("runs the complete core path with an injectable crypto adapter and preserves payload hashes", async () => {
    const f = await fixture(false);
    const sourceFile = path.join(f.dataDir, "sessions", "s1", "history.jsonl");
    const sourceBytes = readFileSync(sourceFile);
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    const result = await restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "restore-target"), ageIdentityFile: f.identity }, age: fakeAge() });
    expect(result.finalPath).toBeTruthy();
    expect(readFileSync(path.join(result.finalPath!, "sessions/s1/history.jsonl"))).toEqual(sourceBytes);
    expect(existsSync(path.join(result.finalPath!, ".manifest.json"))).toBe(false);
  });

  it("restores the canonical single baseline without auto-migrating and reports the physical outbox contract", async () => {
    const f = await fixture(false);
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    const result = await restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "restore-baseline"), ageIdentityFile: f.identity }, age: fakeAge() });
    expect(result.report.migration).toEqual({ version: 0, pending: 0 });
    expect(result.report.counts.fileOperations).toBe(0);
    const restoredPath = path.join(result.finalPath!, "pi-agent-server.db");
    const restoredDb = new DatabaseSync(restoredPath);
    try {
      const tables = (restoredDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables.includes("file_operations")).toBe(true);
      expect(tables.includes("schema_migrations")).toBe(true);
      // Migration is an independent, explicit operation after restore; with the
      // single baseline this is a no-op that must keep the outbox table empty.
      await runSqliteMigrations(restoredDb, { mode: "apply" });
      expect(restoredDb.prepare("SELECT count(*) AS n FROM file_operations").get()).toEqual({ n: 0 });
    } finally {
      restoredDb.close();
    }
  });

  it.skipIf(!canRunAge)("restores a complete backup, remaps source JSONL paths, and emits safe counts", async () => {
    const f = await fixture();
    const sourceBefore = readFileSync(f.dbPath);
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient } });
    const targetRoot = path.join(f.root, "restore-target");
    const result = await restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot, ageIdentityFile: f.identity } });
    expect(result.report.status).toBe("success");
    expect(result.report.migration.version).toBe(migrationDefinitions.at(-1)!.version);
    expect(result.report.counts).toMatchObject({ projects: 1, sessions: 1, idempotencyRows: 1, jsonlFiles: 1, sessionHeaders: 1 });
    expect(result.finalPath).toBeTruthy();
    const restoredDb = new DatabaseSync(path.join(result.finalPath!, "pi-agent-server.db"), { readOnly: true });
    const row = restoredDb.prepare("SELECT pi_session_file FROM sessions").get() as { pi_session_file: string };
    expect(row.pi_session_file).toContain(`${path.basename(result.finalPath!)}/sessions/s1/history.jsonl`);
    expect(row.pi_session_file).not.toContain(f.dataDir);
    restoredDb.close();
    expect(readFileSync(f.dbPath)).toEqual(sourceBefore);
    expect(existsSync(path.join(result.finalPath!, ".manifest.json"))).toBe(false);
  }, 15_000);

  it.skipIf(!canRunAge)("rejects ciphertext tampering and overlapping targets without partial output", async () => {
    const f = await fixture();
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient } });
    const payload = path.join(backup.finalPath!, "payload", "database.sqlite.age");
    const original = readFileSync(payload);
    writeFileSync(payload, Buffer.concat([original.subarray(0, original.length - 1), Buffer.from([original.at(-1)! ^ 1])]), { mode: 0o600 });
    const targetRoot = path.join(f.root, "restore-target");
    await expect(restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot, ageIdentityFile: f.identity } })).rejects.toThrow();
    expectNoTargetStaging(targetRoot);
    writeFileSync(payload, original, { mode: 0o600 });
    await expect(restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: f.backupRoot, ageIdentityFile: f.identity } })).rejects.toThrow(/overlap/);
  }, 15_000);

  it.each([
    ["dataDir", (f: Awaited<ReturnType<typeof fixture>>) => f.dataDir, (f: Awaited<ReturnType<typeof fixture>>) => f.dataDir],
    ["custom agentDir", (f: Awaited<ReturnType<typeof fixture>>) => f.agentDir, (f: Awaited<ReturnType<typeof fixture>>) => f.agentDir],
    ["external dbPath parent", (f: Awaited<ReturnType<typeof fixture>>) => path.dirname(f.dbPath), (f: Awaited<ReturnType<typeof fixture>>) => f.dbPath],
  ])("authenticates the manifest before target-side staging for an overlapping %s", async (_label, targetFor, sourceFor) => {
    const f = await fixture(false, { customAgentDir: true, externalDb: true });
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, agentDir: f.agentDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    const target = targetFor(f);
    const before = sourceRootFingerprint(sourceFor(f));
    let decryptCalls = 0;
    const base = fakeAge();
    const age = { ...base, decrypt(ciphertext: Buffer, _identity: string): Buffer { decryptCalls++; return base.decrypt(ciphertext); } };
    await expect(restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: target, ageIdentityFile: f.identity }, age })).rejects.toThrow(/overlaps an authenticated source root/);
    expect(decryptCalls).toBe(1);
    expect(sourceRootFingerprint(sourceFor(f))).toBe(before);
    expectNoStaging(path.dirname(target));
  });

  it("rejects an unsafe identity mode without creating target staging", async () => {
    const f = await fixture(false);
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    chmodSync(f.identity, 0o644);
    const target = path.join(f.root, "unsafe-identity-target");
    await expect(restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: target, ageIdentityFile: f.identity }, age: fakeAge() })).rejects.toThrow(/owner-only/);
    expectNoTargetStaging(target);
  });

  it.each([
    ["source root hash", (manifest: Record<string, any>) => { manifest.sourceRoots.dataDir = path.join(path.dirname(manifest.sourceRoots.dataDir), "changed-source"); }],
    ["source root binding", (manifest: Record<string, any>) => { manifest.sourceRootsHash = "0".repeat(64); }],
  ])("rejects %s tampering before payload staging", async (_label, change) => {
    const f = await fixture(false);
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    rewriteManifest(backup.finalPath!, change);
    const target = path.join(f.root, `tampered-${_label.replaceAll(" ", "-")}`);
    await expect(restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: target, ageIdentityFile: f.identity }, age: fakeAge() })).rejects.toThrow(/source roots/);
    expectNoTargetStaging(target);
  });

  it("rejects a ledger inconsistency without a final or staging directory", async () => {
    const f = await fixture(false);
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    rewriteManifest(backup.finalPath!, (manifest) => { manifest.migrationLedger.appliedCount++; });
    const target = path.join(f.root, "ledger-target");
    await expect(restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: target, ageIdentityFile: f.identity }, age: fakeAge() })).rejects.toThrow(/migration ledger/);
    expectNoTargetStaging(target);
  });

  it.each([
    ["SQLite corruption", (bytes: Buffer) => Buffer.from("not a SQLite database")],
    ["SQLite foreign-key violation", (bytes: Buffer) => {
      const file = path.join(mkdtempSync(path.join(tmpdir(), "pi-restore-db-fixture-")), "db");
      writeFileSync(file, bytes, { mode: 0o600 });
      const db = new DatabaseSync(file);
      db.exec("PRAGMA foreign_keys=OFF; DELETE FROM projects WHERE id = 'p';");
      db.close();
      const changed = readFileSync(file);
      rmSync(path.dirname(file), { recursive: true, force: true });
      return changed;
    }],
  ])("rejects %s without a final or staging directory", async (_label, change) => {
    const f = await fixture(false);
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    rewritePayload(backup.finalPath!, "payload/database.sqlite.age", change);
    const target = path.join(f.root, `database-${_label.replaceAll(" ", "-")}`);
    await expect(restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: target, ageIdentityFile: f.identity }, age: fakeAge() })).rejects.toThrow();
    expectNoTargetStaging(target);
  });

  it("reports an exact missing session reference, normalizes its reference to NULL, then rejects a mismatched mapping", async () => {
    const f = await fixture(false);
    const missing = path.join(f.dataDir, "sessions", "gone", "history.jsonl");
    const db = new DatabaseSync(f.dbPath);
    db.prepare("INSERT INTO sessions (id,owner_key,project_id,title,created_at,updated_at,pi_session_file,capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("missing-session", "owner", "p", "missing", 1, 1, missing, null);
    // pi_session_file is not unique: two metadata sessions may share the same
    // missing history, and both (sessionId,path) records must be restorable.
    db.prepare("INSERT INTO sessions (id,owner_key,project_id,title,created_at,updated_at,pi_session_file,capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("missing-shared", "owner", "p", "missing shared", 1, 1, missing, null);
    db.close();
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    const target = path.join(f.root, "missing-target");
    const restored = await restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: target, ageIdentityFile: f.identity }, age: fakeAge() });
    expect(restored.report.counts.missingSessionReferences).toBe(2);
    expect(restored.report.counts.invalidSessionHistories).toBe(0);
    const finalDb = new DatabaseSync(path.join(restored.finalPath!, "pi-agent-server.db"), { readOnly: true });
    const rows = finalDb.prepare("SELECT id, pi_session_file FROM sessions WHERE id IN ('missing-session', 'missing-shared') ORDER BY id").all() as Array<{ id: string; pi_session_file: string | null }>;
    finalDb.close();
    // missing-as-empty：共享缺失路径的两个引用均独立归一为 NULL。
    expect(rows).toEqual([{ id: "missing-session", pi_session_file: null }, { id: "missing-shared", pi_session_file: null }]);

    rewriteManifest(backup.finalPath!, (manifest) => { manifest.missingSessionReferences[0].sessionId = "wrong-session"; });
    const mismatchTarget = path.join(f.root, "missing-mismatch-target");
    await expect(restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: mismatchTarget, ageIdentityFile: f.identity }, age: fakeAge() })).rejects.toThrow(/matching manifest payload|exactly/);
    expectNoTargetStaging(mismatchTarget);
  });

  it.each([
    ["missing parent", '[{"type":"session","id":"h"},{"type":"message","id":"a","parentId":"missing"}]'],
    ["cycle", '[{"type":"session","id":"h"},{"type":"message","id":"a","parentId":"b"},{"type":"message","id":"b","parentId":"a"}]'],
    ["duplicate header", '[{"type":"session","id":"h"},{"type":"session","id":"h2"}]'],
  ])("degrades JSONL %s (invalid-as-empty): restores the session without history, nulls the reference and reports the count", async (_label, text) => {
    const f = await fixture(false);
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    rewritePayload(backup.finalPath!, "payload/sessions/s1/history.jsonl.age", () => Buffer.from(`${text}\n`, "utf8"));
    const target = path.join(f.root, `jsonl-${(_label as string).replaceAll(" ", "-")}`);
    const restored = await restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: target, ageIdentityFile: f.identity }, age: fakeAge() });
    expect(restored.finalPath).toBeTruthy();
    expect(restored.report.status).toBe("success");
    expect(restored.report.counts.invalidSessionHistories).toBe(1);
    expect(restored.report.counts.sessionHeaders).toBe(0);
    expect(restored.report.counts.missingSessionReferences).toBe(0);
    // 无效历史被丢弃：restored 输出里没有该 JSONL，DB 引用归一为 NULL。
    expect(existsSync(path.join(restored.finalPath!, "sessions/s1/history.jsonl"))).toBe(false);
    const finalDb = new DatabaseSync(path.join(restored.finalPath!, "pi-agent-server.db"), { readOnly: true });
    const row = finalDb.prepare("SELECT pi_session_file FROM sessions WHERE id = 'db-session'").get() as { pi_session_file: string | null };
    finalDb.close();
    expect(row.pi_session_file).toBeNull();
  });

  it("rejects a package without the canonical single-baseline migration ledger before payload staging", async () => {
    const f = await fixture(false);
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    // Legacy RC packages carry no ledger at all; they are not recoverable.
    rewriteManifest(backup.finalPath!, (manifest) => {
      manifest.migrationLedger = { present: false, appliedCount: 0, appliedVersion: null, checksums: [], rows: [], pending: 0 };
    });
    const target = path.join(f.root, "no-ledger-target");
    await expect(restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: target, ageIdentityFile: f.identity }, age: fakeAge() })).rejects.toThrow(/no authenticated migration ledger/);
    expectNoTargetStaging(target);
  });

  it("degrades an older Pi v1 history (invalid-as-empty): the header has no SDK v3 version and the history is discarded", async () => {
    const f = await fixture(false);
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    const v1 = '{"type":"session","id":"legacy-header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/source/project"}\n{"type":"message","message":{"role":"user","content":"legacy"}}\n';
    rewritePayload(backup.finalPath!, "payload/sessions/s1/history.jsonl.age", () => Buffer.from(v1, "utf8"));
    const restored = await restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "restore-v1-rejected"), ageIdentityFile: f.identity }, age: fakeAge() });
    expect(restored.report.counts.invalidSessionHistories).toBe(1);
    expect(restored.report.counts.sessionHeaders).toBe(0);
    expect(existsSync(path.join(restored.finalPath!, "sessions/s1/history.jsonl"))).toBe(false);
    const finalDb = new DatabaseSync(path.join(restored.finalPath!, "pi-agent-server.db"), { readOnly: true });
    const row = finalDb.prepare("SELECT pi_session_file FROM sessions WHERE id = 'db-session'").get() as { pi_session_file: string | null };
    finalDb.close();
    expect(row.pi_session_file).toBeNull();
  });

  it("restores companion sessions when one history is invalid: the package succeeds and only the invalid history is discarded", async () => {
    const f = await fixture(false);
    // 第二个完整会话：文件 + 行均有效，必须照常恢复。
    const companionFile = path.join(f.dataDir, "sessions", "s2", "companion.jsonl");
    mkdirSync(path.dirname(companionFile), { recursive: true, mode: 0o700 });
    writeFileSync(companionFile, '{"type":"session","version":3,"id":"companion-header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/source/project"}\n', { mode: 0o600 });
    const db = new DatabaseSync(f.dbPath);
    db.prepare("INSERT INTO sessions (id,owner_key,project_id,title,created_at,updated_at,pi_session_file,capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("companion", "owner", "p", "companion", 1, 1, companionFile, null);
    db.close();
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    // 把 db-session 的历史改成无效内容（包级 hash 同步更新，保持字节完整性）。
    rewritePayload(backup.finalPath!, "payload/sessions/s1/history.jsonl.age", () => Buffer.from('{"type":"session","id":"h"},{"not":"jsonl"}\n', "utf8"));
    const restored = await restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "restore-companion"), ageIdentityFile: f.identity }, age: fakeAge() });
    expect(restored.report.status).toBe("success");
    expect(restored.report.counts.invalidSessionHistories).toBe(1);
    expect(restored.report.counts.sessionHeaders).toBe(1);
    expect(restored.report.counts.jsonlFiles).toBe(2);
    const finalDb = new DatabaseSync(path.join(restored.finalPath!, "pi-agent-server.db"), { readOnly: true });
    const rows = finalDb.prepare("SELECT id, pi_session_file FROM sessions ORDER BY id").all() as Array<{ id: string; pi_session_file: string | null }>;
    finalDb.close();
    const byId = new Map(rows.map((row) => [row.id, row.pi_session_file]));
    expect(byId.get("db-session")).toBeNull();
    expect(byId.get("companion")?.endsWith("sessions/s2/companion.jsonl")).toBe(true);
    expect(readFileSync(path.join(restored.finalPath!, "sessions/s2/companion.jsonl")).toString()).toContain("companion-header");
    expect(existsSync(path.join(restored.finalPath!, "sessions/s1/history.jsonl"))).toBe(false);
  });
});
