import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SqliteIdempotencyRepository } from "../src/storage/sqlite-idempotency-repository.js";

describe("SqliteIdempotencyRepository（README §4.2 requestId 去重持久化）", () => {
  it("put 后 get 返回结果", async () => {
    const repo = new SqliteIdempotencyRepository(new DatabaseSync(":memory:"));
    await repo.put("s1", "r1", { status: "completed" });
    expect(await repo.get("s1", "r1")).toEqual({ status: "completed" });
  });

  it("get 不存在返回 null", async () => {
    const repo = new SqliteIdempotencyRepository(new DatabaseSync(":memory:"));
    expect(await repo.get("s1", "nope")).toBeNull();
  });

  it("旧表无 created_at 列时自动迁移，旧记录不被启动 prune 立即删除", async () => {
    const db = new DatabaseSync(":memory:");
    // 构造旧 schema（无 created_at 列）
    db.exec(`
      CREATE TABLE idempotency (
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (session_id, request_id)
      );
    `);
    db.prepare("INSERT INTO idempotency (session_id, request_id, result) VALUES (?, ?, ?)").run(
      "s1",
      "r1",
      JSON.stringify({ status: "completed" }),
    );

    const migrateAt = Date.now();
    const repo = new SqliteIdempotencyRepository(db); // 触发迁移

    // 列已补
    const cols = db.prepare("PRAGMA table_info(idempotency)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "created_at")).toBe(true);

    // 旧记录仍命中（created_at = 迁移时刻，而非 0）
    expect(await repo.get("s1", "r1")).toEqual({ status: "completed" });

    // 迁移时刻之前的 prune 不删旧记录（避免升级期幂等失效）
    await repo.prune(migrateAt - 1);
    expect(await repo.get("s1", "r1")).toEqual({ status: "completed" });
  });

  it("prune 删除 before 之前的记录", async () => {
    const repo = new SqliteIdempotencyRepository(new DatabaseSync(":memory:"));
    await repo.put("s1", "r1", { status: "completed" });
    await new Promise((r) => setTimeout(r, 10));
    await repo.prune(Date.now());
    expect(await repo.get("s1", "r1")).toBeNull();
  });
});
