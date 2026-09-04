// Manifest → 方言 DDL builder 单测（工作包 C，无需真实数据库）：
// - SQLite / PG 逻辑类型映射的完整性与正确性（同一个 Manifest、两套物理类型）；
// - 用 spy Kysely 捕获 bootstrapSchemaFromManifest / createTableFromManifest /
//   createIndexFromManifest 的 DDL 调用流：表顺序、列（类型/notNull/default/列级主键）、
//   复合主键、外键（名/列/目标/onDelete）、索引（名/列/desc 排序/unique）、PK 防御性 notNull。
// 真实建库行为（PRAGMA / information_schema）分别由 SQLite 契约测试与 PG 集成测试覆盖。

import { describe, it, expect } from "vitest";
import type { Kysely } from "kysely";
import { bootstrapSchemaFromManifest, createTableFromManifest } from "../../src/storage/schema-builder.js";
import { SQLITE_LOGICAL_TYPE } from "../../src/storage/bootstrap.js";
import { POSTGRES_LOGICAL_TYPE } from "../../src/storage/postgres-bootstrap.js";
import { schemaManifest, LOGICAL_COLUMN_TYPES, type TableManifest } from "../../src/storage/schema-manifest.js";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";

// ---------------------------------------------------------------------------
// spy Kysely：记录 schema builder 调用流，不触碰任何真实数据库。
// ---------------------------------------------------------------------------

interface SpyColumn {
  name: string;
  type: string;
  notNull: boolean;
  default: unknown;
  inlinePk: boolean;
}
interface SpyFk {
  name: string;
  columns: string[];
  target: string;
  targetColumns: string[];
  onDelete: string | undefined;
}
interface SpyTable {
  name: string;
  columns: SpyColumn[];
  pkConstraint: { name: string; columns: string[] } | null;
  fks: SpyFk[];
}
interface SpyIndex {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
}

function createSpyKysely(): { kysely: Kysely<DatabaseSchema>; tables: SpyTable[]; indexes: SpyIndex[] } {
  const tables: SpyTable[] = [];
  const indexes: SpyIndex[] = [];

  function columnDefBuilder(def: SpyColumn) {
    const b = {
      notNull() {
        def.notNull = true;
        return b;
      },
      defaultTo(value: unknown) {
        def.default = value;
        return b;
      },
      primaryKey() {
        def.inlinePk = true;
        return b;
      },
    };
    return b;
  }

  function createTable(name: string) {
    const table: SpyTable = { name, columns: [], pkConstraint: null, fks: [] };
    const builder = {
      ifNotExists() {
        return builder;
      },
      addColumn(columnName: string, type: string, cb: (col: unknown) => unknown) {
        const def: SpyColumn = { name: columnName, type, notNull: false, default: undefined, inlinePk: false };
        cb(columnDefBuilder(def));
        table.columns.push(def);
        return builder;
      },
      addPrimaryKeyConstraint(constraintName: string, columns: string[]) {
        table.pkConstraint = { name: constraintName, columns };
        return builder;
      },
      addForeignKeyConstraint(
        constraintName: string,
        columns: string[],
        targetTable: string,
        targetColumns: string[],
        cb: (fkCb: { onDelete: (action: string) => unknown }) => unknown,
      ) {
        const fk: SpyFk = { name: constraintName, columns, target: targetTable, targetColumns, onDelete: undefined };
        cb({ onDelete(action) { fk.onDelete = action; return {}; } });
        table.fks.push(fk);
        return builder;
      },
      execute() {
        tables.push(table);
        return Promise.resolve();
      },
    };
    return builder;
  }

  function createIndex(name: string) {
    const index: SpyIndex = { name, table: "", columns: [], unique: false };
    const builder = {
      ifNotExists() {
        return builder;
      },
      on(tableName: string) {
        index.table = tableName;
        return builder;
      },
      unique() {
        index.unique = true;
        return builder;
      },
      columns(columns: string[]) {
        index.columns = columns;
        return builder;
      },
      execute() {
        indexes.push(index);
        return Promise.resolve();
      },
    };
    return builder;
  }

  return {
    kysely: { schema: { createTable, createIndex } } as unknown as Kysely<DatabaseSchema>,
    tables,
    indexes,
  };
}

/** 断言两个方言映射都覆盖且仅覆盖全部逻辑类型（键集合与 union 一致）。 */
function expectTypeMapKeys(map: Record<string, string>): void {
  expect(Object.keys(map).sort()).toEqual([...LOGICAL_COLUMN_TYPES].sort());
}

describe("逻辑列类型 → 方言物理类型映射（同一 Manifest，SQLite 保持既有行为，PG 按确认设计）", () => {
  it("SQLite：uuid/text/json → text、integer/bigint → integer", () => {
    expectTypeMapKeys(SQLITE_LOGICAL_TYPE);
    expect(SQLITE_LOGICAL_TYPE).toEqual({
      uuid: "text",
      text: "text",
      integer: "integer",
      bigint: "integer",
      json: "text",
    });
  });

  it("PG：uuid → uuid、text/json → text、integer/bigint → bigint（JSON 保持 TEXT，非 JSONB）", () => {
    expectTypeMapKeys(POSTGRES_LOGICAL_TYPE);
    expect(POSTGRES_LOGICAL_TYPE).toEqual({
      uuid: "uuid",
      text: "text",
      integer: "bigint",
      bigint: "bigint",
      json: "text",
    });
  });
});

describe("bootstrapSchemaFromManifest（spy Kysely，PG 类型映射）", () => {
  it("按 Manifest 顺序建 4 张表：列物理类型（uuid/text→TEXT 同构、integer→BIGINT、json→TEXT）、FK、复合主键、索引", async () => {
    const { kysely, tables, indexes } = createSpyKysely();
    await bootstrapSchemaFromManifest(kysely, POSTGRES_LOGICAL_TYPE);

    expect(tables.map((t) => t.name)).toEqual(["projects", "sessions", "idempotency", "file_operations"]);

    const projects = tables[0]!;
    expect(projects.columns).toEqual([
      { name: "id", type: "uuid", notNull: true, default: undefined, inlinePk: true },
      { name: "name", type: "text", notNull: true, default: undefined, inlinePk: false },
      { name: "cwd", type: "text", notNull: true, default: undefined, inlinePk: false },
      { name: "owner_key", type: "text", notNull: true, default: undefined, inlinePk: false },
      { name: "created_at", type: "bigint", notNull: true, default: undefined, inlinePk: false },
    ]);
    // 单列未命名主键 → 列级 primaryKey()（PG 侧即默认约束 <table>_pkey）
    expect(projects.pkConstraint).toBeNull();
    expect(projects.fks).toEqual([]);

    const sessions = tables[1]!;
    expect(sessions.columns.map((c) => [c.name, c.type, c.notNull])).toEqual([
      ["id", "uuid", true],
      ["owner_key", "text", true],
      ["project_id", "uuid", true],
      ["title", "text", true],
      ["created_at", "bigint", true],
      ["updated_at", "bigint", true],
      ["pi_session_file", "text", false],
      ["model_provider", "text", false],
      ["model_id", "text", false],
      ["thinking_level", "text", false],
      ["system_prompt", "text", false],
      ["capability_versions", "text", false], // json → TEXT（非 JSONB）
    ]);
    // project_id 默认值引用 DEFAULT_PROJECT_ID 常量（PG 侧 uuid 列 default 为字面量字符串）
    expect(sessions.columns.find((c) => c.name === "project_id")!.default).toBe(DEFAULT_PROJECT_ID);
    expect(sessions.fks).toEqual([
      {
        name: "sessions_project_id_fk",
        columns: ["project_id"],
        target: "projects",
        targetColumns: ["id"],
        onDelete: "cascade",
      },
    ]);

    const idempotency = tables[2]!;
    // 复合主键 → 命名约束 idempotency_pk
    expect(idempotency.pkConstraint).toEqual({ name: "idempotency_pk", columns: ["session_id", "request_id"] });
    expect(idempotency.columns.map((c) => [c.name, c.type])).toEqual([
      ["session_id", "uuid"],
      ["request_id", "text"], // request_id 保持 TEXT
      ["result", "text"], // json → TEXT（非 JSONB）
      ["created_at", "bigint"],
    ]);

    // 6 个索引：名称/表/列（含 updated_at DESC）/unique
    expect(indexes.map((i) => [i.name, i.table, i.columns, i.unique])).toEqual([
      ["idx_projects_owner", "projects", ["owner_key"], false],
      ["idx_sessions_owner_updated", "sessions", ["owner_key", "updated_at desc"], false],
      ["idx_sessions_owner_project", "sessions", ["owner_key", "project_id"], false],
      ["idx_idempotency_created_at", "idempotency", ["created_at"], false],
      ["idx_file_operations_key", "file_operations", ["operation_key"], true],
      ["idx_file_operations_claim", "file_operations", ["state", "available_at"], false],
    ]);
  });

  it("SQLite 类型映射下同一 Manifest 生成既有物理类型（uuid/text/json → text、integer → integer）", async () => {
    const { kysely, tables } = createSpyKysely();
    await bootstrapSchemaFromManifest(kysely, SQLITE_LOGICAL_TYPE);
    expect(tables[0]!.columns.map((c) => [c.name, c.type])).toEqual([
      ["id", "text"],
      ["name", "text"],
      ["cwd", "text"],
      ["owner_key", "text"],
      ["created_at", "integer"],
    ]);
    expect(tables[2]!.columns.map((c) => [c.name, c.type])).toEqual([
      ["session_id", "text"],
      ["request_id", "text"],
      ["result", "text"],
      ["created_at", "integer"],
    ]);
  });
});

describe("createTableFromManifest 防御性 PK notNull（schema-builder 方言无关；对 PG 映射同样生效）", () => {
  it("PK 列即使声明 nullable 也建为 NOT NULL + 列级主键（校验被绕过时的防线）", async () => {
    const pkNullable: TableManifest = {
      name: "t_pk_defense",
      columns: [{ name: "id", type: "uuid", nullable: true }],
      primaryKey: { columns: ["id"] },
      foreignKeys: [],
      indexes: [],
    };
    const { kysely, tables } = createSpyKysely();
    await createTableFromManifest(kysely, pkNullable, POSTGRES_LOGICAL_TYPE);
    const table = tables.find((t) => t.name === "t_pk_defense")!;
    const col = table.columns.find((c) => c.name === "id")!;
    expect(col.notNull).toBe(true); // PK 恒 NOT NULL
    expect(col.inlinePk).toBe(true); // 且为单列主键（PG 默认约束 <table>_pkey）
    expect(col.type).toBe("uuid");
  });

  it("非 PK 可空列不强制 notNull（PG 映射下的 nullable 语义）", async () => {
    const { kysely, tables } = createSpyKysely();
    await bootstrapSchemaFromManifest(kysely, POSTGRES_LOGICAL_TYPE);
    const sessions = tables.find((t) => t.name === "sessions")!;
    expect(sessions.columns.find((c) => c.name === "pi_session_file")!.notNull).toBe(false);
    expect(sessions.columns.find((c) => c.name === "id")!.notNull).toBe(true);
  });

  it("Manifest 声明仍是唯一来源：schemaManifest 表/索引数量与 DDL builder 消费的完全一致", () => {
    const manifest = schemaManifest.tables;
    expect(manifest).toHaveLength(4);
    const indexCount = manifest.reduce((n, t) => n + (t.indexes?.length ?? 0), 0);
    expect(indexCount).toBe(6);
  });
});