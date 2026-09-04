// WP4B（方案 A）安全只读 planner 测试：只按状态/错误计数，零 claim/complete/fail、
// 不扫描文件系统、不生成操作、报告绝不包含 relative/absolute 路径。

import { afterEach, describe, expect, it } from "vitest";
import type {
  EnqueueFileOperationInput,
  FileOperationRecord,
  FileOperationStorePort,
} from "../../src/application/ports/file-operation-store-port.js";
import { planFileOperationBatch } from "../../src/file-operations/planner.js";
import { makeInitializedMemoryDb, type SqliteTestStorage } from "../helpers/sqlite.js";

const open: SqliteTestStorage[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

function now() {
  return 1_000_000;
}

function record(overrides: Partial<FileOperationRecord> & { id: string; relativePath: string }): FileOperationRecord {
  return {
    operationKey: `key:${overrides.id}`,
    kind: "delete",
    sessionId: null,
    projectId: null,
    state: "pending",
    attemptCount: 0,
    availableAt: 0,
    leaseUntil: null,
    leaseToken: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 记录被调用过的方法（证明 planner 只读：只触发 list）。 */
function spyStore(store: FileOperationStorePort): FileOperationStorePort & { calls: string[] } {
  const calls: string[] = [];
  const wrapped: FileOperationStorePort = {
    enqueue: async (input: EnqueueFileOperationInput) => { calls.push("enqueue"); return store.enqueue(input); },
    get: async (id: string) => { calls.push("get"); return store.get(id); },
    getByOperationKey: async (key: string) => { calls.push("getByOperationKey"); return store.getByOperationKey(key); },
    list: async (state?: FileOperationRecord["state"]) => { calls.push("list"); return store.list(state); },
    claim: async (n?: number, l?: number, ms?: number) => { calls.push("claim"); return store.claim(n, l, ms); },
    complete: async (id: string, token: string) => { calls.push("complete"); return store.complete(id, token); },
    fail: async (id: string, error: unknown, at: number | undefined, token: string) => { calls.push("fail"); return store.fail(id, error, at, token); },
  };
  return Object.assign(wrapped, { calls });
}

describe("WP4B planner：只读计数（无文件/状态副作用）", () => {
  it("只调用 list()，绝不调用 claim/complete/fail/enqueue", async () => {
    const storage = await makeInitializedMemoryDb();
    open.push(storage);
    const store = spyStore(storage.fileOperations);
    const report = await planFileOperationBatch(store, now());
    expect(store.calls).toEqual(["list"]);
    expect(report.executable).toBe(false);
    expect(report.mode).toBe("dry-run");
  });

  it("pending / processing-expired / failed-due 分别计数，planned = 三者之和", async () => {
    const storage = await makeInitializedMemoryDb();
    open.push(storage);
    const createdAt = now();
    const pending = await storage.fileOperations.enqueue({ operationKey: "p1", relativePath: "sessions/s1/history.jsonl", createdAt });
    const expired = await storage.fileOperations.enqueue({ operationKey: "p2", relativePath: "sessions/s2/history.jsonl", createdAt: createdAt + 1 });
    const active = await storage.fileOperations.enqueue({ operationKey: "p3", relativePath: "sessions/s3/history.jsonl", createdAt: createdAt + 2 });
    const due = await storage.fileOperations.enqueue({ operationKey: "p4", relativePath: "sessions/s4/history.jsonl", createdAt: createdAt + 3 });
    const deferred = await storage.fileOperations.enqueue({ operationKey: "p5", relativePath: "sessions/s5/history.jsonl", createdAt: createdAt + 4 });
    const done = await storage.fileOperations.enqueue({ operationKey: "p6", relativePath: "sessions/s6/history.jsonl", createdAt: createdAt + 5 });
    const t = now() + 100_000;
    const update = (id: string, fields: string, values: Array<string | number | null>): void => {
      storage.db.prepare(`UPDATE file_operations SET ${fields} WHERE id = ?`).run(...values, id);
    };
    // processing：一个 lease 已过期（崩溃残留），一个仍在有效 lease 内。
    update(expired.id, "state = 'processing', lease_token = 't2', lease_until = ?, attempt_count = 1", [t - 30_000]);
    update(active.id, "state = 'processing', lease_token = 't3', lease_until = ?, attempt_count = 1", [t + 30_000]);
    update(due.id, "state = 'failed', available_at = 0, last_error = 'file operation failed', attempt_count = 1", []);
    update(deferred.id, "state = 'failed', available_at = ?, last_error = 'file operation failed'", [t + 90_000]);
    update(done.id, "state = 'completed'", []);

    const report = await planFileOperationBatch(storage.fileOperations, t);
    expect(report.planned).toBe(3); // pending + processingExpired + failedDue
    expect(report.pending).toBe(1);
    expect(report.processingExpired).toBe(1);
    expect(report.failedDue).toBe(1);
    expect(report.stateCounts).toEqual({ pending: 1, processing: 2, completed: 1, failed: 2 });
    expect(report.errorCodes).toEqual({ "file operation failed": 2 });
    expect(report.unsafeErrors).toBe(0);
    // 行状态未被 planner 触碰。
    expect((await storage.fileOperations.get(pending.id))).toMatchObject({ state: "pending", attemptCount: 0, leaseToken: null });
    expect((await storage.fileOperations.get(due.id))).toMatchObject({ state: "failed", attemptCount: 1 });
    expect((await storage.fileOperations.get(active.id))).toMatchObject({ state: "processing", leaseToken: "t3" });
    expect((await storage.fileOperations.list("pending"))).toHaveLength(1);
  });

  it("报告 JSON 不包含任何相对路径 / 绝对路径", async () => {
    const storage = await makeInitializedMemoryDb();
    open.push(storage);
    await storage.fileOperations.enqueue({ operationKey: "leak", relativePath: "sessions/leaky-secret/history.jsonl", createdAt: 1 });
    const report = await planFileOperationBatch(storage.fileOperations, now());
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("sessions");
    expect(serialized).not.toContain("projects");
    expect(serialized).not.toContain("history.jsonl");
    expect(serialized).not.toContain("leaky-secret");
    expect(serialized).not.toContain("/");
  });
});

describe("WP4B planner：fail-closed 错误计数（固定 allowlist）", () => {
  it("非 allowlist 的 last_error 只计入 unsafeErrors，绝不进入报告 key", async () => {
    const secretText = "/Users/alice/.pi/agent/auth.json";
    const store = spyStore({
      enqueue: async () => record({ id: "i", relativePath: "sessions/s1/history.jsonl" }),
      get: async () => null,
      getByOperationKey: async () => null,
      list: async () => [
        record({ id: "a", relativePath: "sessions/s1/history.jsonl", lastError: "file operation failed" }),
        record({ id: "b", relativePath: "sessions/s2/history.jsonl", lastError: secretText, state: "failed", availableAt: 0 }),
        // 相对路径：redaction 对其幂等，但不在固定 allowlist 内 → 只计数不成为 key。
        record({ id: "c", relativePath: "sessions/s3/history.jsonl", lastError: "sessions/s3/history.jsonl", state: "failed", availableAt: 0 }),
        // credential= 赋值不被脱敏规则覆盖，同样不允许成为 key。
        record({ id: "d", relativePath: "sessions/s4/history.jsonl", lastError: "credential=AKIAIOSFODNN7EXAMPLE", state: "failed", availableAt: 0 }),
        // 任意未知自由文本也不允许成为 key。
        record({ id: "e", relativePath: "sessions/s5/history.jsonl", lastError: "sqlite error: database is locked", state: "failed", availableAt: 0 }),
      ],
      claim: async () => [],
      complete: async () => false,
      fail: async () => false,
    });
    const report = await planFileOperationBatch(store, now());
    expect(report.errorCodes).toEqual({ "file operation failed": 1 });
    expect(report.unsafeErrors).toBe(4);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("/Users");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("sessions/s3");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("AKIA");
    expect(serialized).not.toContain("database is locked");
  });

  it("固定 allowlist 内的 canonical code 计入 errorCodes（含路径/kind/state 防御码）", async () => {
    const store = spyStore({
      enqueue: async () => record({ id: "i", relativePath: "sessions/s1/history.jsonl" }),
      get: async () => null,
      getByOperationKey: async () => null,
      list: async () => [
        record({ id: "a", relativePath: "sessions/s1/history.jsonl", lastError: "file operation failed", state: "failed", availableAt: 0 }),
        record({ id: "b", relativePath: "sessions/s2/history.jsonl", lastError: "file operation path is outside the relative JSONL whitelist", state: "failed", availableAt: 0 }),
        record({ id: "c", relativePath: "sessions/s3/history.jsonl", lastError: "unsupported file operation kind", state: "failed", availableAt: 0 }),
        record({ id: "d", relativePath: "sessions/s4/history.jsonl", lastError: "file operation state is invalid", state: "failed", availableAt: 0 }),
      ],
      claim: async () => [],
      complete: async () => false,
      fail: async () => false,
    });
    const report = await planFileOperationBatch(store, now());
    expect(report.errorCodes).toEqual({
      "file operation failed": 1,
      "file operation path is outside the relative JSONL whitelist": 1,
      "unsupported file operation kind": 1,
      "file operation state is invalid": 1,
    });
    expect(report.unsafeErrors).toBe(0);
  });

  it("非法 state / 非法相对路径在仓库层已 fail-closed（WP4A 契约），planner 不降级", async () => {
    const storage = await makeInitializedMemoryDb();
    open.push(storage);
    const createdAt = now();
    // 篡改行：relative_path 越界 → 仓库 toRecord 校验使 list() 抛错（零计数输出）。
    storage.db.prepare(
      "INSERT INTO file_operations (id, operation_key, kind, relative_path, state, attempt_count, available_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("f0000000-0000-4000-8000-000000000000", "tampered", "delete", "../escape.jsonl", "pending", 0, createdAt, createdAt, createdAt);
    await expect(planFileOperationBatch(storage.fileOperations, now())).rejects.toThrow(/file operation path is outside/);
  });
});