import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteBackup, type AgeAdapter } from "../../src/backup/backup-core.js";

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
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, pi_session_file TEXT)");
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at INTEGER)");
  db.prepare("INSERT INTO schema_migrations VALUES (0, 'initial', 'abc', 1)").run();
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
  db.prepare("INSERT INTO sessions VALUES (?, ?)").run(id, file);
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
    expect(checked.prepare("SELECT id, pi_session_file FROM sessions").all()).toHaveLength(1);
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

  it("reports missing in-root session references without claiming inclusion", async () => {
    const f = fixture();
    const missing = path.join(f.dataDir, "sessions", "gone", "history.jsonl");
    putSession(f.dbPath, "missing-session", missing);
    const result = await createSqliteBackup({ paths: makePaths(f), age: fakeAge() });
    expect(result.missingSessionReferences).toEqual([{ sessionId: "missing-session", path: "sessions/gone/history.jsonl", status: "missing" }]);
    expect(result.manifest?.missingSessionReferences).toHaveLength(1);
  });

  it("fails fast for an external session reference and does not publish a backup", async () => {
    const f = fixture();
    const outside = path.join(f.root, "outside.jsonl");
    writeFileSync(outside, '{"secret":"outside"}\n', { mode: 0o600 });
    putSession(f.dbPath, "external", outside);
    await expect(createSqliteBackup({ paths: makePaths(f), age: fakeAge() })).rejects.toThrow(/outside the whitelisted/);
    expect(existsSync(f.backupRoot)).toBe(false);
  });

  it("rejects half JSONL and retries a changing JSONL source as one stability unit", async () => {
    const f = fixture();
    const file = path.join(f.dataDir, "sessions", "s1", "history.jsonl");
    writeFileSync(file, '{"unfinished":\n', { mode: 0o600 });
    await expect(createSqliteBackup({ paths: makePaths(f), age: fakeAge() })).rejects.toThrow(/exceeded/);

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
      writer.exec("CREATE TABLE wal_probe (value TEXT)");
      writer.prepare("INSERT INTO wal_probe VALUES (?)").run("written-before-backup");
      const before = readFileSync(f.dbPath);
      const result = await createSqliteBackup({ paths: makePaths(f), age: fakeAge() });
      expect(result.finalPath).toBeTruthy();
      expect(readFileSync(f.dbPath)).toEqual(before);
    } finally { writer.close(); }
  });

  it("fixes the pre-reset tree binding at snapshot time: a WAL-only write between the snapshot and the manifest fails the backup with zero publication", async () => {
    const f = fixture();
    writeFileSync(path.join(f.dataDir, "sessions", "s1", "history.jsonl"), '{"type":"session"}\n', { mode: 0o600 });
    // 预先把库切到 WAL（备份前完成，避免 journal-mode 头部变化污染对比）。
    const warmup = new DatabaseSync(f.dbPath);
    warmup.exec("PRAGMA journal_mode=WAL");
    warmup.close();
    // writer 连接贯穿整个备份：第一次 age 调用发生在 VACUUM INTO 之后、manifest
    // 写入之前 —— 此时做 WAL-only 写入（不 checkpoint，主 DB 文件不变）。
    const writer = new DatabaseSync(f.dbPath);
    const age: AgeAdapter = {
      encrypt(input, recipient) {
        writer.prepare("CREATE TABLE IF NOT EXISTS wal_probe (value TEXT)").run();
        writer.prepare("INSERT INTO wal_probe VALUES (?)").run("wal-only-commit-after-snapshot");
        return fakeAge().encrypt(input, recipient);
      },
    };
    try {
      // binding 已在快照后立即固定：发布前只与该 immutable binding 比较，禁止重新
      // 采集替换基准 —— 因此 WAL-only 写入必须让备份失败，绝不发布。
      await expect(createSqliteBackup({ paths: makePaths(f), backupKind: "pre-reset", age }))
        .rejects.toThrow(/source SQLite WAL changed after the backup was taken/);
      expect(existsSync(f.backupRoot) ? readdirSync(f.backupRoot) : []).toEqual([]);
    } finally { writer.close(); }
    // 零删除：源数据完好。
    expect(existsSync(path.join(f.dataDir, "sessions", "s1", "history.jsonl"))).toBe(true);
  });

  it("keeps the published pre-reset manifest binding immutable from the verified snapshot state", async () => {
    const f = fixture();
    writeFileSync(path.join(f.dataDir, "sessions", "s1", "history.jsonl"), '{"type":"session"}\n', { mode: 0o600 });
    const result = await createSqliteBackup({ paths: makePaths(f), backupKind: "pre-reset", age: fakeAge() });
    expect(result.finalPath).toBeTruthy();
    const binding = result.manifest?.sourceTreeBinding;
    expect(binding).toBeDefined();
    // manifest 写入的 binding 即快照时点的状态：与当前磁盘状态一致（无后续写入）。
    expect(binding?.db.sha256).toBe(createHash("sha256").update(readFileSync(f.dbPath)).digest("hex"));
    expect(binding?.wal.exists).toBe(false);
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
