import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import { migrationDefinitions } from "../../src/storage/migration-manifest.js";
import { runSqliteMigrations, runSqliteMigrationsForTest } from "../../src/storage/migration-engine.js";
import { artifactDeleteOperationKey, FileOperationPathError, isRedactedFileOperationError, redactFileOperationError } from "../../src/storage/file-operation-policy.js";
import { makeInitializedMemoryDb, type SqliteTestStorage } from "../helpers/sqlite.js";

const open: SqliteTestStorage[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

describe("WP4A file_operations outbox（SQLite）", () => {
  it("单基线 apply 建出完整 schema（含 outbox），既有业务数据保留，幂等重跑无 pending", async () => {
    // 用独立内存连接先应用发布的单基线 v0（= 完整 schema），再幂等重跑当前 registry。
    const raw = new DatabaseSync(":memory:");
    try {
      await runSqliteMigrationsForTest(raw, { migrations: [migrationDefinitions[0]!] });
      raw.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)").run("kept", "P", "/p", "owner", 1);
      const result = await runSqliteMigrations(raw);
      expect(result.appliedVersion).toBe(0);
      expect(result.pending).toEqual([]);
      expect(raw.prepare("SELECT name FROM projects WHERE id = 'kept'").get()).toEqual({ name: "P" });
      expect(raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 0 }]);
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_operations'").get()).toEqual({ name: "file_operations" });
    } finally {
      raw.close();
    }
  });

  it("session 删除与 enqueue 同事务，且不 unlink 文件", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-file-operation-"));
    const storage = await makeInitializedMemoryDb({ cwd: root, dataDir: root });
    open.push(storage);
    const file = join(root, "sessions", "s1", "history.jsonl");
    mkdirSync(join(root, "sessions", "s1"), { recursive: true });
    writeFileSync(file, "history\n");
    await storage.projects.ensureDefaultProject({ id: DEFAULT_PROJECT_ID, name: "默认项目", cwd: root, ownerKey: "", createdAt: 0 });
    await storage.sessions.create({
      id: "s1", ownerKey: "owner", projectId: DEFAULT_PROJECT_ID, title: "t", createdAt: 1, updatedAt: 1,
      agentKind: "pi",
      conversationFormat: "pi-jsonl-v3",
      conversationRef: file, modelProvider: null, modelId: null, thinkingLevel: null,
      systemPrompt: null, capabilityVersions: null,
    });

    await expect(storage.sessions.delete("s1")).resolves.toBe(true);
    expect(await storage.sessions.get("s1")).toBeNull();
    expect(await storage.fileOperations.list()).toEqual([
      expect.objectContaining({
        operationKey: artifactDeleteOperationKey("pi", "pi-jsonl-v3", "sessions/s1/history.jsonl"),
        kind: "delete",
        relativePath: "sessions/s1/history.jsonl",
        state: "pending",
        sessionId: "s1",
        projectId: DEFAULT_PROJECT_ID,
      }),
    ]);
    // 仅入 outbox；本测试没有 worker，文件当然不会被存储层触碰。
    expect(existsSync(file)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("项目删除在同一事务为所有会话入队；outbox 不受项目/会话删除影响", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-file-operation-project-"));
    const storage = await makeInitializedMemoryDb({ cwd: root, dataDir: root });
    open.push(storage);
    await storage.projects.create({ id: "p1", name: "P", cwd: root, ownerKey: "owner", createdAt: 1 });
    for (const id of ["s1", "s2"]) {
      await storage.sessions.create({
        id, ownerKey: "owner", projectId: "p1", title: id, createdAt: 1, updatedAt: 1,
        agentKind: "pi",
        conversationFormat: "pi-jsonl-v3",
        conversationRef: join(root, "projects", "p1", "sessions", id, "history.jsonl"),
        modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null,
      });
    }

    await storage.projects.deleteProjectWithSessions("p1", ["s1", "s2"]);
    expect(await storage.projects.get("p1")).toBeNull();
    expect(await storage.sessions.listByOwner("owner")).toEqual([]);
    expect((await storage.fileOperations.list()).map((row) => row.relativePath).sort()).toEqual([
      "projects/p1/sessions/s1/history.jsonl",
      "projects/p1/sessions/s2/history.jsonl",
    ]);
    // 没有 FK file_operations -> sessions/projects，删除父行不会级联丢 outbox。
    expect((await storage.fileOperations.list()).every((row) => row.state === "pending")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("operationKey 幂等，不覆盖已存在状态；路径只接受相对白名单", async () => {
    const storage = await makeInitializedMemoryDb();
    open.push(storage);
    const first = await storage.fileOperations.enqueue({
      operationKey: "delete-session:idempotent",
      relativePath: "sessions/idempotent/history.jsonl",
      createdAt: 10,
    });
    const second = await storage.fileOperations.enqueue({
      operationKey: "delete-session:idempotent",
      relativePath: "sessions/idempotent/other.jsonl",
      createdAt: 20,
    });
    expect(second).toEqual(first);
    const otherPath = await storage.fileOperations.enqueue({
      operationKey: artifactDeleteOperationKey("pi", "pi-jsonl-v3", "sessions/idempotent/other.jsonl"),
      relativePath: "sessions/idempotent/other.jsonl",
      createdAt: 30,
    });
    expect(otherPath.operationKey).not.toBe(first.operationKey);
    await expect(storage.fileOperations.enqueue({ operationKey: "bad", relativePath: "../secret.jsonl" })).rejects.toBeInstanceOf(FileOperationPathError);
    await expect(storage.fileOperations.enqueue({ operationKey: "bad-abs", relativePath: "/tmp/secret.jsonl" })).rejects.toBeInstanceOf(FileOperationPathError);
    await expect(storage.fileOperations.enqueue({ operationKey: "bad-layout", relativePath: "projects/p/s/history.jsonl" })).rejects.toBeInstanceOf(FileOperationPathError);
  });

  it("claim 是原子预留，状态转移和脱敏错误有界", async () => {
    const storage = await makeInitializedMemoryDb();
    open.push(storage);
    const queued = await storage.fileOperations.enqueue({
      operationKey: "delete-session:claim",
      relativePath: "sessions/claim/history.jsonl",
      createdAt: 100,
    });
    const claimed = await storage.fileOperations.claim(100, 1, 50);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id: queued.id, state: "processing", attemptCount: 1, availableAt: 100, leaseUntil: 150 });
    expect(claimed[0]!.leaseToken).toEqual(expect.any(String));
    expect(await storage.fileOperations.claim(100, 1, 50)).toEqual([]);
    expect(await storage.fileOperations.complete(queued.id, "wrong-token")).toBe(false);
    expect(await storage.fileOperations.fail(queued.id, new Error("password=super-secret /Users/alice/private.jsonl bearer eyJabc.def.ghi"), 200, claimed[0]!.leaseToken!)).toBe(true);
    const failed = await storage.fileOperations.get(queued.id);
    expect(failed).toMatchObject({ state: "failed", availableAt: 200 });
    // WP4B error policy：非 allowlist 的错误统一落到固定 canonical code，绝不保留原文。
    expect(failed?.lastError).toBe("file operation failed");
    expect(failed?.lastError).not.toContain("super-secret");
    expect(failed?.lastError).not.toContain("/Users/alice");
    const reclaimed = await storage.fileOperations.claim(200, 1, 50);
    expect(reclaimed[0]).toMatchObject({ id: queued.id, state: "processing", attemptCount: 2 });
    expect(await storage.fileOperations.complete(queued.id, reclaimed[0]!.leaseToken!)).toBe(true);
    expect((await storage.fileOperations.get(queued.id))?.state).toBe("completed");
    expect(await storage.fileOperations.complete(queued.id, reclaimed[0]!.leaseToken!)).toBe(false);
  });

  it("非 allowlist 的 last_error 行在仓库层 fail-closed，绝不读入内存模型", async () => {
    const storage = await makeInitializedMemoryDb();
    open.push(storage);
    // 篡改行：相对路径文本对 redaction 幂等，但不在固定 allowlist 内 → list() 抛错。
    storage.db.prepare(
      "INSERT INTO file_operations (id, operation_key, kind, relative_path, state, attempt_count, available_at, last_error, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("e0000000-0000-4000-8000-000000000000", "tampered-error", "delete", "sessions/s1/history.jsonl", "failed", 1, 0, "sessions/s1/history.jsonl", 0, 0);
    await expect(storage.fileOperations.list()).rejects.toThrow(/last_error/);
  });

  it("脱敏覆盖常见环境变量凭证，且规范错误保持幂等", () => {
    const previous = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      PGPASSWORD: process.env.PGPASSWORD,
    };
    process.env.OPENAI_API_KEY = "openai-test-secret";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-test-secret";
    process.env.PGPASSWORD = "pg-test-secret";
    try {
      const redacted = redactFileOperationError(new Error(
        "OPENAI_API_KEY=openai-test-secret AWS_SECRET_ACCESS_KEY=aws-test-secret PGPASSWORD=pg-test-secret",
      ));
      expect(redacted).not.toContain("openai-test-secret");
      expect(redacted).not.toContain("aws-test-secret");
      expect(redacted).not.toContain("pg-test-secret");
      expect(isRedactedFileOperationError(redacted)).toBe(true);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("artifact delete operationKey 不含 sessionId，且同一 artifact 恒定", () => {
    const key = artifactDeleteOperationKey("pi", "pi-jsonl-v3", "sessions/s1-custom/history.jsonl");
    expect(key).not.toContain("s1-custom");
    // 同一 artifact（相对路径 + agent kind + conversation format）恒定
    expect(artifactDeleteOperationKey("pi", "pi-jsonl-v3", "sessions/s1-custom/history.jsonl")).toBe(key);
    // 不同路径或不同 kind/format 生成不同键
    expect(artifactDeleteOperationKey("pi", "pi-jsonl-v3", "sessions/s2-custom/history.jsonl")).not.toBe(key);
    expect(artifactDeleteOperationKey("pi", "pi-jsonl-v2", "sessions/s1-custom/history.jsonl")).not.toBe(key);
    // 非空 kind/format 被拒绝
    expect(() => artifactDeleteOperationKey("", "pi-jsonl-v3", "sessions/s1/history.jsonl")).toThrow(/agent kind/);
    expect(() => artifactDeleteOperationKey("pi", "", "sessions/s1/history.jsonl")).toThrow(/conversation format/);
    // 非白名单相对路径被拒绝
    expect(() => artifactDeleteOperationKey("pi", "pi-jsonl-v3", "../escape.jsonl")).toThrow(FileOperationPathError);
  });

  it("路径校验失败时事务整体回滚，项目/会话都保留且不产生 outbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-file-operation-rollback-"));
    const storage = await makeInitializedMemoryDb({ cwd: root, dataDir: root });
    open.push(storage);
    await storage.projects.create({ id: "p-bad", name: "P", cwd: root, ownerKey: "owner", createdAt: 1 });
    await storage.sessions.create({
      id: "s-bad", ownerKey: "owner", projectId: "p-bad", title: "bad", createdAt: 1, updatedAt: 1,
      agentKind: "pi",
      conversationFormat: "pi-jsonl-v3",
      conversationRef: "/outside/not-whitelisted.jsonl", modelProvider: null, modelId: null, thinkingLevel: null,
      systemPrompt: null, capabilityVersions: null,
    });
    await expect(storage.projects.deleteProjectWithSessions("p-bad", ["s-bad"])).rejects.toBeInstanceOf(FileOperationPathError);
    expect(await storage.projects.get("p-bad")).not.toBeNull();
    expect(await storage.sessions.get("s-bad")).not.toBeNull();
    expect(await storage.fileOperations.list()).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
