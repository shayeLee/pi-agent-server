import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteBackup } from "../../src/backup/backup-core.js";
import { decryptAgeBinary, InvalidSessionHistoryError, parseJsonl, restoreSqliteBackup } from "../../src/backup/restore-core.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { migrationDefinitions, stableSerialize } from "../../src/storage/migration-manifest.js";
import { createCanonicalSqlitePrefix } from "./sqlite-fixture.js";

const canRunAge = process.env.PI_RUN_REAL_AGE_RESTORE === "1" &&
  spawnSync("age", ["--version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("age-keygen", ["-h"], { stdio: "ignore" }).status === 0;
const cleanups: string[] = [];
afterEach(() => { for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true }); });

async function fixture(realAge = true, options: { customAgentDir?: boolean; externalDb?: boolean; migrationVersion?: number } = {}): Promise<{ root: string; dataDir: string; agentDir: string; dbPath: string; backupRoot: string; recipient: string; identity: string }> {
  const root = mkdtempSync(path.join(tmpdir(), "pi-restore-test-"));
  cleanups.push(root);
  const dataDir = path.join(root, "source-data");
  const agentDir = options.customAgentDir ? path.join(root, "custom-agent") : path.join(dataDir, ".pi-agent");
  const backupRoot = path.join(root, "source-backups");
  mkdirSync(path.join(dataDir, "projects", "p", "sessions", "db-session"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, "projects"), { recursive: true, mode: 0o700 });
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const dbPath = options.externalDb ? path.join(root, "external-db", "pi-agent-server.db") : path.join(dataDir, "pi-agent-server.db");
  if (options.externalDb) mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  if (options.customAgentDir) writeFileSync(path.join(agentDir, "models.json"), '{"models":["custom"]}\n', { mode: 0o600 });
  const db = new DatabaseSync(dbPath);
  // Normal fixtures use the real head; a dedicated recovery test may request
  // an authenticated historical prefix such as the immutable v0 baseline.
  if (options.migrationVersion === undefined) await runSqliteMigrations(db, { mode: "apply" });
  else createCanonicalSqlitePrefix(db, options.migrationVersion);
  db.prepare("INSERT INTO projects (id,name,cwd,owner_key,created_at) VALUES (?,?,?,?,?)").run("p", "project", "/source/project", "owner", 1);
  const sessionFile = path.join(dataDir, "projects", "p", "sessions", "db-session", "history.jsonl");
  db.prepare("INSERT INTO sessions (id,owner_key,project_id,title,created_at,updated_at,conversation_ref,capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("db-session", "owner", "p", "session", 1, 1, sessionFile, JSON.stringify({ schema: 1 }));
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
    const sourceFile = path.join(f.dataDir, "projects", "p", "sessions", "db-session", "history.jsonl");
    const sourceBytes = readFileSync(sourceFile);
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    const result = await restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "restore-target"), ageIdentityFile: f.identity }, age: fakeAge() });
    expect(result.finalPath).toBeTruthy();
    expect(readFileSync(path.join(result.finalPath!, "projects/p/sessions/db-session/history.jsonl"))).toEqual(sourceBytes);
    expect(existsSync(path.join(result.finalPath!, ".manifest.json"))).toBe(false);
  });

  it("roundtrips exact unassociated and session-associated uploaded originals with target Pi paths", async () => {
    const f = await fixture(false);
    const uploadDir = path.join(f.root, "originals");
    mkdirSync(uploadDir, { mode: 0o700 });
    const uploadRoot = realpathSync(uploadDir);
    const firstKey = "00000000-0000-4000-8000-000000000011";
    const secondKey = "00000000-0000-4000-8000-000000000012";
    const projectId = "00000000-0000-4000-8000-000000000021";
    const sessionId = "00000000-0000-4000-8000-000000000031";
    const originals = [Buffer.from("unassociated original"), Buffer.from("session original")];
    const db = new DatabaseSync(f.dbPath);
    try {
      db.prepare("INSERT INTO projects (id,name,cwd,owner_key,created_at) VALUES (?,?,?,?,?)").run(projectId, "Uploads", "/source/work", "owner", 1);
      db.prepare("INSERT INTO sessions (id,owner_key,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(sessionId, "owner", projectId, "Associated", 1, 1);
      const insert = db.prepare("INSERT INTO uploaded_files (id,owner_key,project_id,upload_key,name,media_type,size,checksum,storage_key,agent_path,status,created_at,session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
      for (const [index, bytes] of originals.entries()) {
        const key = index === 0 ? firstKey : secondKey;
        writeFileSync(path.join(uploadRoot, key), bytes, { mode: 0o600 });
        insert.run(key, "owner", projectId, `upload-${index}`, `document-${index}.txt`, "text/plain", bytes.length,
          createHash("sha256").update(bytes).digest("hex"), key, `/source/agent/${key}`, index === 0 ? "uploading" : "ready", 1, index === 0 ? null : sessionId);
      }
    } finally { db.close(); }
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, uploadRoot, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    expect(backup.manifest?.format).toBe("pi-agent-server.backup-manifest.v2");
    expect(backup.manifest?.attachments).toHaveLength(2);
    const target = path.join(f.root, "target-uploaded");
    const agentBase = path.join(f.root, "mapped-agent");
    const restored = await restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: target,
      ageIdentityFile: f.identity, uploadAgentRoot: agentBase }, age: fakeAge() });
    const reader = new DatabaseSync(path.join(restored.finalPath!, "pi-agent-server.db"), { readOnly: true });
    try {
      const rows = reader.prepare("SELECT id,session_id,storage_key,agent_path,size,checksum,status FROM uploaded_files ORDER BY id").all() as Array<{
        id: string; session_id: string | null; storage_key: string; agent_path: string; size: number; checksum: string; status: string;
      }>;
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.session_id)).toEqual([null, sessionId]);
      expect(rows.map((row) => row.status)).toEqual(["uploading", "ready"]);
      for (const [index, row] of rows.entries()) {
        expect(readFileSync(path.join(restored.finalPath!, "uploads", row.storage_key))).toEqual(originals[index]);
        expect(row.agent_path).toBe(path.join(realpathSync(f.root), "mapped-agent", path.basename(restored.finalPath!), "uploads", row.storage_key));
        expect(row.agent_path).not.toContain("/source/agent/");
        expect(row.checksum).toBe(createHash("sha256").update(originals[index]!).digest("hex"));
      }
    } finally { reader.close(); }
  });

  it("preserves an existing target byte-for-byte when attachment decryption fails after DB staging", async () => {
    const f = await fixture(false);
    const directory = path.join(f.root, "originals");
    mkdirSync(directory, { mode: 0o700 });
    const uploadRoot = realpathSync(directory);
    const key = "00000000-0000-4000-8000-000000000081";
    const original = Buffer.from("FAIL_AT_ATTACHMENT_DECRYPT");
    writeFileSync(path.join(uploadRoot, key), original, { mode: 0o600 });
    const db = new DatabaseSync(f.dbPath);
    try {
      db.prepare("INSERT INTO uploaded_files (id,owner_key,project_id,upload_key,name,media_type,size,checksum,storage_key,agent_path,status,created_at,session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(key, "owner", "00000000-0000-4000-8000-000000000021", "test-key", "file.txt", "text/plain", original.length,
          createHash("sha256").update(original).digest("hex"), key, `/source/uploads/${key}`, "ready", 1, null);
    } finally { db.close(); }
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, uploadRoot,
      backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    const target = path.join(f.root, "existing-target");
    mkdirSync(target, { mode: 0o700 });
    const sentinel = Buffer.from([0, 255, 42, 10, 0, 99]);
    writeFileSync(path.join(target, "sentinel.bin"), sentinel, { mode: 0o600 });
    const age = { ...fakeAge(), decrypt(ciphertext: Buffer) {
      const plain = fakeAge().decrypt(ciphertext);
      if (plain.equals(original)) throw new Error("injected attachment decryption failure");
      return plain;
    } };
    await expect(restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: target,
      ageIdentityFile: f.identity, uploadAgentRoot: path.join(f.root, "agent-target") }, age }))
      .rejects.toThrow(/injected attachment decryption failure/);
    expect(readdirSync(target)).toEqual(["sentinel.bin"]);
    expect(readFileSync(path.join(target, "sentinel.bin"))).toEqual(sentinel);
    expect(readdirSync(f.root).filter((name) => name.startsWith(".pi-agent-restore-staging-") || name.startsWith("restore-"))).toEqual([]);
  });

  it("rejects symlinked or traversal attachment archive entries before publishing a target", async () => {
    const f = await fixture(false);
    const uploadDir = path.join(f.root, "originals");
    mkdirSync(uploadDir, { mode: 0o700 });
    const uploadRoot = realpathSync(uploadDir);
    const key = "00000000-0000-4000-8000-000000000061";
    const bytes = Buffer.from("private original");
    writeFileSync(path.join(uploadRoot, key), bytes, { mode: 0o600 });
    const db = new DatabaseSync(f.dbPath);
    try {
      db.prepare("INSERT INTO uploaded_files (id,owner_key,project_id,upload_key,name,media_type,size,checksum,storage_key,agent_path,status,created_at,session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(key, "owner", "00000000-0000-4000-8000-000000000021", "key", "file.txt", "text/plain", bytes.length,
          createHash("sha256").update(bytes).digest("hex"), key, `/agent/${key}`, "ready", 1, null);
    } finally { db.close(); }
    const paths = { dataDir: f.dataDir, dbPath: f.dbPath, uploadRoot, backupRoot: f.backupRoot, ageRecipientFile: f.recipient };
    const first = await createSqliteBackup({ paths, age: fakeAge() });
    const payload = path.join(first.finalPath!, "payload", "attachments", `${key}.age`);
    const outside = path.join(f.root, "outside.age");
    writeFileSync(outside, "not a payload");
    rmSync(payload);
    symlinkSync(outside, payload);
    const target = path.join(f.root, "symlink-target");
    await expect(restoreSqliteBackup({ paths: { inputBackup: first.finalPath!, targetRoot: target,
      ageIdentityFile: f.identity, uploadAgentRoot: path.join(f.root, "pi-target") }, age: fakeAge() })).rejects.toThrow(/symbolic link/);
    expectNoTargetStaging(target);

    const second = await createSqliteBackup({ paths, age: fakeAge() });
    rewriteManifest(second.finalPath!, (manifest) => {
      manifest.files.find((record: { kind: string }) => record.kind === "attachment").path = "payload/attachments/../escape.age";
    });
    const traversalTarget = path.join(f.root, "traversal-target");
    await expect(restoreSqliteBackup({ paths: { inputBackup: second.finalPath!, targetRoot: traversalTarget,
      ageIdentityFile: f.identity, uploadAgentRoot: path.join(f.root, "pi-target") }, age: fakeAge() })).rejects.toThrow(/path traversal/);
    expectNoTargetStaging(traversalTarget);

    const third = await createSqliteBackup({ paths, age: fakeAge() });
    rewriteManifest(third.finalPath!, (manifest) => {
      const attachment = manifest.files.find((record: { kind: string }) => record.kind === "attachment");
      manifest.files.push({ ...attachment }); // duplicate authenticated ciphertext path
    });
    const duplicateTarget = path.join(f.root, "duplicate-target");
    await expect(restoreSqliteBackup({ paths: { inputBackup: third.finalPath!, targetRoot: duplicateTarget,
      ageIdentityFile: f.identity, uploadAgentRoot: path.join(f.root, "pi-target") }, age: fakeAge() })).rejects.toThrow(/duplicate or non-payload path/);
    expectNoTargetStaging(duplicateTarget);
  });

  it("restores a durable unknown request reservation without discarding its de-duplication barrier", async () => {
    const f = await fixture(false);
    const reserved = "PI-IDEMPOTENCY-RESERVATION-V1:00000000-0000-4000-8000-000000000001";
    const db = new DatabaseSync(f.dbPath);
    try { db.prepare("UPDATE idempotency SET result = ?, fingerprint = ? WHERE request_id = 'request'").run(reserved, "a".repeat(64)); }
    finally { db.close(); }
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    const result = await restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "reservation-target"), ageIdentityFile: f.identity }, age: fakeAge() });
    const restored = new DatabaseSync(path.join(result.finalPath!, "pi-agent-server.db"), { readOnly: true });
    try {
      expect(restored.prepare("SELECT result, fingerprint FROM idempotency WHERE request_id = 'request'").get())
        .toEqual({ result: reserved, fingerprint: "a".repeat(64) });
    } finally { restored.close(); }
  });

  it("restores the canonical v1 migration head without auto-migrating and reports the physical outbox contract", async () => {
    const f = await fixture(false);
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    const result = await restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "restore-baseline"), ageIdentityFile: f.identity }, age: fakeAge() });
    expect(result.report.migration).toEqual({ version: migrationDefinitions.at(-1)!.version, pending: 0 });
    expect(result.report.counts.fileOperations).toBe(0);
    const restoredPath = path.join(result.finalPath!, "pi-agent-server.db");
    const restoredDb = new DatabaseSync(restoredPath);
    try {
      const tables = (restoredDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables.includes("file_operations")).toBe(true);
      expect(tables.includes("schema_migrations")).toBe(true);
      // Migration is an independent, explicit operation after restore; at the
      // current head this is a no-op that must keep the outbox table empty.
      await runSqliteMigrations(restoredDb, { mode: "apply" });
      expect(restoredDb.prepare("SELECT count(*) AS n FROM file_operations").get()).toEqual({ n: 0 });
    } finally {
      restoredDb.close();
    }
  });

  it("restores an authenticated immutable v0 prefix without auto-migrating it", async () => {
    const f = await fixture(false, { migrationVersion: 0 });
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    const result = await restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "restore-v0"), ageIdentityFile: f.identity }, age: fakeAge() });
    expect(result.report.migration).toEqual({ version: 0, pending: 0 });
    const restoredDb = new DatabaseSync(path.join(result.finalPath!, "pi-agent-server.db"), { readOnly: true });
    try {
      expect(restoredDb.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 0, name: "initial-schema" }]);
      expect(restoredDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'uploaded_files'").all()).toEqual([]);
    } finally { restoredDb.close(); }
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
    const row = restoredDb.prepare("SELECT conversation_ref FROM sessions").get() as { conversation_ref: string };
    expect(row.conversation_ref).toContain(`${path.basename(result.finalPath!)}/projects/p/sessions/db-session/history.jsonl`);
    expect(row.conversation_ref).not.toContain(f.dataDir);
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
    ["altered v1 head checksum", (manifest: Record<string, any>) => {
      manifest.migrationLedger.rows[1].checksum = "0".repeat(64);
      manifest.migrationLedger.checksums[1] = "0".repeat(64);
    }],
    ["unknown future migration", (manifest: Record<string, any>) => {
      const version = manifest.migrationLedger.appliedVersion + 1;
      manifest.migrationLedger.rows.push({ version, name: "unknown-future", checksum: "b".repeat(64), applied_at: 2 });
      manifest.migrationLedger.checksums.push("b".repeat(64));
      manifest.migrationLedger.appliedCount = manifest.migrationLedger.rows.length;
      manifest.migrationLedger.appliedVersion = version;
    }],
    ["truncated migration prefix", (manifest: Record<string, any>) => {
      manifest.migrationLedger.rows.splice(1);
      manifest.migrationLedger.checksums.splice(1);
      manifest.migrationLedger.appliedCount = 1;
      manifest.migrationLedger.appliedVersion = 0;
    }],
  ])("rejects %s before payload staging", async (_label, change) => {
    const f = await fixture(false);
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    rewriteManifest(backup.finalPath!, change);
    const target = path.join(f.root, `history-${String(_label).replaceAll(" ", "-")}`);
    await expect(restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: target, ageIdentityFile: f.identity }, age: fakeAge() })).rejects.toThrow(/backup history\/checksum|unknown migration version|Manifest 物理契约/);
    expectNoTargetStaging(target);
  });

  it("rejects legacy packages with forged uploaded_files metadata and no attachment payload", async () => {
    const f = await fixture(false);
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    rewritePayload(backup.finalPath!, "payload/database.sqlite.age", (bytes) => {
      const testDbPath = path.join(f.root, "upload-metadata.db");
      writeFileSync(testDbPath, bytes, { mode: 0o600 });
      const db = new DatabaseSync(testDbPath);
      db.prepare("INSERT INTO uploaded_files (id, owner_key, project_id, upload_key, name, media_type, size, checksum, storage_key, agent_path, status, created_at, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("00000000-0000-4000-8000-000000000051", "owner", "00000000-0000-4000-8000-000000000021", "upload-key", "document.pdf", "application/pdf", 1, "a".repeat(64), "00000000-0000-4000-8000-000000000052", "/agent/00000000-0000-4000-8000-000000000052", "ready", 1, null);
      db.close();
      const changed = readFileSync(testDbPath);
      rmSync(testDbPath, { force: true });
      return changed;
    });
    const target = path.join(f.root, "upload-metadata-target");
    await expect(restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: target, ageIdentityFile: f.identity }, age: fakeAge() })).rejects.toThrow(/legacy package has unbundled attachment metadata/);
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
    const missing = path.join(f.dataDir, "projects", "p", "sessions", "missing-session", "missing.jsonl");
    const sharedMissing = path.join(f.dataDir, "projects", "p", "sessions", "missing-shared", "missing.jsonl");
    const db = new DatabaseSync(f.dbPath);
    db.prepare("INSERT INTO sessions (id,owner_key,project_id,title,created_at,updated_at,conversation_ref,capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("missing-session", "owner", "p", "missing", 1, 1, missing, null);
    // Pi 路径必须绑定各自的 session/project；每个缺失引用独立归一。
    db.prepare("INSERT INTO sessions (id,owner_key,project_id,title,created_at,updated_at,conversation_ref,capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("missing-shared", "owner", "p", "missing shared", 1, 1, sharedMissing, null);
    db.close();
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    const target = path.join(f.root, "missing-target");
    const restored = await restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: target, ageIdentityFile: f.identity }, age: fakeAge() });
    expect(restored.report.counts.missingSessionReferences).toBe(2);
    expect(restored.report.counts.invalidSessionHistories).toBe(0);
    const finalDb = new DatabaseSync(path.join(restored.finalPath!, "pi-agent-server.db"), { readOnly: true });
    const rows = finalDb.prepare("SELECT id, conversation_ref FROM sessions WHERE id IN ('missing-session', 'missing-shared') ORDER BY id").all() as Array<{ id: string; conversation_ref: string | null }>;
    finalDb.close();
    // missing-as-empty：两个规范缺失引用均独立归一为 NULL。
    expect(rows).toEqual([{ id: "missing-session", conversation_ref: null }, { id: "missing-shared", conversation_ref: null }]);

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
    rewritePayload(backup.finalPath!, "payload/projects/p/sessions/db-session/history.jsonl.age", () => Buffer.from(`${text}\n`, "utf8"));
    const target = path.join(f.root, `jsonl-${(_label as string).replaceAll(" ", "-")}`);
    const restored = await restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: target, ageIdentityFile: f.identity }, age: fakeAge() });
    expect(restored.finalPath).toBeTruthy();
    expect(restored.report.status).toBe("success");
    expect(restored.report.counts.invalidSessionHistories).toBe(1);
    expect(restored.report.counts.sessionHeaders).toBe(0);
    expect(restored.report.counts.missingSessionReferences).toBe(0);
    // 无效历史被丢弃：restored 输出里没有该 JSONL，DB 引用归一为 NULL。
    expect(existsSync(path.join(restored.finalPath!, "projects/p/sessions/db-session/history.jsonl"))).toBe(false);
    const finalDb = new DatabaseSync(path.join(restored.finalPath!, "pi-agent-server.db"), { readOnly: true });
    const row = finalDb.prepare("SELECT conversation_ref FROM sessions WHERE id = 'db-session'").get() as { conversation_ref: string | null };
    finalDb.close();
    expect(row.conversation_ref).toBeNull();
  });

  it("rejects a package without the authenticated current-head migration ledger before payload staging", async () => {
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
    rewritePayload(backup.finalPath!, "payload/projects/p/sessions/db-session/history.jsonl.age", () => Buffer.from(v1, "utf8"));
    const restored = await restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "restore-v1-rejected"), ageIdentityFile: f.identity }, age: fakeAge() });
    expect(restored.report.counts.invalidSessionHistories).toBe(1);
    expect(restored.report.counts.sessionHeaders).toBe(0);
    expect(existsSync(path.join(restored.finalPath!, "projects/p/sessions/db-session/history.jsonl"))).toBe(false);
    const finalDb = new DatabaseSync(path.join(restored.finalPath!, "pi-agent-server.db"), { readOnly: true });
    const row = finalDb.prepare("SELECT conversation_ref FROM sessions WHERE id = 'db-session'").get() as { conversation_ref: string | null };
    finalDb.close();
    expect(row.conversation_ref).toBeNull();
  });

  it("restores companion sessions when one history is invalid: the package succeeds and only the invalid history is discarded", async () => {
    const f = await fixture(false);
    // 第二个完整会话：文件 + 行均有效，必须照常恢复。
    const companionFile = path.join(f.dataDir, "projects", "p", "sessions", "companion", "companion.jsonl");
    mkdirSync(path.dirname(companionFile), { recursive: true, mode: 0o700 });
    writeFileSync(companionFile, '{"type":"session","version":3,"id":"companion-header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/source/project"}\n', { mode: 0o600 });
    const db = new DatabaseSync(f.dbPath);
    db.prepare("INSERT INTO sessions (id,owner_key,project_id,title,created_at,updated_at,conversation_ref,capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("companion", "owner", "p", "companion", 1, 1, companionFile, null);
    db.close();
    const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
    // 把 db-session 的历史改成无效内容（包级 hash 同步更新，保持字节完整性）。
    rewritePayload(backup.finalPath!, "payload/projects/p/sessions/db-session/history.jsonl.age", () => Buffer.from('{"type":"session","id":"h"},{"not":"jsonl"}\n', "utf8"));
    const restored = await restoreSqliteBackup({ paths: { inputBackup: backup.finalPath!, targetRoot: path.join(f.root, "restore-companion"), ageIdentityFile: f.identity }, age: fakeAge() });
    expect(restored.report.status).toBe("success");
    expect(restored.report.counts.invalidSessionHistories).toBe(1);
    expect(restored.report.counts.sessionHeaders).toBe(1);
    expect(restored.report.counts.jsonlFiles).toBe(2);
    const finalDb = new DatabaseSync(path.join(restored.finalPath!, "pi-agent-server.db"), { readOnly: true });
    const rows = finalDb.prepare("SELECT id, conversation_ref FROM sessions ORDER BY id").all() as Array<{ id: string; conversation_ref: string | null }>;
    finalDb.close();
    const byId = new Map(rows.map((row) => [row.id, row.conversation_ref]));
    expect(byId.get("db-session")).toBeNull();
    expect(byId.get("companion")?.endsWith("projects/p/sessions/companion/companion.jsonl")).toBe(true);
    expect(readFileSync(path.join(restored.finalPath!, "projects/p/sessions/companion/companion.jsonl")).toString()).toContain("companion-header");
    expect(existsSync(path.join(restored.finalPath!, "projects/p/sessions/db-session/history.jsonl"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Authenticated source-root references (cross-host restore). Manifest source
// roots are metadata recorded on the backup host and may legitimately contain
// symlink components: a Linux `/home/onev/...` root is a system symlink alias
// when the package is restored on macOS (`/home` -> /System/Volumes/Data/home).
// They are compared lexically AND physically against the target in both
// directions, while input/target/identity keep the strict no-symlink-ancestor
// policy. Every negative case asserts the payload was not decrypted and no
// target-side staging was materialized.
// ---------------------------------------------------------------------------

function rewriteSourceRoots(packagePath: string, roots: { dataDir: string; agentDir: string; dbPath: string }): void {
  rewriteManifest(packagePath, (manifest) => {
    manifest.sourceRoots = roots;
    const hash = createHash("sha256").update(stableSerialize(roots), "utf8").digest("hex");
    manifest.sourceRootsSha256 = hash;
    manifest.sourceRootsHash = hash;
  });
}

function countingAge(): { state: { decryptCalls: number }; age: { encrypt: (input: Buffer) => Buffer; decrypt: (ciphertext: Buffer, identity: string) => Buffer } } {
  const base = fakeAge();
  const state = { decryptCalls: 0 };
  return {
    state,
    age: { encrypt: base.encrypt, decrypt(ciphertext: Buffer, _identity: string): Buffer { state.decryptCalls++; return base.decrypt(ciphertext); } },
  };
}

async function backupFor(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const backup = await createSqliteBackup({ paths: { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient }, age: fakeAge() });
  return backup.finalPath!;
}

describe("SQLite restore source-root references", () => {
  it("restores with an independent symlinked source root (cross-host source metadata)", async () => {
    const f = await fixture(false);
    const packagePath = await backupFor(f);
    const realSource = path.join(f.root, "real-source");
    mkdirSync(realSource, { recursive: true, mode: 0o700 });
    const linkedSource = path.join(f.root, "linked-source");
    symlinkSync(realSource, linkedSource);
    rewriteSourceRoots(packagePath, {
      dataDir: linkedSource,
      agentDir: path.join(linkedSource, ".pi-agent"),
      dbPath: path.join(linkedSource, "pi-agent-server.db"),
    });
    const target = path.join(f.root, "symlink-source-target");
    const restored = await restoreSqliteBackup({ paths: { inputBackup: packagePath, targetRoot: target, ageIdentityFile: f.identity }, age: fakeAge() });
    expect(restored.report.status).toBe("success");
    expect(restored.finalPath).toBeTruthy();
    expect(existsSync(path.join(restored.finalPath!, "pi-agent-server.db"))).toBe(true);
  });

  it.each([
    ["equal to", (_f: Awaited<ReturnType<typeof fixture>>, target: string) => target],
    ["a parent of", (_f: Awaited<ReturnType<typeof fixture>>, target: string) => path.dirname(target)],
    ["a child of", (_f: Awaited<ReturnType<typeof fixture>>, target: string) => path.join(target, "nested")],
  ])("rejects a source root %s the target without decrypting payloads or creating the target", async (_label, makeRoot) => {
    const f = await fixture(false);
    const packagePath = await backupFor(f);
    const target = path.join(f.root, `overlap-${(_label as string).replaceAll(" ", "-")}`);
    rewriteSourceRoots(packagePath, {
      dataDir: makeRoot(f, target),
      agentDir: path.join(f.root, "unrelated-agent"),
      dbPath: path.join(f.root, "unrelated-db"),
    });
    const { state, age } = countingAge();
    await expect(restoreSqliteBackup({ paths: { inputBackup: packagePath, targetRoot: target, ageIdentityFile: f.identity }, age })).rejects.toThrow(/overlaps an authenticated source root/);
    expect(state.decryptCalls).toBe(1);
    expectNoTargetStaging(target);
  });

  it("rejects a source root that is a symlink alias of the target", async () => {
    const f = await fixture(false);
    const packagePath = await backupFor(f);
    const target = path.join(f.root, "alias-target");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const alias = path.join(f.root, "alias-to-target");
    symlinkSync(target, alias);
    rewriteSourceRoots(packagePath, {
      dataDir: alias,
      agentDir: path.join(f.root, "unrelated-agent"),
      dbPath: path.join(f.root, "unrelated-db"),
    });
    const { state, age } = countingAge();
    await expect(restoreSqliteBackup({ paths: { inputBackup: packagePath, targetRoot: target, ageIdentityFile: f.identity }, age })).rejects.toThrow(/overlaps an authenticated source root/);
    expect(state.decryptCalls).toBe(1);
    expect(readdirSync(target)).toEqual([]);
  });

  it("rejects a dangling symlinked source root", async () => {
    const f = await fixture(false);
    const packagePath = await backupFor(f);
    const dangling = path.join(f.root, "dangling-source");
    symlinkSync(path.join(f.root, "does-not-exist"), dangling);
    rewriteSourceRoots(packagePath, {
      dataDir: dangling,
      agentDir: path.join(f.root, "unrelated-agent"),
      dbPath: path.join(f.root, "unrelated-db"),
    });
    const { state, age } = countingAge();
    const target = path.join(f.root, "dangling-target");
    await expect(restoreSqliteBackup({ paths: { inputBackup: packagePath, targetRoot: target, ageIdentityFile: f.identity }, age })).rejects.toThrow(/could not be resolved/);
    expect(state.decryptCalls).toBe(1);
    expectNoTargetStaging(target);
  });

  it("rejects a symlink loop in a source root", async () => {
    const f = await fixture(false);
    const packagePath = await backupFor(f);
    const loopA = path.join(f.root, "loop-a");
    const loopB = path.join(f.root, "loop-b");
    symlinkSync(loopB, loopA);
    symlinkSync(loopA, loopB);
    rewriteSourceRoots(packagePath, {
      dataDir: loopA,
      agentDir: path.join(f.root, "unrelated-agent"),
      dbPath: path.join(f.root, "unrelated-db"),
    });
    const { state, age } = countingAge();
    const target = path.join(f.root, "loop-target");
    await expect(restoreSqliteBackup({ paths: { inputBackup: packagePath, targetRoot: target, ageIdentityFile: f.identity }, age })).rejects.toThrow(/could not be resolved/);
    expect(state.decryptCalls).toBe(1);
    expectNoTargetStaging(target);
  });

  it("rejects a source root with a relative path component", async () => {
    const f = await fixture(false);
    const packagePath = await backupFor(f);
    rewriteSourceRoots(packagePath, {
      dataDir: `${f.root}/unrelated/../unrelated`,
      agentDir: path.join(f.root, "unrelated-agent"),
      dbPath: path.join(f.root, "unrelated-db"),
    });
    const target = path.join(f.root, "relative-target");
    await expect(restoreSqliteBackup({ paths: { inputBackup: packagePath, targetRoot: target, ageIdentityFile: f.identity }, age: fakeAge() })).rejects.toThrow(/relative path component/);
    expectNoTargetStaging(target);
  });

  it("keeps the strict no-symlink-ancestor policy for input, target and identity", async () => {
    const f = await fixture(false);
    const packagePath = await backupFor(f);

    const realTarget = path.join(f.root, "strict-target");
    mkdirSync(realTarget, { recursive: true, mode: 0o700 });
    const targetAlias = path.join(f.root, "strict-target-alias");
    symlinkSync(realTarget, targetAlias);
    await expect(restoreSqliteBackup({ paths: { inputBackup: packagePath, targetRoot: targetAlias, ageIdentityFile: f.identity }, age: fakeAge() })).rejects.toThrow(/symbolic-link ancestor/);

    const inputAlias = path.join(f.root, "strict-input-alias");
    symlinkSync(packagePath, inputAlias);
    await expect(restoreSqliteBackup({ paths: { inputBackup: inputAlias, targetRoot: path.join(f.root, "strict-target-input"), ageIdentityFile: f.identity }, age: fakeAge() })).rejects.toThrow(/symbolic-link ancestor/);

    const identityAlias = path.join(f.root, "identity-alias");
    symlinkSync(f.identity, identityAlias);
    await expect(restoreSqliteBackup({ paths: { inputBackup: packagePath, targetRoot: path.join(f.root, "strict-target-identity"), ageIdentityFile: identityAlias }, age: fakeAge() })).rejects.toThrow(/symbolic-link ancestor/);

    expectNoTargetStaging(path.join(f.root, "strict-target-input"));
    expectNoTargetStaging(path.join(f.root, "strict-target-identity"));
    expect(readdirSync(realTarget)).toEqual([]);
  });
});
