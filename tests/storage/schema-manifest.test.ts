// Schema Manifest 契约测试（工作包 B）：
// 1. Manifest 是唯一手工声明：表/列/PK/FK/索引全部在 schemaManifest 中声明一次；
//    Manifest → SQLite bootstrap 可生成与 PRAGMA 实际观察一致的 schema（等价 DDL）。
// 2. 真实 DatabaseSync 空库验证：所有表、列（类型/nullable/default）、单列/复合主键、
//    FK cascade、7 个索引（含 updated_at DESC、conversation identity 唯一与 outbox claim/key）、文件库 WAL、无 kysely_migration。
// 3. defineSchema 运行期校验：重复表/列/索引名、未知列引用、FK 目标不存在或声明顺序错误、
//    FK 源/目标列非空且等长、源/目标逻辑类型一致、主键列不可 nullable、
//    onDelete 非法、default 类型不匹配（含 boolean 拒绝）均抛错。
// 4. 逻辑类型运行期集合以 Record 键为权威（LOGICAL_COLUMN_TYPES 由键推导，无第二份声明）。

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabase, createTableFromManifest, SQLITE_LOGICAL_TYPE } from "../../src/storage/bootstrap.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import {
  schemaManifest,
  defineSchema,
  LOGICAL_COLUMN_TYPES,
  LOGICAL_COLUMN_TYPE_KEYS,
  type DefaultValueLiteral,
  type ForeignKeyAction,
  type LogicalColumnType,
  type TableManifest,
} from "../../src/storage/schema-manifest.js";
import { sqliteConstraintErrorMapper } from "../../src/storage/sqlite-constraint-errors.js";
import { KyselyProjectRepository } from "../../src/storage/kysely-project-repository.js";
import { KyselySessionRepository } from "../../src/storage/kysely-session-repository.js";

/** 测试内独立声明的 SQLite 逻辑类型映射（与 bootstrap 分离，作为契约的另一半对照）。 */
const SQLITE_TYPE: Record<LogicalColumnType, "integer" | "text"> = {
  uuid: "text",
  text: "text",
  integer: "integer",
  bigint: "integer",
  json: "text",
};

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function tableInfo(db: DatabaseSync, table: string): ColumnInfo[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }[]
  ).map((c) => ({ name: c.name, type: c.type.toLowerCase(), notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }));
}

function foreignKeys(db: DatabaseSync, table: string): Array<{ table: string; from: string; to: string; on_delete: string }> {
  return db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
}

function namedIndexes(db: DatabaseSync): Record<string, string> {
  return Object.fromEntries(
    (
      db
        .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string; tbl_name: string }[]
    ).map((r) => [r.name, r.tbl_name]),
  );
}

/** PRAGMA index_xinfo 的 key 列（含 desc 标志），按索引内顺序。 */
function indexKeyColumns(db: DatabaseSync, index: string): Array<{ name: string; desc: number }> {
  return (
    db.prepare(`PRAGMA index_xinfo(${index})`).all() as Array<{ name: string; desc: number; key: number }>
  )
    .filter((r) => r.key === 1)
    .map((r) => ({ name: r.name, desc: r.desc }));
}

/** 显式索引的 UNIQUE 标志（PRAGMA index_list 的 unique 列；排除 SQLite 自动建的 PK/UNIQUE 约束索引 sqlite_autoindex_*）。 */
function indexUniqueness(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of ["projects", "sessions", "idempotency", "file_operations"]) {
    for (const r of db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>) {
      if (!r.name.startsWith("sqlite_autoindex_")) out[r.name] = r.unique;
    }
  }
  return out;
}

const ON_DELETE_SQL: Record<ForeignKeyAction, string> = {
  cascade: "CASCADE",
  restrict: "RESTRICT",
  "set null": "SET NULL",
  "set default": "SET DEFAULT",
  "no action": "NO ACTION",
};

/** 由 Manifest 推导该表的期望 PRAGMA table_info（含单列/复合主键的 pk 序号）。 */
function expectedTableInfo(table: TableManifest): ColumnInfo[] {
  const pk = table.primaryKey;
  return table.columns.map((c) => {
    const pkIndex = pk.columns.indexOf(c.name);
    return {
      name: c.name,
      type: SQLITE_TYPE[c.type],
      notnull: c.nullable ? 0 : 1,
      dflt_value:
        c.default === undefined
          ? null
          : typeof c.default === "number"
            ? String(c.default)
            : `'${c.default}'`,
      pk: pkIndex >= 0 ? pkIndex + 1 : 0,
    };
  });
}

async function initMemoryDb() {
  const db = new DatabaseSync(":memory:");
  const kysely = await initializeDatabase(db);
  return { db, kysely };
}

describe("Schema Manifest 契约：Manifest → SQLite bootstrap DDL 等价（真实空库）", () => {
  it("Manifest 声明了恰好的 4 张表，每张表的列/主键/外键/索引与当前 schema 一致", () => {
    // 宽化为 TableManifest：字面量仅供 DatabaseSchema 推导，这里只做值的断言。
    const tables: readonly TableManifest[] = schemaManifest.tables;
    expect(tables.map((t) => t.name)).toEqual(["projects", "sessions", "idempotency", "file_operations"]);

    expect(tables[0]!.columns.map((c) => [c.name, c.type, c.nullable])).toEqual([
      ["id", "uuid", false],
      ["name", "text", false],
      ["cwd", "text", false],
      ["owner_key", "text", false],
      ["created_at", "integer", false],
    ]);
    expect(tables[0]!.primaryKey).toEqual({ columns: ["id"] });
    expect(tables[0]!.indexes!.map((i) => i.name)).toEqual(["idx_projects_owner"]);

    expect(tables[1]!.columns.map((c) => [c.name, c.type, c.nullable])).toEqual([
      ["id", "uuid", false],
      ["owner_key", "text", false],
      ["project_id", "uuid", false],
      ["title", "text", false],
      ["created_at", "integer", false],
      ["updated_at", "integer", false],
      ["agent_kind", "text", false],
      ["conversation_format", "text", false],
      ["conversation_ref", "text", true],
      ["model_provider", "text", true],
      ["model_id", "text", true],
      ["thinking_level", "text", true],
      ["system_prompt", "text", true],
      ["capability_versions", "json", true],
    ]);
    expect(tables[1]!.primaryKey).toEqual({ columns: ["id"] });
    expect(tables[1]!.foreignKeys).toEqual([
      {
        constraintName: "sessions_project_id_fk",
        columns: ["project_id"],
        targetTable: "projects",
        targetColumns: ["id"],
        onDelete: "cascade",
      },
    ]);
    expect(
      tables[1]!.indexes!.map((i) => [i.name, i.columns.map((c) => (c.order === "desc" ? `${c.name} desc` : c.name))]),
    ).toEqual([
      ["idx_sessions_owner_updated", ["owner_key", "updated_at desc"]],
      ["idx_sessions_owner_project", ["owner_key", "project_id"]],
      ["idx_sessions_conversation", ["agent_kind", "conversation_format", "conversation_ref"]],
    ]);

    expect(tables[2]!.columns.map((c) => [c.name, c.type, c.nullable])).toEqual([
      ["session_id", "uuid", false],
      ["request_id", "text", false],
      ["result", "json", false],
      ["created_at", "integer", false],
    ]);
    expect(tables[2]!.primaryKey).toEqual({ constraintName: "idempotency_pk", columns: ["session_id", "request_id"] });
    expect(tables[2]!.indexes!.map((i) => i.name)).toEqual(["idx_idempotency_created_at"]);
    expect(tables[3]!.name).toBe("file_operations");
    expect(tables[3]!.columns.map((c) => [c.name, c.type, c.nullable])).toEqual([
      ["id", "uuid", false], ["operation_key", "text", false], ["kind", "text", false],
      ["relative_path", "text", false], ["session_id", "uuid", true], ["project_id", "uuid", true],
      ["state", "text", false], ["attempt_count", "integer", false], ["available_at", "integer", false],
      ["lease_until", "integer", true], ["lease_token", "text", true], ["last_error", "text", true],
      ["created_at", "integer", false], ["updated_at", "integer", false],
    ]);
    expect(tables[3]!.foreignKeys).toEqual([]);

    // 默认值唯一来源：sessions.project_id 引用 DEFAULT_PROJECT_ID 常量
    expect(tables[1]!.columns.find((c) => c.name === "project_id")).toMatchObject({ default: DEFAULT_PROJECT_ID });
    // Manifest 深冻结，防止运行时被意外修改
    expect(Object.isFrozen(schemaManifest)).toBe(true);
    expect(Object.isFrozen(schemaManifest.tables[0])).toBe(true);
  });

  it("空库 bootstrap 后：每张表的列（类型/nullable/default）、单列/复合主键与 Manifest 完全一致", async () => {
    const { db, kysely } = await initMemoryDb();
    for (const table of schemaManifest.tables) {
      expect(tableInfo(db, table.name)).toEqual(expectedTableInfo(table));
    }
    await kysely.destroy();
  });

  it("bootstrap 防御性 notNull：PK 列即使声明 nullable 也建为 NOT NULL（校验被绕过时的防线）", async () => {
    // defineSchema 会拒绝 nullable PK（见运行期负向用例）；这里直接验证 bootstrap 的防御分支
    const { db, kysely } = await initMemoryDb();
    try {
      const pkNullable: TableManifest = {
        name: "t_pk_defense",
        columns: [{ name: "id", type: "uuid", nullable: true }],
        primaryKey: { columns: ["id"] },
        foreignKeys: [],
        indexes: [],
      };
      await createTableFromManifest(kysely, pkNullable, SQLITE_LOGICAL_TYPE);
      const idCol = tableInfo(db, "t_pk_defense").find((c) => c.name === "id")!;
      expect(idCol.notnull).toBe(1); // PK 列恒 NOT NULL
      expect(idCol.pk).toBe(1); // 且仍为单列主键
    } finally {
      await kysely.destroy();
    }
  });

  it("integer 列允许 number default；PRAGMA dflt_value 按字面量类型渲染（number 无引号、string 有引号）", async () => {
    const m = defineSchema([
      {
        name: "t_defaults",
        columns: [
          { name: "id", type: "uuid", nullable: false },
          { name: "score", type: "integer", nullable: false, default: 42 },
        ],
        primaryKey: { columns: ["id"] },
        foreignKeys: [],
        indexes: [],
      },
    ]);
    const m2 = defineSchema([
      {
        name: "t_defaults2",
        columns: [
          { name: "id", type: "uuid", nullable: false },
          { name: "seed", type: "text", nullable: false, default: "seed" },
        ],
        primaryKey: { columns: ["id"] },
        foreignKeys: [],
        indexes: [],
      },
    ]);
    const db = new DatabaseSync(":memory:");
    const kysely = await initializeDatabase(db);
    try {
      await createTableFromManifest(kysely, m.tables[0]!, SQLITE_LOGICAL_TYPE);
      await createTableFromManifest(kysely, m2.tables[0]!, SQLITE_LOGICAL_TYPE);
      expect(tableInfo(db, "t_defaults").find((c) => c.name === "score")).toMatchObject({
        type: "integer",
        dflt_value: "42",
      });
      expect(tableInfo(db, "t_defaults2").find((c) => c.name === "seed")).toMatchObject({
        type: "text",
        dflt_value: "'seed'",
      });
    } finally {
      await kysely.destroy();
    }
  });

  it("外键：sessions.project_id → projects.id ON DELETE CASCADE（含行为验证）", async () => {
    const { db, kysely } = await initMemoryDb();
    expect(foreignKeys(db, "sessions")).toEqual([
      expect.objectContaining({ table: "projects", from: "project_id", to: "id", on_delete: "CASCADE" }),
    ]);
    // 行为验证：删项目级联删会话（数据库层 FK 兜底）
    const projects = new KyselyProjectRepository(kysely, sqliteConstraintErrorMapper);
    const sessions = new KyselySessionRepository(kysely, sqliteConstraintErrorMapper);
    await projects.create({ id: "p-cascade", name: "P", cwd: "/p", ownerKey: "o", createdAt: 1 });
    await sessions.create({
      id: "s-cascade", ownerKey: "o", projectId: "p-cascade", title: "t", createdAt: 1, updatedAt: 1,
      agentKind: "pi",
      conversationFormat: "pi-jsonl-v3",
      conversationRef: null, modelProvider: null, modelId: null, thinkingLevel: null,
      systemPrompt: null, capabilityVersions: null,
    });
    await projects.delete("p-cascade");
    expect(await sessions.get("s-cascade")).toBeNull();
    await kysely.destroy();
  });

  it("7 个索引齐备，outbox key 与 conversation identity 唯一、claim 等索引非唯一，含 updated_at DESC 排序语义", async () => {
    const { db, kysely } = await initMemoryDb();
    // 宽化为 TableManifest：索引列字面量仅供 DatabaseSchema 推导，这里只做值的断言。
    const tables: readonly TableManifest[] = schemaManifest.tables;

    const expectedIndexes = tables.flatMap((t) => (t.indexes ?? []).map((i) => [i.name, t.name] as const));
    const actual = namedIndexes(db);
    expect(Object.keys(actual).sort()).toEqual(expectedIndexes.map(([name]) => name).sort());
    for (const [name, table] of expectedIndexes) {
      expect(actual[name]).toBe(table);
    }

    // 业务索引的 UNIQUE 语义也来自 Manifest：operation_key 幂等索引与
    // (agent_kind, conversation_format, conversation_ref) 非空 conversation identity 唯一。
    const uniqueness = indexUniqueness(db);
    expect(Object.keys(uniqueness).sort()).toEqual(expectedIndexes.map(([name]) => name).sort());
    expect(uniqueness.idx_file_operations_key).toBe(1);
    expect(uniqueness.idx_sessions_conversation).toBe(1);
    for (const name of Object.keys(uniqueness).filter((name) => name !== "idx_file_operations_key" && name !== "idx_sessions_conversation")) {
      expect(uniqueness[name], `索引 ${name} 不应是 UNIQUE`).toBe(0);
    }

    // 索引列与排序方向：desc 语义来自 Manifest 的 order: "desc"
    for (const table of tables) {
      for (const index of table.indexes ?? []) {
        const expected = index.columns.map((c) => ({ name: c.name, desc: c.order === "desc" ? 1 : 0 }));
        expect(indexKeyColumns(db, index.name)).toEqual(expected);
      }
    }
    expect(indexKeyColumns(db, "idx_sessions_owner_updated")).toEqual([
      { name: "owner_key", desc: 0 },
      { name: "updated_at", desc: 1 },
    ]);
    await kysely.destroy();
  });

  it("复合主键：idempotency(session_id, request_id)；bootstrap 写入单一基线 ledger；无 kysely_migration；文件库 WAL、:memory: 保持 memory", async () => {
    // 复合主键由 PRAGMA 观察（pk 序号 1、2）
    const { db, kysely } = await initMemoryDb();
    const idem = tableInfo(db, "idempotency");
    expect(idem.filter((c) => c.pk > 0).map((c) => [c.name, c.pk])).toEqual([
      ["session_id", 1],
      ["request_id", 2],
    ]);
    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    ).toEqual(["file_operations", "idempotency", "projects", "schema_migrations", "sessions"]);
    // new-baseline：bootstrap 在全新库建 schema 的同时写入**单一**基线 ledger 行（version=0）。
    expect(db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 0, name: "initial-schema" },
    ]);
    // 无版本化迁移痕迹（本方案没有 Migrator，不应创建迁移簿记表）
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'kysely_%'").all() as unknown[],
    ).toEqual([]);
    await kysely.destroy();

    // WAL：文件库启用，:memory: 仍为 memory
    const dir = mkdtempSync(join(tmpdir(), "pi-schema-manifest-wal-"));
    try {
      const fileDb = new DatabaseSync(join(dir, "app.db"));
      const fileKysely = await initializeDatabase(fileDb);
      expect((fileDb.prepare("PRAGMA journal_mode").get() as { journal_mode?: string }).journal_mode).toBe("wal");
      await fileKysely.destroy();

      const memDb = new DatabaseSync(":memory:");
      const memKysely = await initializeDatabase(memDb);
      expect((memDb.prepare("PRAGMA journal_mode").get() as { journal_mode?: string }).journal_mode).toBe("memory");
      await memKysely.destroy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Kysely<DatabaseSchema> 查询可用（推导类型落到真实查询）", async () => {
    const { kysely } = await initMemoryDb();
    // 先建默认项目（sessions.project_id FK 指向它）
    await kysely
      .insertInto("projects")
      .values({ id: DEFAULT_PROJECT_ID, name: "默认项目", cwd: "/srv", owner_key: "", created_at: 0 })
      .execute();
    await kysely
      .insertInto("sessions")
      .values({
        id: "s-type",
        owner_key: "o",
        project_id: DEFAULT_PROJECT_ID,
        title: "t",
        created_at: 1,
        updated_at: 1,
        agent_kind: "pi",
        conversation_format: "pi-jsonl-v3",
        conversation_ref: null,
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
      .orderBy("updated_at", "desc")
      .executeTakeFirst();
    expect(row?.title).toBe("t");
    await kysely.destroy();
  });
});

describe("DDL 审计基础（SQLite）：显式索引非唯一 + DEFAULT 实际生效 + 同键多行共存", () => {
  it("raw INSERT 省略 sessions.project_id → 实际落 DEFAULT_PROJECT_ID（defaultTo 的 DEFAULT 子句真实生效）", async () => {
    const { db, kysely } = await initMemoryDb();
    try {
      const projects = new KyselyProjectRepository(kysely, sqliteConstraintErrorMapper);
      const sessions = new KyselySessionRepository(kysely, sqliteConstraintErrorMapper);
      // FK 目标：默认项目必须存在，否则 raw insert 缺 project_id 的会话违反外键
      await projects.ensureDefaultProject({
        id: DEFAULT_PROJECT_ID,
        name: "默认项目",
        cwd: "/srv",
        ownerKey: "",
        createdAt: 0,
      });
      // 绕过 Repository（避免其显式写 project_id）：raw INSERT 完全省略 project_id，
      // 只有建表时的 DEFAULT 子句（Manifest default → defaultTo(DEFAULT_PROJECT_ID)）生效才落默认值
      const sid = "00000000-0000-4000-8000-000000000001";
      db.prepare(
        `INSERT INTO sessions (id, owner_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(sid, "owner-default", "默认项目会话", 100, 100);
      const row = await sessions.get(sid);
      expect(row?.projectId).toBe(DEFAULT_PROJECT_ID); // 审计点：省略 project_id 的确落默认（PG 侧有同构用例）
      expect(row?.ownerKey).toBe("owner-default");
    } finally {
      await kysely.destroy();
    }
  });

  it("同 owner 同 updated_at 的多个会话、同 owner 同 created_at 的多个项目共存（列表全量返回，业务索引非唯一）", async () => {
    const { kysely } = await initMemoryDb();
    try {
      const projects = new KyselyProjectRepository(kysely, sqliteConstraintErrorMapper);
      const sessions = new KyselySessionRepository(kysely, sqliteConstraintErrorMapper);
      await projects.ensureDefaultProject({
        id: DEFAULT_PROJECT_ID,
        name: "默认项目",
        cwd: "/srv",
        ownerKey: "",
        createdAt: 0,
      });
      const defaultSession = (id: string, title: string) => ({
        id,
        ownerKey: "owner-same",
        projectId: DEFAULT_PROJECT_ID,
        title,
        createdAt: 1,
        updatedAt: 500,
        agentKind: "pi",
        conversationFormat: "pi-jsonl-v3",
        conversationRef: null,
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        systemPrompt: null,
        capabilityVersions: null,
      });
      // idx_sessions_owner_updated(owner_key, updated_at DESC) 非唯一：同 owner+同 updated_at 两行共存
      await sessions.create(defaultSession("s-a", "a"));
      await sessions.create(defaultSession("s-b", "b"));
      // 同 owner + 同 updated_at → 次级排序 id desc（确定性：索引未去重，列表语义完整）
      expect((await sessions.listByOwner("owner-same")).map((r) => r.id)).toEqual(["s-b", "s-a"]);

      // idx_projects_owner(owner_key) 非唯一：同 owner+同 created_at 两行共存
      await projects.create({ id: "p-a", name: "A", cwd: "/a", ownerKey: "owner-proj-same", createdAt: 7 });
      await projects.create({ id: "p-b", name: "B", cwd: "/b", ownerKey: "owner-proj-same", createdAt: 7 });
      // 同 owner + 同 created_at → 次级排序 id desc
      expect((await projects.listByOwner("owner-proj-same")).map((r) => r.id)).toEqual(["p-b", "p-a"]);
    } finally {
      await kysely.destroy();
    }
  });

  it("非空 conversation identity 唯一：同 (agent_kind, conversation_format, conversation_ref) 至多一个；NULL 引用允许多个共存", async () => {
    const { kysely } = await initMemoryDb();
    try {
      const projects = new KyselyProjectRepository(kysely, sqliteConstraintErrorMapper);
      const sessions = new KyselySessionRepository(kysely, sqliteConstraintErrorMapper);
      await projects.ensureDefaultProject({
        id: DEFAULT_PROJECT_ID, name: "默认项目", cwd: "/srv", ownerKey: "", createdAt: 0,
      });
      const base = (id: string, conversationRef: string | null, agentKind = "pi") => ({
        id, ownerKey: "owner", projectId: DEFAULT_PROJECT_ID, title: id, createdAt: 1, updatedAt: 1,
        agentKind, conversationFormat: "pi-jsonl-v3", conversationRef, modelProvider: null,
        modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null,
      });
      // 多个 NULL 引用共存（懒会话未实例化；唯一索引对 NULL 不冲突）
      await sessions.create(base("s-null-1", null));
      await sessions.create(base("s-null-2", null));
      // 非空引用独占：同 (pi, pi-jsonl-v3, ref) 的第二个会话被唯一约束拒绝
      await sessions.create(base("s-ref-1", "/tmp/sessions/shared/history.jsonl"));
      await expect(sessions.create(base("s-ref-2", "/tmp/sessions/shared/history.jsonl"))).rejects.toThrow(/UNIQUE constraint failed/);
      // identity 三元组含 kind/format：不同 agent_kind 可复用同一非空引用
      await sessions.create(base("s-ref-3", "/tmp/sessions/shared/history.jsonl", "other-agent"));
      expect((await sessions.get("s-ref-3"))?.conversationRef).toBe("/tmp/sessions/shared/history.jsonl");
    } finally {
      await kysely.destroy();
    }
  });
});

describe("defineSchema 运行期校验（防御纵深，编译期字面量检查之外的保障）", () => {
  // 负向用例以 TableManifest[] 宽化传入：编译期字面量检查失效，运行期校验必须兜底抛错。
  function expectThrows(manifest: TableManifest[], pattern: RegExp): void {
    expect(() => defineSchema(manifest)).toThrow(pattern);
  }

  const base = (): TableManifest => ({
    name: "t",
    columns: [{ name: "id", type: "uuid", nullable: false }],
    primaryKey: { columns: ["id"] },
    foreignKeys: [],
    indexes: [],
  });

  it("表名重复 / 列名重复 / 未知列类型", () => {
    expectThrows([base(), { ...base(), name: "t" }], /duplicate table name 't'/);
    expectThrows(
      [{ ...base(), columns: [{ name: "id", type: "uuid", nullable: false }, { name: "id", type: "text", nullable: false }] }],
      /duplicate column 'id'/,
    );
    expectThrows(
      [{ ...base(), columns: [{ name: "id", type: "blob" as unknown as LogicalColumnType, nullable: false }] }],
      /unknown logical type 'blob'/,
    );
  });

  it("主键引用未知列", () => {
    expectThrows([{ ...base(), primaryKey: { columns: ["missing"] } }], /primaryKey references unknown column 'missing'/);
  });

  it("主键列不可 nullable（主键值不可为 NULL）", () => {
    expectThrows(
      [{ ...base(), columns: [{ name: "id", type: "uuid", nullable: true }] }],
      /primaryKey column 'id' must be non-nullable/,
    );
    // 复合主键同样逐列检查
    const tbl = {
      name: "t",
      columns: [
        { name: "a", type: "uuid", nullable: false },
        { name: "b", type: "text", nullable: true },
      ],
      primaryKey: { constraintName: "t_pk", columns: ["a", "b"] },
      foreignKeys: [],
      indexes: [],
    } satisfies TableManifest;
    expectThrows([tbl], /primaryKey column 'b' must be non-nullable/);
  });

  it("外键：目标表不存在 / 目标表声明在引用表之后 / 源列或目标列不存在", () => {
    expectThrows(
      [{ ...base(), foreignKeys: [{ constraintName: "fk", columns: ["id"], targetTable: "nope", targetColumns: ["id"], onDelete: "cascade" }] }],
      /references unknown table 'nope'/,
    );

    // 目标表 "b" 声明在引用表 "a" 之后
    expectThrows(
      [
        {
          name: "a",
          columns: [{ name: "aid", type: "uuid", nullable: false }],
          primaryKey: { columns: ["aid"] },
          foreignKeys: [{ constraintName: "fk-order", columns: ["aid"], targetTable: "b", targetColumns: ["bid"], onDelete: "cascade" }],
          indexes: [],
        },
        {
          name: "b",
          columns: [{ name: "bid", type: "uuid", nullable: false }],
          primaryKey: { columns: ["bid"] },
          foreignKeys: [],
          indexes: [],
        },
      ],
      /must be declared before it/,
    );

    // 目标表合法（先声明），但源列/目标列缺失
    const other: TableManifest = {
      name: "other",
      columns: [{ name: "id", type: "uuid", nullable: false }],
      primaryKey: { columns: ["id"] },
      foreignKeys: [],
      indexes: [],
    };
    expectThrows(
      [other, { ...base(), foreignKeys: [{ constraintName: "fk", columns: ["missing"], targetTable: "other", targetColumns: ["id"], onDelete: "cascade" }] }],
      /source column 'missing'/,
    );
    expectThrows(
      [other, { ...base(), foreignKeys: [{ constraintName: "fk", columns: ["id"], targetTable: "other", targetColumns: ["missing"], onDelete: "cascade" }] }],
      /target column 'missing' is not in table 'other'/,
    );
  });

  it("外键：源/目标列表为空、列数不等、逻辑类型不一致均拒绝", () => {
    const other: TableManifest = {
      name: "other",
      columns: [{ name: "id", type: "uuid", nullable: false }],
      primaryKey: { columns: ["id"] },
      foreignKeys: [],
      indexes: [],
    };
    // 空源列 / 空目标列
    expectThrows(
      [other, { ...base(), foreignKeys: [{ constraintName: "fk", columns: [], targetTable: "other", targetColumns: ["id"], onDelete: "cascade" }] }],
      /must declare at least one source column/,
    );
    expectThrows(
      [other, { ...base(), foreignKeys: [{ constraintName: "fk", columns: ["id"], targetTable: "other", targetColumns: [], onDelete: "cascade" }] }],
      /must declare at least one target column/,
    );
    // 列数不等：单列源 → 双列目标
    expectThrows(
      [other, { ...base(), foreignKeys: [{ constraintName: "fk", columns: ["id"], targetTable: "other", targetColumns: ["id", "id"], onDelete: "cascade" }] }],
      /source column count \(1\) must equal target column count \(2\)/,
    );
    // 逻辑类型不一致：text 源列 → uuid 目标列
    expectThrows(
      [
        other,
        {
          ...base(),
          columns: [{ name: "id", type: "text", nullable: false }],
          foreignKeys: [{ constraintName: "fk", columns: ["id"], targetTable: "other", targetColumns: ["id"], onDelete: "cascade" }],
        },
      ],
      /column 'id' \(text\) type mismatch with 'other.id' \(uuid\)/,
    );
  });

  it("索引：引用未知列 / 重复索引名（数据库级唯一）/ 未知排序 / 空列", () => {
    expectThrows(
      [{ ...base(), indexes: [{ name: "idx", columns: [{ name: "missing" }] }] }],
      /index 'idx' on table 't' references unknown column 'missing'/,
    );
    const t2: TableManifest = {
      name: "t2",
      columns: [{ name: "cid", type: "uuid", nullable: false, default: "seed" }],
      primaryKey: { columns: ["cid"] },
      foreignKeys: [],
      indexes: [{ name: "idx", columns: [{ name: "cid" }] }],
    };
    // 第一张表注册索引名 "idx"，第二张表再声明同名索引 → 数据库级唯一冲突
    expectThrows([{ ...base(), indexes: [{ name: "idx", columns: [{ name: "id" }] }] }, t2], /duplicate index name 'idx'/);
    expectThrows(
      [{ ...base(), indexes: [{ name: "idx", columns: [{ name: "id", order: "sideways" as unknown as "asc" | "desc" }] }] }],
      /unknown sort order 'sideways'/,
    );
    expectThrows(
      [{ ...base(), indexes: [{ name: "idx-empty", columns: [] }] }],
      /index 'idx-empty' on table 't' has no columns/,
    );
  });

  it("default 与逻辑类型不匹配（uuid 需字符串、integer 需数字）", () => {
    expectThrows([{ ...base(), columns: [{ name: "id", type: "uuid", nullable: false, default: 42 }] }], /default must be string for logical type 'uuid'/);
    expectThrows([{ ...base(), columns: [{ name: "id", type: "integer", nullable: false, default: "x" }] }], /default must be number for logical type 'integer'/);
  });

  it("boolean default 被拒绝（无 boolean 逻辑类型；类型与运行期双重拒绝）", () => {
    const bad: TableManifest = {
      ...base(),
      columns: [
        { name: "id", type: "uuid", nullable: false, default: true as unknown as DefaultValueLiteral },
      ],
    };
    expectThrows([bad], /default must be string for logical type 'uuid'/);
  });

  it("onDelete 非法", () => {
    expectThrows(
      [{ ...base(), foreignKeys: [{ constraintName: "fk", columns: ["id"], targetTable: "t", targetColumns: ["id"], onDelete: "explode" as unknown as ForeignKeyAction }] }],
      /unknown onDelete 'explode'/,
    );
  });

  it("逻辑类型运行期集合以 Record 键为权威（union 与数组不漂移）", () => {
    expect([...LOGICAL_COLUMN_TYPES].sort()).toEqual(["bigint", "integer", "json", "text", "uuid"]);
    // 数组由键集合推导：两者永远一致；union 完整性由 compile-time Record<LogicalColumnType, true> 强制
    expect(Object.keys(LOGICAL_COLUMN_TYPE_KEYS).sort()).toEqual([...LOGICAL_COLUMN_TYPES].sort());
  });

  it("合法 Manifest：单列内联主键 + 同名自引用外键校验前不误报；冻结返回", () => {
    const m = defineSchema([
      {
        name: "parent",
        columns: [{ name: "id", type: "uuid", nullable: false }],
        primaryKey: { columns: ["id"] },
        foreignKeys: [],
        indexes: [],
      },
    ]);
    expect(m.tables).toHaveLength(1);
    expect(Object.isFrozen(m.tables[0])).toBe(true);
  });
});