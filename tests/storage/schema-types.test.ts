// Schema 类型推导测试（工作包 B）——编译期/类型层验证：
// - DatabaseSchema 完全由 schemaManifest 推导：列名、nullable、逻辑类型→TS 类型
//   （uuid/text/json → string；integer/bigint → number）；nullable 列带 | null。
// - 推导出的 DatabaseSchema 可直接用于 Kysely 真实查询（select/where/orderBy/insert）。
// - 负向（@ts-expect-error）：非法 Manifest（FK 目标不存在/目标列不存在/主键或索引引用未知列，
//   以及新增：主键列不可 nullable、FK 源/目标列数不等或空源列、boolean default）
//   与错误的派生类型赋值必须编译失败；若对应行没有报错，tsc 会报 unused @ts-expect-error。
//   这些负向语句放入不会被调用的函数，避免在测试运行期执行非法 SQL。
//
// 说明：`volta run pnpm build`（tsc -p tsconfig.build.json）只编译 src/；本文件的类型断言
// 由 `npx tsc --noEmit -p tsconfig.json`（含 src+tests）完整检查。expectTypeOf 在运行期为
// no-op，vitest 用例也会通过。

import { describe, it, expect } from "vitest";
import { expectTypeOf } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { schemaManifest, defineSchema } from "../../src/storage/schema-manifest.js";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";

describe("Schema 类型推导（DatabaseSchema 由 Manifest 推导）", () => {
  it("逻辑类型映射：uuid/text/json → string；integer → number；nullable → | null", () => {
    expectTypeOf<DatabaseSchema["projects"]["id"]>().toEqualTypeOf<string>();
    expectTypeOf<DatabaseSchema["projects"]["name"]>().toEqualTypeOf<string>();
    expectTypeOf<DatabaseSchema["projects"]["owner_key"]>().toEqualTypeOf<string>();
    expectTypeOf<DatabaseSchema["projects"]["created_at"]>().toEqualTypeOf<number>();

    expectTypeOf<DatabaseSchema["sessions"]["project_id"]>().toEqualTypeOf<string>();
    expectTypeOf<DatabaseSchema["sessions"]["updated_at"]>().toEqualTypeOf<number>();
    expectTypeOf<DatabaseSchema["sessions"]["pi_session_file"]>().toEqualTypeOf<string | null>();
    expectTypeOf<DatabaseSchema["sessions"]["model_provider"]>().toEqualTypeOf<string | null>();
    expectTypeOf<DatabaseSchema["sessions"]["capability_versions"]>().toEqualTypeOf<string | null>();

    expectTypeOf<DatabaseSchema["idempotency"]["session_id"]>().toEqualTypeOf<string>();
    expectTypeOf<DatabaseSchema["idempotency"]["request_id"]>().toEqualTypeOf<string>();
    expectTypeOf<DatabaseSchema["idempotency"]["result"]>().toEqualTypeOf<string>();
    expectTypeOf<DatabaseSchema["idempotency"]["created_at"]>().toEqualTypeOf<number>();
  });

  it("整表形状（列名与顺序、nullability）与历史手工 interface 完全一致", () => {
    type ExpectedSessions = {
      id: string;
      owner_key: string;
      project_id: string;
      title: string;
      created_at: number;
      updated_at: number;
      pi_session_file: string | null;
      model_provider: string | null;
      model_id: string | null;
      thinking_level: string | null;
      system_prompt: string | null;
      capability_versions: string | null;
    };
    expectTypeOf<DatabaseSchema["sessions"]>().toEqualTypeOf<ExpectedSessions>();
    expectTypeOf<keyof DatabaseSchema["sessions"]>().toEqualTypeOf<keyof ExpectedSessions>();

    type ExpectedProjects = {
      id: string;
      name: string;
      cwd: string;
      owner_key: string;
      created_at: number;
    };
    expectTypeOf<DatabaseSchema["projects"]>().toEqualTypeOf<ExpectedProjects>();
    expectTypeOf<DatabaseSchema["idempotency"]>().toEqualTypeOf<{
      session_id: string;
      request_id: string;
      result: string;
      created_at: number;
    }>();
  });

  it("Manifest 值保留字面量：表名与列名可直接做 keyof 约束（推导的依据）", () => {
    type TableNames = (typeof schemaManifest)["tables"][number]["name"];
    expectTypeOf<TableNames>().toEqualTypeOf<"projects" | "sessions" | "idempotency">();
    expectTypeOf<keyof DatabaseSchema>().toEqualTypeOf<TableNames>();

    // 列名来自 Manifest（而非手写表 interface）
    type ProjectColumns = Extract<(typeof schemaManifest)["tables"][number], { name: "projects" }>["columns"][number]["name"];
    expectTypeOf<ProjectColumns>().toEqualTypeOf<"id" | "name" | "cwd" | "owner_key" | "created_at">();
  });

  it("推导出的 DatabaseSchema 可用于 Kysely 真实查询（insert/select/where/orderBy）", async () => {
    const db = new DatabaseSync(":memory:");
    const kysely = await initializeDatabase(db);

    await kysely
      .insertInto("projects")
      .values({ id: "p-1", name: "P", cwd: "/p", owner_key: "o", created_at: 1 })
      .execute();
    await kysely
      .insertInto("sessions")
      .values({
        id: "s-1",
        owner_key: "o",
        project_id: "p-1",
        title: "t",
        created_at: 1,
        updated_at: 1,
        pi_session_file: null,
        model_provider: null,
        model_id: null,
        thinking_level: null,
        system_prompt: null,
        capability_versions: null,
      })
      .execute();

    const row = await kysely
      .selectFrom("sessions")
      .selectAll()
      .where("owner_key", "=", "o")
      .where("created_at", "<=", Date.now())
      .orderBy("updated_at", "desc")
      .executeTakeFirst();

    expectTypeOf(row).toEqualTypeOf<DatabaseSchema["sessions"] | undefined>();
    expectTypeOf(row?.id).toEqualTypeOf<string | undefined>();
    expectTypeOf(row?.updated_at).toEqualTypeOf<number | undefined>();
    expectTypeOf(row?.pi_session_file).toEqualTypeOf<string | null | undefined>();
    expect(row?.title).toBe("t");

    await kysely.destroy();
  });
});

/** 编译期负向断言：下述语句必须各自产生类型错误。只做类型检查，绝不在运行期执行。 */
function neverCalledCompileTimeNegatives(): void {
  declareDbGuard();

  // ---------- 非法 Manifest（编译期校验拒绝） ----------
  // @ts-expect-error FK 目标表不存在
  defineSchema([
    { name: "a", columns: [{ name: "id", type: "uuid", nullable: false }], primaryKey: { columns: ["id"] }, foreignKeys: [{ constraintName: "fk", columns: ["id"], targetTable: "missing_table", targetColumns: ["id"], onDelete: "cascade" }], indexes: [] },
  ]);

  // @ts-expect-error FK 目标列不存在
  defineSchema([
    { name: "a", columns: [{ name: "id", type: "uuid", nullable: false }], primaryKey: { columns: ["id"] }, foreignKeys: [], indexes: [] },
    { name: "b", columns: [{ name: "id", type: "uuid", nullable: false }], primaryKey: { columns: ["id"] }, foreignKeys: [{ constraintName: "fk", columns: ["id"], targetTable: "a", targetColumns: ["missing_col"], onDelete: "cascade" }], indexes: [] },
  ]);

  // @ts-expect-error 主键引用未知列
  defineSchema([
    { name: "a", columns: [{ name: "id", type: "uuid", nullable: false }], primaryKey: { columns: ["missing"] }, foreignKeys: [], indexes: [] },
  ]);

  // @ts-expect-error 索引引用未知列
  defineSchema([
    { name: "a", columns: [{ name: "id", type: "uuid", nullable: false }], primaryKey: { columns: ["id"] }, foreignKeys: [], indexes: [{ name: "idx", columns: [{ name: "missing" }] }] },
  ]);

  // ---------- 新增约束的编译期负向（M1/M2/M4 修正） ----------
  // @ts-expect-error 主键列不可 nullable（M1）
  defineSchema([
    { name: "a", columns: [{ name: "id", type: "uuid", nullable: true }], primaryKey: { columns: ["id"] }, foreignKeys: [], indexes: [] },
  ]);

  // @ts-expect-error FK 源/目标列数不等：1 列 → 2 列（M2）
  defineSchema([
    { name: "a", columns: [{ name: "id", type: "uuid", nullable: false }, { name: "name", type: "text", nullable: false }], primaryKey: { columns: ["id"] }, foreignKeys: [], indexes: [] },
    { name: "b", columns: [{ name: "id", type: "uuid", nullable: false }], primaryKey: { columns: ["id"] }, foreignKeys: [{ constraintName: "fk", columns: ["id"], targetTable: "a", targetColumns: ["id", "name"], onDelete: "cascade" }], indexes: [] },
  ]);

  // @ts-expect-error FK 必须声明至少一个源列（M2）
  defineSchema([
    { name: "a", columns: [{ name: "id", type: "uuid", nullable: false }], primaryKey: { columns: ["id"] }, foreignKeys: [], indexes: [] },
    { name: "b", columns: [{ name: "id", type: "uuid", nullable: false }], primaryKey: { columns: ["id"] }, foreignKeys: [{ constraintName: "fk", columns: [], targetTable: "a", targetColumns: ["id"], onDelete: "cascade" }], indexes: [] },
  ]);

  // @ts-expect-error boolean 不是合法 default 字面量（无 boolean 逻辑类型，M4）
  defineSchema([{ name: "a", columns: [{ name: "id", type: "uuid", nullable: false, default: true }], primaryKey: { columns: ["id"] }, foreignKeys: [], indexes: [] }]);

  // ---------- 派生类型被误用（nullability / 逻辑类型） ----------
  // @ts-expect-error title 是非空列，不能赋 null
  const badSession: DatabaseSchema["sessions"] = { id: "x", owner_key: "o", project_id: DEFAULT_PROJECT_ID, title: null, created_at: 1, updated_at: 1, pi_session_file: null, model_provider: null, model_id: null, thinking_level: null, system_prompt: null, capability_versions: null };

  // @ts-expect-error created_at 是 number，不能赋 string
  const badProject: DatabaseSchema["projects"] = { id: "x", name: "n", cwd: "/c", owner_key: "o", created_at: "not-a-number" };

  // ---------- Kysely 查询键/类型的真实检查 ----------
  // @ts-expect-error sessions 不存在 `missing_col` 列
  const q1 = db.selectFrom("sessions").select("missing_col");

  // @ts-expect-error created_at 是 number，比较值必须可比较
  const q2 = db.selectFrom("sessions").where("created_at", "=", "abc");

  void badSession;
  void badProject;
  void q1;
  void q2;
}

// 避免在负向函数体内重复声明；类型仅用于编译期检查。
declare const db: Kysely<DatabaseSchema>;
function declareDbGuard(): void {
  void db;
}