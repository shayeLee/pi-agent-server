// NodeSqliteAdapter：Kysely SqliteDialect 所期待 Statement 签名的薄适配层。
// 关键点：StatementSync 是可变参数，Kysely 传数组 → 展开；reader 由 stmt.columns().length > 0 可靠判定
// （覆盖 SELECT、WITH … SELECT、所有 … RETURNING，以及普通写/DDL 返回 []）。

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Kysely, SqliteDialect } from "kysely";
import { NodeSqliteAdapter } from "../../src/storage/node-sqlite-adapter.js";

type TestSchema = { t: { a: number; b: string } };

function makeKysely(db: DatabaseSync): Kysely<TestSchema> {
  return new Kysely({ dialect: new SqliteDialect({ database: new NodeSqliteAdapter(db) }) });
}

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (a INTEGER, b TEXT)");
  return db;
}

describe("NodeSqliteAdapter（Kysely ↔ node:sqlite 兼容层）", () => {
  it("reader 判定：SELECT / WITH SELECT / RETURNING 为 true，普通写与 DDL 为 false", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (a INTEGER, b TEXT)");
    const adapter = new NodeSqliteAdapter(db);
    const readerOf = (sqlText: string) => adapter.prepare(sqlText).reader;

    expect(readerOf("SELECT * FROM t")).toBe(true);
    expect(readerOf("WITH x AS (SELECT 1 AS v) SELECT v FROM x")).toBe(true);
    expect(readerOf("INSERT INTO t (a, b) VALUES (1, 'x') RETURNING a, b")).toBe(true);
    expect(readerOf("UPDATE t SET b = 'y' WHERE a = 1 RETURNING a")).toBe(true);
    expect(readerOf("DELETE FROM t WHERE a = 999 RETURNING a")).toBe(true);
    expect(readerOf("INSERT INTO t (a, b) VALUES (1, 'x')")).toBe(false);
    expect(readerOf("UPDATE t SET b = 'y'")).toBe(false);
    expect(readerOf("DELETE FROM t WHERE a = 999")).toBe(false);
    expect(readerOf("CREATE TABLE t2 (x INTEGER)")).toBe(false);
    db.close();
  });

  it("带参数 SELECT：展开数组参数并返回行", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(1, "one");
    const kysely = makeKysely(db);
    const rows = await kysely.selectFrom("t").selectAll().where("a", "=", 1).execute();
    expect(rows).toEqual([{ a: 1, b: "one" }]);
    db.close();
  });

  it("WITH … SELECT：返回列（reader）并正确取值", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(7, "seven");
    const kysely = makeKysely(db);
    const rows = await kysely
      .with("x", (qb) => qb.selectFrom("t").select("a"))
      .selectFrom("x")
      .selectAll()
      .execute();
    expect(rows).toEqual([{ a: 7 }]);
    db.close();
  });

  it("INSERT … RETURNING：返回插入行而非改动结果", async () => {
    const db = makeDb();
    const kysely = makeKysely(db);
    const row = await kysely
      .insertInto("t")
      .values({ a: 3, b: "three" })
      .returning(["a", "b"])
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ a: 3, b: "three" });
    // 真实写已生效
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 1 });
    db.close();
  });

  it("普通写（INSERT / UPDATE / DELETE）走 run 分支，changes 正确", async () => {
    const db = makeDb();
    const kysely = makeKysely(db);
    await kysely.insertInto("t").values({ a: 1, b: "x" }).execute();
    const up = await kysely.updateTable("t").set({ b: "y" }).where("a", "=", 1).executeTakeFirst();
    expect(Number(up.numUpdatedRows)).toBe(1);
    const del = await kysely.deleteFrom("t").where("a", "=", 1).executeTakeFirst();
    expect(Number(del.numDeletedRows)).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 0 });
    db.close();
  });

  it("destroy 经 adapter 真正关闭底层 DatabaseSync", async () => {
    const db = makeDb();
    const kysely = makeKysely(db);
    // 先执行一条查询，确保 driver 已初始化（SqliteDriver.init 是惰性的，destroy 前 #db 才被设置）
    await kysely.selectFrom("t").selectAll().execute();
    await kysely.destroy();
    expect(() => db.prepare("SELECT 1")).toThrow();
  });
});
