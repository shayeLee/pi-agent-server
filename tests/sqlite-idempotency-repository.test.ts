import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initStorage } from "./helpers/sqlite.js";

describe("SqliteIdempotencyRepository（needs.md §4.2 requestId 去重持久化）", () => {
  it("put 后 get 返回结果", async () => {
    const repo = (await initStorage(new DatabaseSync(":memory:"))).idempotency;
    await repo.put("s1", "r1", { status: "completed" });
    expect(await repo.get("s1", "r1")).toEqual({ status: "completed" });
  });

  it("get 不存在返回 null", async () => {
    const repo = (await initStorage(new DatabaseSync(":memory:"))).idempotency;
    expect(await repo.get("s1", "nope")).toBeNull();
  });

  it("put 重复覆盖同一 requestId（幂等，不重复执行语义）", async () => {
    const repo = (await initStorage(new DatabaseSync(":memory:"))).idempotency;
    await repo.put("s1", "r1", { status: "completed" });
    await repo.put("s1", "r1", { status: "completed-2" });
    expect(await repo.get("s1", "r1")).toEqual({ status: "completed-2" });
  });

  it("prune 删除 before 之前的记录", async () => {
    const repo = (await initStorage(new DatabaseSync(":memory:"))).idempotency;
    await repo.put("s1", "r1", { status: "completed" });
    await new Promise((r) => setTimeout(r, 10));
    await repo.prune(Date.now());
    expect(await repo.get("s1", "r1")).toBeNull();
  });
});
