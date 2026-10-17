import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, statSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteBackup } from "../../src/backup/backup-core.js";
import { restoreSqliteBackup } from "../../src/backup/restore-core.js";
import { snapshotNativeSources, validateNativeManifest, validateNativeSet, planNativeRestore, publishNativeRestore, NATIVE_RESTORE_RECORD, NATIVE_RESTORE_DEFAULT_DIR } from "../../src/backup/native-payload.js";
import { nativeProjectDirectory, readNativeSource } from "../../src/agent/native-session-source.js";
import { canonicalCwdIdentity } from "../../src/core/native-session-policy.js";
import { createCanonicalSqliteHead, createCanonicalSqlitePrefix, insertCanonicalSession } from "./sqlite-fixture.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const age = {
  encrypt(input: Buffer) { return Buffer.from(`FAKE\n${input.toString("base64")}`); },
  decrypt(input: Buffer) { return Buffer.from(input.toString().split("\n")[1]!, "base64"); },
};
function fixture(version = 2, separateSourceRoot = false) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "native-backup-")); roots.push(root);
  const dataDir = path.join(root, "data"); mkdirSync(dataDir, { mode: 0o700 });
  const dbPath = path.join(dataDir, "db.sqlite");
  const db = new DatabaseSync(dbPath);
  if (version === 2) createCanonicalSqliteHead(db); else createCanonicalSqlitePrefix(db, version);
  db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)").run("p", "project", root, "owner", 1);
  const nativeSourceRoot = separateSourceRoot ? path.join(root, "native-source") : path.join(dataDir, "sessions");
  const relative = `${nativeProjectDirectory(root)}/original.jsonl`;
  const source = path.join(nativeSourceRoot, relative);
  const bytes = Buffer.from(JSON.stringify({ type: "session", version: 3, id: "original", cwd: root, timestamp: "2026-01-01T00:00:00Z" }) + '\n' + JSON.stringify({ type: "session_name", id: "entry", parentId: null, name: "Exact native bytes" }) + '\n');
  mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 }); writeFileSync(source, bytes, { mode: 0o600 });
  const binding = readNativeSource(nativeSourceRoot, source, canonicalCwdIdentity(root)).binding;
  if (version === 2) {
    db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, visibility, origin, conversation_format, conversation_ref) VALUES ('native', '', 'p', '', 1, 1, 'shared', 'native', 'pi-native-jsonl-v3', ?)").run(source);
    db.prepare("INSERT INTO native_session_sources VALUES (?, ?, ?, ?, ?, ?)").run(source, "original", "native", "p", JSON.stringify(binding), 0);
    db.prepare("INSERT INTO native_session_sources VALUES (?, ?, ?, ?, ?, ?)").run(source + ".deleted", "gone-original", "gone", "p", JSON.stringify({ ...binding, sourcePath: source + ".deleted", sourceId: "gone-original" }), 1);
  }
  const managed = path.join(dataDir, "sessions", "managed", "history.jsonl");
  mkdirSync(path.dirname(managed), { recursive: true, mode: 0o700 });
  writeFileSync(managed, '{"type":"session","id":"managed-header","version":3,"cwd":"/fixture"}\n', { mode: 0o600 });
  insertCanonicalSession(db, "managed", managed); db.close();
  const recipient = path.join(root, "recipient"); writeFileSync(recipient, "age1fixture\n", { mode: 0o600 });
  const identity = path.join(root, "identity"); writeFileSync(identity, "fixture", { mode: 0o600 });
  const restoreRoot = path.join(root, "native-restored");
  return { root, dataDir, dbPath, source, bytes, relative, identity, restoreRoot,
    restorePaths: { targetRoot: path.join(root, "restore"), ageIdentityFile: identity, nativeSourceRoot: restoreRoot },
    paths: { dataDir, dbPath, nativeSourceRoot, backupRoot: path.join(root, "backups"), ageRecipientFile: recipient, authPath: path.join(root, "credential-not-read") } };
}
function forgeManifest(input: string, mutate: (manifest: any) => void) {
  const file = path.join(input, "manifest.json.age");
  const manifest = JSON.parse(age.decrypt(readFileSync(file)).toString()); mutate(manifest);
  const bytes = age.encrypt(Buffer.from(JSON.stringify(manifest))); writeFileSync(file, bytes, { mode: 0o600 });
  writeFileSync(path.join(input, "COMPLETE"), createHash("sha256").update(bytes).digest("hex") + "\n", { mode: 0o600 });
}
describe("native byte recovery bundles", () => {
  it("archives native, new private native-layout, legacy managed and NULL history in one bundle without promoting private claims", async () => {
    const f = fixture(2, true);
    const privateFile = path.join(path.dirname(f.source), "web-private.jsonl");
    const privateBytes = Buffer.from(JSON.stringify({ type: "session", version: 3, id: "private-header", cwd: f.root }) + "\n");
    writeFileSync(privateFile, privateBytes, { mode: 0o600 });
    const binding = { ...readNativeSource(f.paths.nativeSourceRoot, privateFile, canonicalCwdIdentity(f.root)).binding, private: true };
    const db = new DatabaseSync(f.dbPath);
    insertCanonicalSession(db, "web-private", privateFile);
    insertCanonicalSession(db, "empty", path.join(f.dataDir, "sessions", "empty", "not-created.jsonl"));
    db.prepare("UPDATE sessions SET conversation_ref=NULL WHERE id='empty'").run();
    db.prepare("INSERT INTO native_session_sources VALUES (?, ?, ?, ?, ?, 0)").run(privateFile, binding.sourceId, "web-private", String(db.prepare("SELECT project_id FROM sessions WHERE id='web-private'").get()!.project_id), JSON.stringify(binding));
    db.close();
    const backup = await createSqliteBackup({ paths: f.paths, age });
    const privateEntry = backup.manifest!.nativeSessionSources!.find(entry => entry.session_id === "web-private")!;
    expect(age.decrypt(readFileSync(path.join(backup.finalPath!, privateEntry.payloadPath!)))).toEqual(privateBytes);
    expect(backup.files.filter(file => file.kind === "jsonl")).toHaveLength(3);
    rmSync(privateFile); rmSync(f.source);
    const restored = await restoreSqliteBackup({ paths: { ...f.restorePaths, inputBackup: backup.finalPath! }, age });
    expect(readFileSync(path.join(f.restoreRoot, privateEntry.relativeSourcePath!))).toEqual(privateBytes);
    const resultDb = new DatabaseSync(path.join(restored.finalPath!, "pi-agent-server.db"), { readOnly: true });
    try {
      expect(resultDb.prepare("SELECT visibility, origin, conversation_format FROM sessions WHERE id='web-private'").get()).toEqual({ visibility: "private", origin: "managed", conversation_format: "pi-jsonl-v3" });
      const row = resultDb.prepare("SELECT binding FROM native_session_sources WHERE session_id='web-private'").get()!;
      expect(JSON.parse(String(row.binding)).private).toBe(true);
      expect(resultDb.prepare("SELECT conversation_ref FROM sessions WHERE id='empty'").get()).toEqual({ conversation_ref: null });
      expect(resultDb.prepare("SELECT conversation_ref FROM sessions WHERE id='managed'").get()!.conversation_ref).toBe(path.join(restored.finalPath!, "sessions", "managed", "history.jsonl"));
    } finally { resultDb.close(); }
  });
  it("archives exact native bytes with managed history and tombstones; restores encoded cwd and fresh inode binding", async () => {
    const f = fixture();
    const backup = await createSqliteBackup({ paths: f.paths, age, backupKind: "pre-migration" });
    expect(backup.manifest!.nativeSessionSources?.map(row => row.status).sort()).toEqual(["archived", "tombstone"]);
    const native = backup.manifest!.nativeSessionSources!.find(row => !row.deleted)!;
    expect(age.decrypt(readFileSync(path.join(backup.finalPath!, native.payloadPath!)))).toEqual(f.bytes);
    expect(backup.files.filter(row => row.kind === "jsonl")).toHaveLength(2);
    rmSync(f.source); // Disaster recovery cannot depend on the external original.
    const restored = await restoreSqliteBackup({ paths: { ...f.restorePaths, inputBackup: backup.finalPath! }, age });
    const target = path.join(f.restoreRoot, f.relative);
    expect(readFileSync(target)).toEqual(f.bytes);
    expect(statSync(target).nlink).toBe(1);
    const db = new DatabaseSync(path.join(restored.finalPath!, "pi-agent-server.db"), { readOnly: true });
    try {
      expect(db.prepare("SELECT deleted FROM native_session_sources WHERE session_id='gone'").get()).toEqual({ deleted: 1 });
      const row = db.prepare("SELECT binding FROM native_session_sources WHERE session_id='native'").get()!;
      expect(JSON.parse(String(row.binding))).toMatchObject({ sourcePath: target, sourceDev: statSync(target).dev, sourceIno: statSync(target).ino });
      expect(db.prepare("SELECT conversation_ref FROM sessions WHERE id='native'").get()).toEqual({ conversation_ref: target });
      expect(String(db.prepare("SELECT binding FROM native_session_sources WHERE session_id='gone'").get()!.binding)).toContain('"sourceIno":-1');
    } finally { db.close(); }
  });
  it("round-trips canonical cwd aliases to the original project without rewriting header bytes", async () => {
    const f = fixture();
    const bytes = Buffer.from(f.bytes.toString().replace(`\"cwd\":\"${f.root}\"`, `\"cwd\":\"${f.root}/.\"`));
    writeFileSync(f.source, bytes);
    const backup = await createSqliteBackup({ paths: f.paths, age });
    rmSync(f.source);
    const restored = await restoreSqliteBackup({ paths: { ...f.restorePaths, inputBackup: backup.finalPath! }, age });
    expect(readFileSync(path.join(f.restoreRoot, f.relative))).toEqual(bytes);
    expect(existsSync(path.join(restored.finalPath!, NATIVE_RESTORE_RECORD))).toBe(false);
  });
  it("restores native sessions inside the target root when no native root is configured", async () => {
    const f = fixture(); const backup = await createSqliteBackup({ paths: f.paths, age });
    const { nativeSourceRoot: _unset, ...paths } = f.restorePaths;
    await restoreSqliteBackup({ paths: { ...paths, inputBackup: backup.finalPath! }, age });
    expect(readFileSync(path.join(realpathSync(f.restorePaths.targetRoot), NATIVE_RESTORE_DEFAULT_DIR, f.relative))).toEqual(f.bytes);
    expect(existsSync(path.join(f.restoreRoot, f.relative))).toBe(false);
  });
  it("rolls back ordinary publication failures without changing the original source", async () => {
    const f = fixture(); const backup = await createSqliteBackup({ paths: f.paths, age });
    await expect(restoreSqliteBackup({ paths: { ...f.restorePaths, inputBackup: backup.finalPath! }, age,
      nativeRestoreCheckpoint(phase) { if (phase === "linked") throw new Error("injected publication failure"); },
    })).rejects.toThrow(/injected/);
    expect(readFileSync(f.source)).toEqual(f.bytes);
    expect(existsSync(path.join(f.restoreRoot, f.relative))).toBe(false);
    expect(readdirSync(f.root).filter(name => name.includes("restore-staging"))).toEqual([]);
    expect(!existsSync(f.restorePaths.targetRoot) || readdirSync(f.restorePaths.targetRoot).length === 0).toBe(true);
  });
  it.each(["prepared", "linked", "renamed", "finalizing", "finalized"])("SIGKILL at %s keeps pre-publication bytes undiscoverable and requires explicit cleanup, not automatic adoption", async (phase) => {
    const f = fixture(); const backup = await createSqliteBackup({ paths: f.paths, age });
    const paths = { ...f.restorePaths, inputBackup: backup.finalPath! };
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./native-restore-crash-child.ts", import.meta.url)), JSON.stringify(paths), phase],
      { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    expect(ended, stderr).toEqual({ code: null, signal: "SIGKILL" });
    const target = path.join(f.restoreRoot, f.relative);
    const finals = readdirSync(paths.targetRoot).filter(name => name.startsWith("restore-"));
    const dbPublished = ["renamed", "finalizing", "finalized"].includes(phase);
    expect(finals.length).toBe(dbPublished ? 1 : 0);
    if (phase === "prepared") expect(existsSync(target)).toBe(false);
    else {
      expect(statSync(target).nlink).toBe(["linked", "renamed"].includes(phase) ? 2 : 1);
      if (["linked", "renamed"].includes(phase)) expect(() => readNativeSource(f.restoreRoot, target, canonicalCwdIdentity(f.root))).toThrow();
      if (dbPublished) {
        const db = new DatabaseSync(path.join(paths.targetRoot, finals[0]!, "pi-agent-server.db"), { readOnly: true });
        try { const b = JSON.parse(String(db.prepare("SELECT binding FROM native_session_sources WHERE session_id='native'").get()!.binding));
          expect(b.sourceIno).toBe(statSync(target).ino); expect(b.sourceDev).toBe(statSync(target).dev);
        } finally { db.close(); }
      }
      // Retrying must not silently adopt or overwrite a killed restore's inode.
      await expect(restoreSqliteBackup({ paths, age })).rejects.toThrow(/already exists/);
      expect(readFileSync(target)).toEqual(f.bytes);
    }
    expect(readFileSync(f.source)).toEqual(f.bytes);
    const staging = readdirSync(f.root).filter(name => name.startsWith(".pi-agent-restore-staging-"));
    const assembled = dbPublished ? path.join(paths.targetRoot, finals[0]!) : path.join(f.root, staging[0]!, "assembled");
    if (phase !== "finalized") {
      const record = JSON.parse(readFileSync(path.join(assembled, NATIVE_RESTORE_RECORD), "utf8"));
      expect(record.claims[0]).toMatchObject({ target, sourceId: "original", sessionId: "native" });
      if (existsSync(target)) {
        const st = statSync(target);
        expect(st.dev).toBe(record.claims[0].dev); expect(st.ino).toBe(record.claims[0].ino);
      }
    }
    // Test-only operator cleanup: exactly this temp fixture's confirmed output,
    // target FIRST, then its own assembled/staging links; never the source.
    if (existsSync(target)) rmSync(target);
    for (const name of finals) rmSync(path.join(paths.targetRoot, name), { recursive: true });
    for (const name of staging) rmSync(path.join(f.root, name), { recursive: true });
    const restored = await restoreSqliteBackup({ paths, age });
    expect(statSync(target).nlink).toBe(1);
    expect(readFileSync(f.source)).toEqual(f.bytes);
    expect(existsSync(path.join(restored.finalPath!, NATIVE_RESTORE_RECORD))).toBe(false);
  }, 20_000);
  it("fails missing or forged registered native sources, including dry-run", async () => {
    const f = fixture(); rmSync(f.source);
    for (const dryRun of [true, false]) await expect(createSqliteBackup({ paths: f.paths, age, dryRun })).rejects.toThrow(/native|ENOENT/);
    expect(!existsSync(f.paths.backupRoot) || readdirSync(f.paths.backupRoot).length === 0).toBe(true);
  });
  it("rejects omitted claims, forged archive absolute/traversal mappings and external-required legacy packages", async () => {
    for (const mutate of [
      (m: any) => { delete m.nativeSessionSources; },
      (m: any) => { m.nativeSessionSources[0].source_path = "/forged/outside.jsonl"; },
      (m: any) => { m.nativeSessionSources[0].targetPath = "/forged/write.jsonl"; },
      (m: any) => { m.nativeSessionSources[0].relativeSourcePath = "../escape.jsonl"; },
      (m: any) => { m.nativeSessionSources[0].status = "external-required"; delete m.nativeSessionSources[0].relativeSourcePath; delete m.nativeSessionSources[0].payloadPath; },
    ]) {
      const f = fixture(); const backup = await createSqliteBackup({ paths: f.paths, age });
      forgeManifest(backup.finalPath!, mutate);
      await expect(restoreSqliteBackup({ paths: { ...f.restorePaths, inputBackup: backup.finalPath! }, age })).rejects.toThrow(/native/);
      expect(readFileSync(f.source)).toEqual(f.bytes); expect(existsSync(f.restoreRoot)).toBe(false);
    }
  });
  it("rejects preexisting target and symlink escape without altering original or conflicting bytes", async () => {
    for (const symlink of [false, true]) {
      const f = fixture(); const backup = await createSqliteBackup({ paths: f.paths, age });
      const outside = path.join(f.root, "outside"); mkdirSync(outside);
      if (symlink) symlinkSync(outside, f.restoreRoot);
      else { mkdirSync(path.join(f.restoreRoot, path.dirname(f.relative)), { recursive: true }); writeFileSync(path.join(f.restoreRoot, f.relative), "KEEP"); }
      await expect(restoreSqliteBackup({ paths: { ...f.restorePaths, inputBackup: backup.finalPath! }, age })).rejects.toThrow(/native/);
      expect(readFileSync(f.source)).toEqual(f.bytes);
      if (!symlink) expect(readFileSync(path.join(f.restoreRoot, f.relative), "utf8")).toBe("KEEP");
      expect(readdirSync(outside)).toEqual([]);
      expect(readdirSync(f.root).filter(name => name.includes("restore-staging"))).toEqual([]);
    }
  });
  it("cleans partial native publication on a later file conflict, preserving conflicting target", async () => {
    const f = fixture(); const backup = await createSqliteBackup({ paths: f.paths, age });
    const assembled = path.join(f.root, "assembled"); mkdirSync(path.join(assembled, "native", path.dirname(f.relative)), { recursive: true });
    writeFileSync(path.join(assembled, "native", f.relative), f.bytes);
    const claims = planNativeRestore(backup.manifest!.nativeSessionSources, assembled, f.restorePaths);
    const second = { ...claims[0]!, target: path.join(f.restoreRoot, "second", "conflict.jsonl") };
    mkdirSync(path.dirname(second.target), { recursive: true }); writeFileSync(second.target, "KEEP");
    expect(() => publishNativeRestore([...claims, second])).toThrow();
    expect(existsSync(claims[0]!.target)).toBe(false); expect(readFileSync(second.target, "utf8")).toBe("KEEP");
  });
  it("retains managed-only canonical historical v1 pre-migration package compatibility", async () => {
    const f = fixture(1);
    const backup = await createSqliteBackup({ paths: f.paths, backupKind: "pre-migration", age });
    expect(backup.manifest!.migrationLedger.appliedVersion).toBe(1);
    expect(backup.manifest!.nativeSessionSources).toBeUndefined();
    const restored = await restoreSqliteBackup({ paths: { ...f.restorePaths, inputBackup: backup.finalPath! }, age });
    expect(restored.report.migration.version).toBe(1);
  });
  it("checks claims and tombstones without dereferencing metadata paths", () => {
    const binding = JSON.stringify({ cwd: "/fixture", dev: 1, ino: 2, sourcePath: "/fixture/original.jsonl", sourceId: "original", sourceDev: 3, sourceIno: 4 });
    const rows = [{ source_path: "/fixture/original.jsonl", source_id: "original", session_id: "s", project_id: "p", binding, deleted: 0 }];
    const entries = snapshotNativeSources(rows);
    expect(() => validateNativeSet(entries, rows, [])).toThrow(/no native session/);
    expect(() => validateNativeManifest([{ ...entries[0], status: "archived" }])).toThrow(/unsafe/);
  });
});
