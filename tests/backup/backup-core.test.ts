import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindReferencesToPayload, createSqliteBackup, type AgeAdapter } from "../../src/backup/backup-core.js";
import { createCanonicalSqliteBaseline, insertCanonicalSession } from "./sqlite-fixture.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";

const cleanups: string[] = [];
afterEach(() => { for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(): { root: string; dataDir: string; dbPath: string; backupRoot: string; recipient: string } {
  const root = mkdtempSync(path.join(tmpdir(), "pi-backup-test-"));
  cleanups.push(root);
  const dataDir = path.join(root, "data");
  const backupRoot = path.join(root, "backups");
  mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, "projects", "p1", "sessions", "s1"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, ".pi-agent"), { recursive: true, mode: 0o700 });
  const dbPath = path.join(dataDir, "pi-agent-server.db");
  const db = new DatabaseSync(dbPath);
  createCanonicalSqliteBaseline(db);
  db.close();
  const recipient = path.join(root, "recipient.txt");
  writeFileSync(recipient, "# test\nage1testrecipient\n", { mode: 0o600 });
  return { root, dataDir, dbPath, backupRoot, recipient };
}

function fakeAge(): AgeAdapter & { decrypt(bytes: Buffer): Buffer } {
  return {
    encrypt(input) { return Buffer.from(`FAKE-AGE\n${input.toString("base64")}`, "utf8"); },
    decrypt(bytes) { return Buffer.from(bytes.toString("utf8").split("\n")[1]!, "base64"); },
  };
}

function putSession(dbPath: string, id: string, file: string): void {
  const db = new DatabaseSync(dbPath);
  insertCanonicalSession(db, id, file);
  db.close();
}

function makePaths(f: ReturnType<typeof fixture>) {
  return { dataDir: f.dataDir, dbPath: f.dbPath, backupRoot: f.backupRoot, ageRecipientFile: f.recipient };
}

describe("SQLite online backup core (WP3A)", () => {
  it("uses VACUUM INTO, encrypts every payload and manifest, and publishes COMPLETE atomically", async () => {
    const f = fixture();
    const sessionFile = path.join(f.dataDir, "sessions", "s1", "history.jsonl");
    const projectFile = path.join(f.dataDir, "projects", "p1", "sessions", "s1", "project.jsonl");
    writeFileSync(sessionFile, '{"secret":"payload-secret"}\n', { mode: 0o600 });
    writeFileSync(projectFile, '{"project":true}\n', { mode: 0o600 });
    writeFileSync(path.join(f.dataDir, ".pi-agent", "models.json"), '{"models":[]}\n', { mode: 0o600 });
    writeFileSync(path.join(f.dataDir, ".pi-agent", "auth.json"), '{"token":"must-not-copy"}\n', { mode: 0o600 });
    writeFileSync(path.join(f.dataDir, "sessions", "auth.json"), '{"token":"must-not-copy"}\n', { mode: 0o600 });
    writeFileSync(path.join(f.dataDir, "not-whitelisted.json"), '{"secret":"must-not-copy"}\n', { mode: 0o600 });
    putSession(f.dbPath, "s1", sessionFile);
    const before = readFileSync(f.dbPath);
    const age = fakeAge();

    const result = await createSqliteBackup({ paths: makePaths(f), age });
    expect(result.finalPath).toBeTruthy();
    expect(existsSync(path.join(result.finalPath!, "COMPLETE"))).toBe(true);
    expect(readdirSync(result.finalPath!).sort()).toEqual(["COMPLETE", "manifest.json.age", "payload"]);
    expect(readFileSync(f.dbPath)).toEqual(before);

    const dbPayload = age.decrypt(readFileSync(path.join(result.finalPath!, "payload/database.sqlite.age")));
    // Use a private temporary copy solely for checking the encrypted snapshot.
    writeFileSync(path.join(f.root, "decrypted.db"), dbPayload);
    const checked = new DatabaseSync(path.join(f.root, "decrypted.db"), { readOnly: true });
    expect(checked.prepare("SELECT id, conversation_ref FROM sessions").all()).toHaveLength(1);
    checked.close();
    const manifest = JSON.parse(age.decrypt(readFileSync(path.join(result.finalPath!, "manifest.json.age"))).toString()) as {
      files: Array<{ path: string; sha256: string }>;
      credentials: { included: boolean };
      missingSessionReferences: unknown[];
    };
    expect(manifest.credentials.included).toBe(false);
    const sessionPayload = age.decrypt(readFileSync(path.join(result.finalPath!, "payload/sessions/s1/history.jsonl.age")));
    expect(manifest.files.find((file) => file.path.endsWith("history.jsonl.age"))?.sha256).toBe(createHash("sha256").update(sessionPayload).digest("hex"));
    expect(manifest.files.map((file) => file.path)).toEqual([
      "payload/database.sqlite.age",
      "payload/.pi-agent/models.json.age",
      "payload/projects/p1/sessions/s1/project.jsonl.age",
      "payload/sessions/s1/history.jsonl.age",
    ]);
    expect(manifest.missingSessionReferences).toEqual([]);
    const encryptedPayloads = readdirSync(path.join(result.finalPath!, "payload"), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(path.join(entry.parentPath, entry.name)).toString("utf8"))
      .join(" ");
    const encryptedManifest = readFileSync(path.join(result.finalPath!, "manifest.json.age")).toString("utf8");
    expect(`${encryptedPayloads} ${encryptedManifest}`).not.toContain("must-not-copy");
    expect(`${encryptedPayloads} ${encryptedManifest}`).not.toContain("payload-secret");
  });

  it("fails closed before encryption or publication for a missing, multi-row, or checksum-mismatched source ledger (including dry-run)", async () => {
    for (const mutate of [
      (db: DatabaseSync) => db.exec("DROP TABLE schema_migrations"),
      (db: DatabaseSync) => db.prepare("INSERT INTO schema_migrations VALUES (1, 'legacy-extra', ?, 2)").run("b".repeat(64)),
      (db: DatabaseSync) => db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 0").run("0".repeat(64)),
    ]) {
      const f = fixture();
      const db = new DatabaseSync(f.dbPath);
      try { mutate(db); } finally { db.close(); }
      for (const dryRun of [false, true]) {
        await expect(createSqliteBackup({ paths: makePaths(f), dryRun, age: fakeAge() })).rejects.toThrow(/migration ledger|single-baseline/);
      }
      expect(existsSync(f.backupRoot)).toBe(false);
    }
  });

  it("fails closed before encryption or publication when the canonical ledger is correct but the physical schema is missing a canonical table/column/index (including dry-run)", async () => {
    for (const mutate of [
      (db: DatabaseSync) => db.exec("DROP TABLE projects"),
      (db: DatabaseSync) => db.exec("ALTER TABLE sessions DROP COLUMN system_prompt"),
      (db: DatabaseSync) => db.exec("DROP INDEX idx_projects_owner"),
    ]) {
      const f = fixture();
      putSession(f.dbPath, "s1", path.join(f.dataDir, "sessions", "s1", "history.jsonl"));
      const db = new DatabaseSync(f.dbPath);
      try { mutate(db); } finally { db.close(); }
      for (const dryRun of [false, true]) {
        await expect(createSqliteBackup({ paths: makePaths(f), dryRun, age: fakeAge() }))
          .rejects.toThrow(/physical schema|不兼容|incompatible|物理契约/);
      }
      // 发布前失败：backup root 从不创建，无 COMPLETE，无发布目录。
      expect(existsSync(f.backupRoot)).toBe(false);
    }
  });

  it("fails closed before encryption or publication when an extra object exists beyond the canonical physical schema (including dry-run)", async () => {
    for (const mutate of [
      (db: DatabaseSync) => db.exec("CREATE TABLE extra_table (id INTEGER PRIMARY KEY)"),
      (db: DatabaseSync) => db.exec("CREATE INDEX idx_extra_index ON projects(name)"),
      (db: DatabaseSync) => db.exec("CREATE VIEW extra_view AS SELECT id FROM projects"),
      (db: DatabaseSync) => db.exec("CREATE TRIGGER extra_trig AFTER INSERT ON projects BEGIN SELECT 1; END"),
    ]) {
      const f = fixture();
      putSession(f.dbPath, "s1", path.join(f.dataDir, "sessions", "s1", "history.jsonl"));
      const db = new DatabaseSync(f.dbPath);
      try { mutate(db); } finally { db.close(); }
      for (const dryRun of [false, true]) {
        await expect(createSqliteBackup({ paths: makePaths(f), dryRun, age: fakeAge() }))
          .rejects.toThrow(/physical schema|不兼容|incompatible|物理契约|额外表/);
      }
      // 发布前失败：backup root 从不创建，无 COMPLETE，无发布目录。
      expect(existsSync(f.backupRoot)).toBe(false);
    }
  });

  it("reports missing in-root session references without claiming inclusion", async () => {
    const f = fixture();
    const missing = path.join(f.dataDir, "sessions", "missing-session", "history.jsonl");
    putSession(f.dbPath, "missing-session", missing);
    const result = await createSqliteBackup({ paths: makePaths(f), age: fakeAge() });
    expect(result.missingSessionReferences).toEqual([{ sessionId: "missing-session", path: "sessions/missing-session/history.jsonl", status: "missing" }]);
    expect(result.manifest?.missingSessionReferences).toHaveLength(1);
  });

  it("binds an exact referenced file missing from an earlier payload plan without another directory scan", () => {
    const f = fixture();
    const session = path.join(f.dataDir, "sessions", "s1", "history.jsonl");
    writeFileSync(session, '{"type":"session"}\n', { mode: 0o600 });
    const bound = bindReferencesToPayload([{ sessionId: "s1", projectId: DEFAULT_PROJECT_ID, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: session }], realpathSync(f.dataDir), []);
    expect(bound.missing).toEqual([]);
    expect(bound.files).toEqual([{ sourcePath: realpathSync(session), relativePath: "sessions/s1/history.jsonl", kind: "jsonl" }]);
  });

  it("fails closed when a Pi reference is inside DATA_DIR but belongs to a different session", () => {
    const f = fixture();
    const foreign = path.join(f.dataDir, "sessions", "other-session", "history.jsonl");
    expect(() => bindReferencesToPayload([
      { sessionId: "claimed-session", projectId: DEFAULT_PROJECT_ID, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: foreign },
    ], realpathSync(f.dataDir), [])).toThrow(/does not match its Pi session/);
  });

  it("treats missing session references as missing-as-empty: records them in the manifest and still publishes (fail-open, never strict)", async () => {
    const f = fixture();
    const missing = path.join(f.dataDir, "sessions", "missing-as-empty", "history.jsonl");
    putSession(f.dbPath, "missing-as-empty", missing);
    const result = await createSqliteBackup({ paths: makePaths(f), age: fakeAge() });
    expect(result.finalPath).toBeTruthy();
    expect(existsSync(path.join(result.finalPath!, "COMPLETE"))).toBe(true);
    expect(result.missingSessionReferences).toEqual([{ sessionId: "missing-as-empty", path: "sessions/missing-as-empty/history.jsonl", status: "missing" }]);
    expect(result.manifest?.missingSessionReferences).toHaveLength(1);
    // 缺失引用不影响发布；dry-run 同样成功并记录缺失。
    const dry = await createSqliteBackup({ paths: makePaths(f), dryRun: true, age: fakeAge() });
    expect(dry.dryRun).toBe(true);
    expect(dry.finalPath).toBeNull();
    expect(dry.missingSessionReferences).toHaveLength(1);
  });

  it("binds concurrent snapshot-window references: a missing late history is recorded missing-as-empty", async () => {
    const f = fixture();
    writeFileSync(path.join(f.dataDir, "sessions", "s1", "history.jsonl"), '{"type":"session"}\n', { mode: 0o600 });
    // Pre-switch to WAL so the concurrent writer is never blocked by the
    // backup's read-only source connection while the concurrent writer remains active.
    const warmup = new DatabaseSync(f.dbPath);
    warmup.exec("PRAGMA journal_mode=WAL");
    warmup.close();
    const writer = new DatabaseSync(f.dbPath);
    // The write lands deterministically AFTER the inspect-time reference
    // check (which runs before any staging) and BEFORE the VACUUM INTO: the
    // ensureAvailable hook is the only code between inspection and staging.
    const lateFile = path.join(f.dataDir, "sessions", "late-session", "history.jsonl");
    const age: AgeAdapter = {
      ...fakeAge(),
      ensureAvailable() {
        insertCanonicalSession(writer, "late-session", lateFile);
      },
    };
    try {
      const result = await createSqliteBackup({ paths: makePaths(f), age });
      expect(result.finalPath).toBeTruthy();
      expect(existsSync(path.join(result.finalPath!, "COMPLETE"))).toBe(true);
      // 快照包含迟到行（VACUUM INTO 的内容来源）。最终 snapshot 引用集是
      // 权威来源：文件仍缺失时必须明确记录 missing-as-empty。
      const dbPayload = fakeAge().decrypt(readFileSync(path.join(result.finalPath!, "payload/database.sqlite.age")));
      writeFileSync(path.join(f.root, "decrypted.db"), dbPayload);
      const checked = new DatabaseSync(path.join(f.root, "decrypted.db"), { readOnly: true });
      try {
        const row = checked.prepare("SELECT id, conversation_ref FROM sessions WHERE id = ?").get("late-session") as { id: string; conversation_ref: string } | undefined;
        expect(row).toBeDefined();
        expect(row!.conversation_ref).toBe(lateFile);
      } finally { checked.close(); }
      expect(existsSync(path.join(result.finalPath!, "payload/sessions/late-session/history.jsonl.age"))).toBe(false);
      expect(result.manifest?.missingSessionReferences).toEqual([{ sessionId: "late-session", path: "sessions/late-session/history.jsonl", status: "missing" }]);
    } finally {
      writer.close();
    }
  });

  it("binds a file created before the final snapshot as an exact payload without a second directory scan", async () => {
    const f = fixture();
    writeFileSync(path.join(f.dataDir, "sessions", "s1", "history.jsonl"), '{"type":"session"}\n', { mode: 0o600 });
    const warmup = new DatabaseSync(f.dbPath);
    warmup.exec("PRAGMA journal_mode=WAL");
    warmup.close();
    const writer = new DatabaseSync(f.dbPath);
    // 并发写入同时创建新会话文件并插入引用：文件存在但不在 inspect 阶段收集的
    // payload 集合里。最终 snapshot 绑定按精确引用把该文件加入 payload，
    // 无需再次扫描会话目录。
    const freshFile = path.join(f.dataDir, "sessions", "fresh-session", "history.jsonl");
    const age: AgeAdapter = {
      ...fakeAge(),
      ensureAvailable() {
        mkdirSync(path.dirname(freshFile), { recursive: true, mode: 0o700 });
        writeFileSync(freshFile, '{"type":"session","id":"fresh-header"}\n', { mode: 0o600 });
        insertCanonicalSession(writer, "fresh-session", freshFile);
      },
    };
    try {
      const result = await createSqliteBackup({ paths: makePaths(f), age });
      expect(result.finalPath).toBeTruthy();
      expect(existsSync(path.join(result.finalPath!, "COMPLETE"))).toBe(true);
      expect(existsSync(path.join(result.finalPath!, "payload/sessions/fresh-session/history.jsonl.age"))).toBe(true);
      expect(result.manifest?.missingSessionReferences).toEqual([]);
    } finally { writer.close(); }
  });

  it("fails fast for an external session reference and does not publish a backup", async () => {
    const f = fixture();
    const outside = path.join(f.root, "outside.jsonl");
    writeFileSync(outside, '{"secret":"outside"}\n', { mode: 0o600 });
    putSession(f.dbPath, "external", outside);
    await expect(createSqliteBackup({ paths: makePaths(f), age: fakeAge() })).rejects.toThrow(/outside the whitelisted/);
    expect(existsSync(f.backupRoot)).toBe(false);
  });

  it("backs up arbitrary JSONL bytes as opaque data (no JSON.parse) and retries a changing source as one stability unit", async () => {
    // 非 JSON/半行内容不再被校验：JSONL 在 backup 阶段是 opaque bytes，逐字节
    // 稳定复制后加密发布（内容合法性由 restore 的 invalid-as-empty 处理）。
    const f = fixture();
    const file = path.join(f.dataDir, "sessions", "s1", "history.jsonl");
    const bytes = Buffer.from('{"unfinished":\nraw-bytes-not-json\u0000binary', "utf8");
    writeFileSync(file, bytes, { mode: 0o600 });
    const result = await createSqliteBackup({ paths: makePaths(f), age: fakeAge() });
    expect(result.finalPath).toBeTruthy();
    expect(existsSync(path.join(result.finalPath!, "COMPLETE"))).toBe(true);
    const decrypted = fakeAge().decrypt(readFileSync(path.join(result.finalPath!, "payload/sessions/s1/history.jsonl.age")));
    expect(decrypted).toEqual(bytes);

    const changing = fixture();
    const changingFile = path.join(changing.dataDir, "sessions", "s1", "history.jsonl");
    writeFileSync(changingFile, '{"stable":true}\n', { mode: 0o600 });
    let calls = 0;
    const age: AgeAdapter = {
      encrypt(input, recipient) {
        calls++;
        if (calls === 2) writeFileSync(changingFile, '{"changed":true}\n', { mode: 0o600 });
        return fakeAge().encrypt(input, recipient);
      },
    };
    const retried = await createSqliteBackup({ paths: makePaths(changing), age });
    expect(retried.finalPath).toBeTruthy();
    expect(existsSync(path.join(retried.finalPath!, "COMPLETE"))).toBe(true);
    expect(calls).toBeGreaterThan(2);
  });

  it("dry-run reads and validates but creates neither backup root nor source changes", async () => {
    const f = fixture();
    const file = path.join(f.dataDir, "sessions", "s1", "history.jsonl");
    writeFileSync(file, '{"ok":true}\n', { mode: 0o600 });
    const before = readFileSync(f.dbPath);
    const result = await createSqliteBackup({ paths: makePaths(f), dryRun: true, age: { encrypt: () => { throw new Error("must not encrypt"); } } });
    expect(result.dryRun).toBe(true);
    expect(result.finalPath).toBeNull();
    expect(existsSync(f.backupRoot)).toBe(false);
    expect(readFileSync(f.dbPath)).toEqual(before);
  });

  it("clears a failed staging backup and never publishes COMPLETE", async () => {
    const f = fixture();
    writeFileSync(path.join(f.dataDir, "sessions", "s1", "history.jsonl"), '{"secret":"not-published"}\n', { mode: 0o600 });
    const age: AgeAdapter = { encrypt: () => { throw new Error("injected age failure"); } };
    await expect(createSqliteBackup({ paths: makePaths(f), age })).rejects.toThrow(/injected age failure/);
    expect(readdirSync(f.backupRoot).filter((name) => name.includes("staging") || name === "COMPLETE")).toEqual([]);
  });

  it("rejects unsafe recipient files and in-memory/relative targets", async () => {
    const f = fixture();
    chmodSync(f.recipient, 0o666);
    await expect(createSqliteBackup({ paths: makePaths(f), age: fakeAge() })).rejects.toThrow(/safe regular file/);
    await expect(createSqliteBackup({ paths: { ...makePaths(f), dbPath: ":memory:" }, age: fakeAge() })).rejects.toThrow(/absolute path/);
  });

  it("fails closed for unknown files, symlink aliases and hardlinks, while auditing auth variants", async () => {
    const f = fixture();
    writeFileSync(path.join(f.dataDir, "sessions", "s1", "AUTH.JSON"), "secret", { mode: 0o600 });
    const skipped = await createSqliteBackup({ paths: makePaths(f), age: fakeAge() });
    expect(skipped.manifest?.excludedFiles).toEqual([{ path: "sessions/s1/AUTH.JSON", reason: "auth-file" }]);

    const unknown = fixture();
    writeFileSync(path.join(unknown.dataDir, "sessions", "s1", "history.txt"), "not jsonl", { mode: 0o600 });
    await expect(createSqliteBackup({ paths: makePaths(unknown), age: fakeAge() })).rejects.toThrow(/unknown\/non-jsonl/);

    const hardlinked = fixture();
    const source = path.join(hardlinked.dataDir, "sessions", "s1", "history.jsonl");
    writeFileSync(source, "{\"ok\":true}\n", { mode: 0o600 });
    linkSync(source, path.join(hardlinked.dataDir, "sessions", "s1", "copy.jsonl"));
    await expect(createSqliteBackup({ paths: makePaths(hardlinked), age: fakeAge() })).rejects.toThrow(/hardlink/);

    const aliased = fixture();
    const alias = `${aliased.dataDir}-alias`;
    symlinkSync(aliased.dataDir, alias, "dir");
    await expect(createSqliteBackup({ paths: { ...makePaths(aliased), dataDir: alias }, age: fakeAge() })).rejects.toThrow(/symbolic-link/);
  });

  it("reads a live SQLite WAL through a read-only source without modifying the database", async () => {
    const f = fixture();
    const writer = new DatabaseSync(f.dbPath);
    try {
      writer.exec("PRAGMA journal_mode=WAL");
      // Introduce WAL content by writing to a canonical table: a probe table
      // would be an extra object and correctly fail the physical-schema gate.
      writer.exec("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES ('wal-probe', 'writer', '/wal', 'owner', 1)");
      const before = readFileSync(f.dbPath);
      const result = await createSqliteBackup({ paths: makePaths(f), age: fakeAge() });
      expect(result.finalPath).toBeTruthy();
      expect(readFileSync(f.dbPath)).toEqual(before);
    } finally { writer.close(); }
  });

  it("rejects the resolved custom credential location by path, never by the auth.json file name", async () => {
    // 自定义命名的凭证在 sessions 白名单根内 → 按解析后的路径拒绝（而非按文件名）。
    const inside = fixture();
    const hidden = path.join(inside.dataDir, "sessions", "s1", "creds.txt");
    writeFileSync(hidden, "secret", { mode: 0o600 });
    await expect(createSqliteBackup({ paths: { ...makePaths(inside), authPath: hidden }, age: fakeAge() }))
      .rejects.toThrow(/credential path overlaps the sessions whitelist root/);
    // 凭证反向包含源根（dataDir 在凭证目录内）→ 同样拒绝。
    const containing = fixture();
    await expect(createSqliteBackup({ paths: { ...makePaths(containing), authPath: containing.root }, age: fakeAge() }))
      .rejects.toThrow(/credential path overlaps/);
    // 凭证指向源 DB → 拒绝。
    const onDb = fixture();
    await expect(createSqliteBackup({ paths: { ...makePaths(onDb), authPath: onDb.dbPath }, age: fakeAge() }))
      .rejects.toThrow(/credential path overlaps the source database/);
    // 安全位置的自定义命名凭证：正常备份，但绝不进入白名单载荷。
    const outside = fixture();
    const credential = path.join(outside.root, "custom-credential.json");
    writeFileSync(credential, '{"token":"custom"}\n', { mode: 0o600 });
    const result = await createSqliteBackup({ paths: { ...makePaths(outside), authPath: credential }, age: fakeAge() });
    expect(result.manifest?.files.some((file) => file.path.includes("custom-credential"))).toBe(false);
    expect(result.manifest?.credentials).toEqual({ included: false, policy: "whitelist-excludes-credentials" });
  });

  it("uses an explicitly resolved custom agentDir for models.json", async () => {
    const f = fixture();
    const agentDir = path.join(f.root, "custom-agent");
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(agentDir, "models.json"), '{"models":["custom"]}\n', { mode: 0o600 });
    const result = await createSqliteBackup({ paths: { ...makePaths(f), agentDir }, age: fakeAge() });
    expect(result.manifest?.files.map((file) => file.path)).toContain("payload/agentDir/models.json.age");
    expect(result.manifest?.files.map((file) => file.path)).not.toContain("payload/.pi-agent/models.json.age");
  });
});
