import { afterEach, describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { initStorage } from "./helpers/sqlite.js";

// M2 资源所有权：每个用例的 fixture 由 afterEach 按真实所有权关闭（统一 Kysely destroy close）。
const openStorages: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (openStorages.length) await openStorages.pop()!.close();
});

async function makeIdempotency() {
  const storage = await initStorage(new DatabaseSync(":memory:"));
  openStorages.push(storage);
  return storage;
}

describe("KyselyIdempotencyRepository（needs.md §4.2 requestId 去重持久化，SQLite/PG 共用同构）", () => {
  it("put 后 get 返回结果", async () => {
    const repo = (await makeIdempotency()).idempotency;
    await repo.put("s1", "r1", { status: "completed" });
    expect(await repo.get("s1", "r1")).toEqual({ status: "completed" });
  });

  it("get 不存在返回 null", async () => {
    const repo = (await makeIdempotency()).idempotency;
    expect(await repo.get("s1", "nope")).toBeNull();
  });

  it("put 重复覆盖同一 requestId（幂等，不重复执行语义）", async () => {
    const repo = (await makeIdempotency()).idempotency;
    await repo.put("s1", "r1", { status: "completed" });
    await repo.put("s1", "r1", { status: "completed-2" });
    expect(await repo.get("s1", "r1")).toEqual({ status: "completed-2" });
  });

  it("prune 精确 cutoff：只删 created_at < before，before 与 before+1 保留，返回删除数（H6，不用真实 setTimeout）", async () => {
    const storage = await makeIdempotency();
    const repo = storage.idempotency;
    const before = 5000;
    const sids = [randomUUID(), randomUUID(), randomUUID()] as const;
    await repo.put(sids[0], "before-1", { status: "completed" });
    await repo.put(sids[1], "at-before", { status: "completed" });
    await repo.put(sids[2], "after-before", { status: "completed" });
    // 直接改 created_at 精确打点（put 内部用 Date.now()；Kysely 方言无关）
    await storage.kysely
      .updateTable("idempotency")
      .set({ created_at: before - 1 })
      .where("session_id", "=", sids[0])
      .execute();
    await storage.kysely
      .updateTable("idempotency")
      .set({ created_at: before })
      .where("session_id", "=", sids[1])
      .execute();
    await storage.kysely
      .updateTable("idempotency")
      .set({ created_at: before + 1 })
      .where("session_id", "=", sids[2])
      .execute();

    const deleted = await repo.prune(before);
    expect(deleted).toBe(1);
    expect(await repo.get(sids[0], "before-1")).toBeNull();
    expect(await repo.get(sids[1], "at-before")).toEqual({ status: "completed" });
    expect(await repo.get(sids[2], "after-before")).toEqual({ status: "completed" });
  });
});