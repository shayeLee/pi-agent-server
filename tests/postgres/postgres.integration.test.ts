// PostgreSQL 集成测试（工作包 C，**PI_TEST_PG_URL 门控**）：
// - 仅当环境变量 PI_TEST_PG_URL 存在（非空）时才运行；未配置时整组跳过并打印依据，
//   绝不报告为通过、绝不发起连接（`pnpm test:postgres` 在无 URL 时以非零码失败，见 scripts/test-postgres.ts）。
// - 安全隔离：每个测试文件使用随机 schema（命名前缀 pi_test_），search_path 指向它；
//   afterAll 只 DROP 自己创建的随机 schema（严禁 drop public / 任意用户数据库）。
// - **用例顺序无关（发布门禁审计）**：
//   - beforeEach 对 idempotency、sessions、projects 执行 TRUNCATE（CASCADE）——每条用例都从空表开始，
//     新增用例（append test）不会依赖先前用例留下的数据，也不破坏既有用例；
//   - 没有任何用例销毁共享的 Pool/Kysely fixture；Pool 关闭用例自建独立 Pool/Kysely，
//     可在任意位置执行（不依赖作为最后一条用例）；
//   - 「重复/任意顺序」由专门的用例 + 文件头部结构双重证明。
// - 覆盖：bootstrap（表/列/FK/index/无迁移表）、默认项目幂等、CRUD、
//   sessions.project_id 的 PG DEFAULT 子句、FK CASCADE、ON CONFLICT（ensureDefaultProject /
//   idempotency.put）、TTL prune、JSON text 往返、BIGINT 读回 number（含超范围显式失败）、
//   PG 约束错误映射（23505/23503）、Pool 释放、业务索引非唯一与多行同键共存。
// - **Fixture 约束**：PG 的 uuid 列（projects.id / sessions.id / sessions.project_id /
//   idempotency.session_id）只接受合法 UUID——所有写入/查询这些列的 fixture 一律用
//   randomUUID() 或合法 UUID 常量；FK 缺失用例用「合法但不存在」的 UUID 才会触发 23503。
// - **状态说明**：本文件由 PI_TEST_PG_URL 门控；当前扩展门控（45 个用例，含本文件 21 个）
//   已由 `volta run pnpm verify:release`（真实 PG）全部通过。验收记录见 docs/database-design.md §9。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";
import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { initializePostgresDatabase, createPostgresKysely } from "../../src/storage/postgres-bootstrap.js";
import { createPgInt8SafeTypes } from "../../src/storage/pg-int8.js";
import { pgConstraintErrorMapper } from "../../src/storage/pg-constraint-errors.js";
import { KyselyProjectRepository } from "../../src/storage/kysely-project-repository.js";
import { KyselySessionRepository } from "../../src/storage/kysely-session-repository.js";
import { KyselyIdempotencyRepository } from "../../src/storage/kysely-idempotency-repository.js";
import { KyselyFileOperationRepository } from "../../src/storage/kysely-file-operation-repository.js";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";
import { schemaManifest, type LogicalColumnType, type TableManifest } from "../../src/storage/schema-manifest.js";
import {
  DEFAULT_PROJECT_ID,
  type ProjectRecord,
} from "../../src/application/ports/project-store-port.js";
import type { SessionRecord } from "../../src/application/ports/session-store-port.js";
import { DuplicateIdError, ProjectForeignKeyError } from "../../src/application/ports/store-errors.js";
import type { SchemaManifest } from "../../src/storage/schema-manifest.js";

const pgUrl = process.env.PI_TEST_PG_URL?.trim() || undefined;
assertRequiredPgTestEnvironment("tests/postgres/postgres.integration", pgUrl, false);
if (!pgUrl) {
  console.warn(
    "[postgres integration] PI_TEST_PG_URL 未配置：PG 集成测试整组跳过（不尝试连接、不静默通过）；本机验收锁定 Docker 的 PG 环境",
  );
}

/** 把 search_path 注入连接串：每个 Pool 连接都落在随机 schema 内（无连接竞态）。 */
function withSchemaSearchPath(url: string, schema: string): string {
  const u = new URL(url);
  u.searchParams.set("options", `-c search_path=${schema}`);
  return u.toString();
}

/** 生成安全的 PG 标识符（随机 schema 名，杜绝跨文件/跨运行冲突）。 */
function safeSchemaName(): string {
  const rand = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `pi_test_${rand}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

const describePg = pgUrl ? describe : describe.skip;

type ProjectSeed = ProjectRecord & { ownerKey: string };

/** Manifest 逻辑类型 → PG 物理类型（data_type / udt_name），逐列契约对照的另一半。 */
const PG_PHYSICAL: Record<LogicalColumnType, { data_type: string; udt_name: string }> = {
  uuid: { data_type: "uuid", udt_name: "uuid" },
  text: { data_type: "text", udt_name: "text" },
  integer: { data_type: "bigint", udt_name: "int8" },
  bigint: { data_type: "bigint", udt_name: "int8" },
  json: { data_type: "text", udt_name: "text" },
};

function expectedPgColumns(table: TableManifest) {
  return table.columns.map((c) => ({
    name: c.name,
    data_type: PG_PHYSICAL[c.type].data_type,
    udt_name: PG_PHYSICAL[c.type].udt_name,
    is_nullable: c.nullable ? "YES" : "NO",
    // Keep the expected literal, not only a boolean. v1 also declares
    // file_operations.attempt_count DEFAULT 0; a table-agnostic assertion
    // must not mistake that valid default for sessions.project_id.
    default_value: c.default,
  }));
}

describePg("PostgreSQL 集成测试（PI_TEST_PG_URL 门控；随机 schema 隔离）", () => {
  let schema: string;
  let pool: Pool;
  let kysely: Kysely<DatabaseSchema>;
  let projects: KyselyProjectRepository;
  let sessions: KyselySessionRepository;
  let idempotency: KyselyIdempotencyRepository;
  let fileOperations: KyselyFileOperationRepository;

  function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      // PG uuid 列：会话 id / project_id 必须为合法 UUID（randomUUID）
      id: randomUUID(),
      ownerKey: "owner-a",
      projectId: randomUUID(),
      title: "会话",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      agentKind: "pi",
      conversationFormat: "pi-jsonl-v3",
      conversationRef: null,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      systemPrompt: null,
      capabilityVersions: null,
      ...overrides,
    };
  }

  beforeAll(async () => {
    schema = safeSchemaName();
    // 与生产 createPostgresPool 同构：per-pool int8 安全 types + search_path 指向随机 schema
    pool = new Pool({ connectionString: withSchemaSearchPath(pgUrl!, schema), types: createPgInt8SafeTypes() });
    // search_path 指向尚不存在的 schema 合法；CREATE SCHEMA 不受 search_path 影响
    await pool.query(`CREATE SCHEMA ${schema}`);
    kysely = await initializePostgresDatabase(pool);
    fileOperations = new KyselyFileOperationRepository(kysely, "postgres");
    const fileOperationOptions = { fileOperations, relativePath: (filePath: string) => filePath } as const;
    projects = new KyselyProjectRepository(kysely, pgConstraintErrorMapper, fileOperationOptions);
    sessions = new KyselySessionRepository(kysely, pgConstraintErrorMapper, fileOperationOptions);
    idempotency = new KyselyIdempotencyRepository(kysely);
  });

  beforeEach(async () => {
    // 每条用例独立起点：清空四张表。file_operations 无 FK，父表 CASCADE 不会清理它。
    // 随机 schema + afterAll 只 drop 自己的 schema 保留不变；TRUNCATE 只在本随机 schema 内生效。
    await pool.query(`TRUNCATE TABLE file_operations, idempotency, sessions, projects CASCADE`);
  });

  afterAll(async () => {
    // 独立清理：setup 失败时不得访问未初始化对象（schema / kysely 可能未赋值）；destroy 错误
    // 不掩盖插桩/setup 的原始失败。共享业务 Pool 由本处统一释放；随后用独立连接清理自己
    // 创建的随机 schema（严禁触碰 public / 连接库本身）。
    try {
      if (kysely) await kysely.destroy();
    } catch {
      // 忽略次要清理错误，避免覆盖 beforeAll 等原始失败（vitest 已记录其错误）
    }
    if (pool && !pool.ending) {
      await pool.end();
    }
    const cleanupPool = new Pool({ connectionString: pgUrl! });
    try {
      if (schema) await cleanupPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await cleanupPool.end();
    }
  });

  describe("bootstrap：Manifest → PG DDL（表/列/FK/索引/无迁移表）", () => {
    it("5 张表齐备（含 schema_migrations 基线 ledger），无 kysely_migration 表", async () => {
      const tables = (
        await pool.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
          [schema],
        )
      ).rows.map((r) => r.table_name as string);
      expect(tables).toEqual(["file_operations", "idempotency", "projects", "schema_migrations", "sessions"]);
      const migrationTables = (
        await pool.query(
          `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'kysely_%'`,
          [schema],
        )
      ).rows[0]!.n;
      expect(migrationTables).toBe(0);
    });

    it("逐列验证每张表的类型/nullable/default 与 Manifest 一致（不只抽样；无多余/缺失列）", async () => {
      const rows = async (table: string) =>
        (
          await pool.query(
            `SELECT column_name, data_type, udt_name, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position`,
            [schema, table],
          )
        ).rows as Array<{
          column_name: string;
          data_type: string;
          udt_name: string;
          is_nullable: string;
          column_default: string | null;
        }>;

      const manifestTables = schemaManifest.tables as readonly TableManifest[];
      // 同一 Manifest 同时驱动 bootstrap 与期望值：逐列逐一对照（类型/nullable/default）。
      for (const table of manifestTables) {
        const actual = await rows(table.name);
        const expected = expectedPgColumns(table);
        expect(actual).toHaveLength(expected.length); // 无多余/缺失列
        for (let i = 0; i < expected.length; i++) {
          const e = expected[i]!;
          const a = actual[i]!;
          expect(a.column_name).toBe(e.name);
          // uuid→UUID、text/json→TEXT、integer/bigint→BIGINT(udt int8)
          expect(a.data_type).toBe(e.data_type);
          expect(a.udt_name).toBe(e.udt_name);
          expect(a.is_nullable).toBe(e.is_nullable);
          if (e.default_value !== undefined) {
            // information_schema canonicalizes a string UUID default to
            // '<uuid>'::uuid and leaves the integer default as 0. Compare
            // the manifest's own literal so both v0 and v1 defaults are
            // checked without hard-coding a table-specific expectation.
            expect(a.column_default).not.toBeNull();
            expect(a.column_default).toContain(String(e.default_value));
          } else {
            expect(a.column_default).toBeNull();
          }
        }
      }
    });

    it("主键与 FK：单列 PK（projects/sessions）、复合 PK（idempotency_pk）、FK ON DELETE CASCADE", async () => {
      const constraints = async (table: string) => {
        return (
          await pool.query(
            `SELECT conname, contype, pg_get_constraintdef(oid) AS def
             FROM pg_constraint WHERE connamespace = $1::regnamespace AND conrelid = $2::regclass`,
            [schema, `${schema}.${table}`],
          )
        ).rows as Array<{ conname: string; contype: string; def: string }>;
      };
      const p = await constraints("projects");
      expect(p.find((c) => c.contype === "p")?.conname).toBe("projects_pkey");
      const s = await constraints("sessions");
      expect(s.find((c) => c.contype === "p")?.conname).toBe("sessions_pkey");
      const fk = s.find((c) => c.contype === "f");
      expect(fk?.conname).toBe("sessions_project_id_fk");
      expect(fk?.def).toMatch(/FOREIGN KEY \(project_id\) REFERENCES projects\(id\) ON DELETE CASCADE/i);

      const i = await constraints("idempotency");
      const ipk = i.find((c) => c.contype === "p")!;
      expect(ipk.conname).toBe("idempotency_pk");
      expect(ipk.def).toMatch(/PRIMARY KEY \(session_id, request_id\)/i);
    });

    it("sessions.project_id 有 PG DEFAULT 子句 = DEFAULT_PROJECT_ID（Manifest default → DDL）", async () => {
      const col = (
        await pool.query(
          `SELECT column_default FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'sessions' AND column_name = 'project_id'`,
          [schema],
        )
      ).rows[0] as { column_default: string | null } | undefined;
      // Kysely defaultTo(DEFAULT_PROJECT_ID) 在 PG 生成 DEFAULT '<uuid>'::uuid 字面量
      expect(col?.column_default).toContain(DEFAULT_PROJECT_ID);
    });

    it("7 个显式业务索引 + schema_migrations 的 name UNIQUE 索引齐备，outbox key 与 conversation identity 唯一且 claim 非唯一，含 updated_at DESC；PK 自动索引被排除", async () => {
      // PostgreSQL 会为每个 PRIMARY KEY / UNIQUE 约束自动创建索引（如 projects_pkey、sessions_pkey、
      // idempotency_pk、schema_migrations_pkey）。这里仅查询 indisprimary = false 的非主键索引
      // （PK 索引自动排除）。除 Manifest 显式声明的 7 个业务索引外，bootstrap 的 schema_migrations
      // 基线 ledger 的 name UNIQUE 约束也会生成一个非主键 UNIQUE索引（schema_migrations_name_key），
      // 它必须被纳入 —— 且除 outbox key（idx_file_operations_key）与 conversation identity
      // （idx_sessions_conversation）外是唯一的 UNIQUE 索引。
      const indexes = (
        await pool.query(
          `SELECT ic.relname AS indexname,
                  pg_get_indexdef(ic.oid) AS indexdef,
                  ix.indisunique
           FROM pg_index ix
           JOIN pg_class ic ON ic.oid = ix.indexrelid
           JOIN pg_namespace n ON n.oid = ic.relnamespace
           WHERE n.nspname = $1
             AND ix.indisprimary = false
           ORDER BY ic.relname`,
          [schema],
        )
      ).rows as Array<{ indexname: string; indexdef: string; indisunique: boolean }>;
      const names = indexes.map((r) => r.indexname).sort();
      expect(names).toEqual(
        ["idx_file_operations_claim", "idx_file_operations_key", "idx_idempotency_created_at", "idx_projects_owner", "idx_sessions_conversation", "idx_sessions_owner_project", "idx_sessions_owner_updated", "schema_migrations_name_key"].sort(),
      );
      // 7 个 Manifest 业务索引中，仅 outbox key（idx_file_operations_key）与 conversation identity
      // （idx_sessions_conversation）以及 ledger 的 name 约束索引是 UNIQUE，其余显式非唯一（无 unique: true）。
      const uniqueIndexNames = new Set(["idx_file_operations_key", "idx_sessions_conversation", "schema_migrations_name_key"]);
      for (const row of indexes) {
        expect(row.indisunique, `索引 ${row.indexname} unique 语义`).toBe(uniqueIndexNames.has(row.indexname));
      }
      const ownerUpdated = indexes.find((r) => r.indexname === "idx_sessions_owner_updated")!;
      expect(ownerUpdated.indexdef).toMatch(/owner_key/);
      expect(ownerUpdated.indexdef.toLowerCase()).toMatch(/updated_at.*desc/);
    });
  });

  describe("隔离与顺序无关（简洁的任意顺序/重复执行证明）", () => {
    it("同一 CRUD+约束失败场景连续执行两遍结果一致（beforeEach TRUNCATE 提供空表起点，不依赖先前用例）", async () => {
      // 结构证明（配合文件头注释）：所有用例共享同一随机 schema + beforeEach TRUNCATE，
      // 因此新追加的用例不会吃到旧用例的数据，也不会把自己的数据泄漏给后续用例。
      // 这里把代表性场景（创建/列表/撞主键/FK 缺失/删除）在清空后的表上连跑两遍，
      // 两遍结果必须逐位一致——任何「依赖上一遍残留」的回归都会在此暴露。
      for (let round = 0; round < 2; round++) {
        const p = { id: randomUUID(), name: `r${round}`, cwd: "/r", ownerKey: "owner-ord", createdAt: 1 } satisfies ProjectSeed;
        await projects.create(p);
        // ownerKey 必须与列表断言一致（owner-ord）：否则 owner 隔离破坏 listByOwner 计数。
        const rec = session({ id: randomUUID(), ownerKey: "owner-ord", projectId: p.id, title: `t${round}` });
        await sessions.create(rec);
        expect(await sessions.listByOwner("owner-ord")).toHaveLength(1);
        // 撞主键 → 存储无关 DuplicateIdError（第二轮同样触发，未被第一轮残余影响）
        await expect(projects.create(p)).rejects.toBeInstanceOf(DuplicateIdError);
        // FK 缺失 → ProjectForeignKeyError
        await expect(sessions.create(session({ id: randomUUID(), projectId: randomUUID() }))).rejects.toBeInstanceOf(
          ProjectForeignKeyError,
        );
        await projects.delete(p.id);
        expect(await projects.get(p.id)).toBeNull();
        expect(await sessions.get(rec.id)).toBeNull(); // CASCADE 清除会话
      }
    });
  });

  describe("默认项目与幂等（ensureDefaultProject ON CONFLICT DO NOTHING）", () => {
    it("ensureDefaultProject 创建默认项目；重复调用幂等不覆盖、不报错", async () => {
      const seed = {
        id: DEFAULT_PROJECT_ID, // 合法 UUID 常量
        name: "默认项目",
        cwd: "/srv",
        ownerKey: "",
        createdAt: 0,
      };
      await projects.ensureDefaultProject(seed);
      await projects.ensureDefaultProject({ ...seed, name: "改名（不得生效）" });
      const row = await projects.get(DEFAULT_PROJECT_ID);
      expect(row).toMatchObject({ id: DEFAULT_PROJECT_ID, name: "默认项目", cwd: "/srv", ownerKey: "" });
      const count = (
        await pool.query(`SELECT count(*)::int AS n FROM projects WHERE id = $1`, [DEFAULT_PROJECT_ID])
      ).rows[0]!.n;
      expect(count).toBe(1);
    });
  });

  describe("CRUD：项目与会话（共享同一 Manifest schema / 中立 Repository）", () => {
    it("项目 create/get/list/delete，会话 create/get/list/update/backfill/delete 语义与 SQLite 一致", async () => {
      const p: ProjectSeed = {
        id: randomUUID(), // PG uuid 列合法值
        name: "项目1",
        cwd: "/repo/1",
        ownerKey: "owner-a",
        createdAt: 1000,
      };
      await projects.create(p);
      expect(await projects.get(p.id)).toEqual(p);
      expect(await projects.listByOwner("owner-a")).toEqual([p]);
      expect(await projects.listByOwner("owner-b")).toEqual([]);

      const rec = session({ id: randomUUID(), projectId: p.id, title: "标题1", createdAt: 2000, updatedAt: 2000 });
      await sessions.create(rec);
      expect(await sessions.get(rec.id)).toEqual(rec);
      expect(await sessions.listByProject("owner-a", p.id)).toEqual([rec]);
      expect(await sessions.listByOwner("owner-a")).toEqual([rec]);

      // update（patch 字段语义）
      expect(await sessions.update(rec.id, { title: "标题2", updatedAt: 3000 })).toBe(true);
      expect((await sessions.get(rec.id))?.title).toBe("标题2");
      // 相同值更新：numAffected=0 时按存在性判定（与 SQLite changes=0 语义一致）
      expect(await sessions.update(rec.id, { title: "标题2" })).toBe(true);

      // backfillSystemPrompt：只补 null，不覆盖既有
      expect(await sessions.backfillSystemPrompt("默认提示词")).toBeGreaterThan(0);
      expect((await sessions.get(rec.id))?.systemPrompt).toBe("默认提示词");
      expect(await sessions.backfillSystemPrompt("第二次")).toBe(0);
      expect((await sessions.get(rec.id))?.systemPrompt).toBe("默认提示词");

      // delete
      expect(await sessions.delete(rec.id)).toBe(true);
      expect(await sessions.get(rec.id)).toBeNull();
      expect(await sessions.delete(rec.id)).toBe(false);

      expect(await projects.delete(p.id)).toBe(true);
      expect(await projects.delete(p.id)).toBe(false);
      expect(await projects.delete(DEFAULT_PROJECT_ID)).toBe(false); // 保留 id 不可删
    });

    it("sessions.project_id 省略时由 PG DEFAULT 子句落 DEFAULT_PROJECT_ID（raw insert 省略 project_id）", async () => {
      // 先确保默认项目存在（FK 指向 projects.id；本组其余测试不依赖该会话）
      await projects.ensureDefaultProject({
        id: DEFAULT_PROJECT_ID,
        name: "默认项目",
        cwd: "/srv",
        ownerKey: "",
        createdAt: 0,
      });
      const sid = randomUUID();
      // 绕过 Repository（避免其显式写入 project_id）：raw INSERT 完全省略 project_id，
      // 只有 PG 的 DEFAULT 子句生效才会落 DEFAULT_PROJECT_ID。
      // 独立 owner（owner-default）避免干扰 CRUD 里 owner-a 的 list/backfill 断言。
      await pool.query(
        `INSERT INTO sessions (id, owner_key, title, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [sid, "owner-default", "默认项目会话", 100, 100],
      );
      // 经 Repository 读回（int8→number、行映射）语义一致
      const row = await sessions.get(sid);
      expect(row?.projectId).toBe(DEFAULT_PROJECT_ID);
      expect(row?.ownerKey).toBe("owner-default");
      expect(typeof row?.createdAt).toBe("number");
    });

    it("业务索引非唯一：同 owner+updated_at 多会话、同 owner+created_at 多项目共存且列表全量返回", async () => {
      // idx_sessions_owner_updated(owner_key, updated_at DESC) 与 idx_projects_owner(owner_key)
      // 都是非唯一业务索引（Manifest 无 unique:true）：同一键多行必须共存，查询不得因索引去重。
      const p = { id: randomUUID(), name: "same", cwd: "/same", ownerKey: "owner-same", createdAt: 1 } satisfies ProjectSeed;
      await projects.create(p);
      const s1 = session({ id: randomUUID(), ownerKey: "owner-same", projectId: p.id, title: "a", createdAt: 1, updatedAt: 500 });
      const s2 = session({ id: randomUUID(), ownerKey: "owner-same", projectId: p.id, title: "b", createdAt: 1, updatedAt: 500 });
      await sessions.create(s1);
      await sessions.create(s2);
      const rows = await sessions.listByOwner("owner-same");
      // 同 owner + 同 updated_at → 次级排序 id desc（确定性，证明索引不唯一且列表语义完整）
      expect(rows.map((r) => r.id)).toEqual([s1.id, s2.id].sort().reverse());
      expect(rows.map((r) => r.title).sort()).toEqual(["a", "b"]);

      const p2 = { id: randomUUID(), name: "p2", cwd: "/p2", ownerKey: "owner-proj-same", createdAt: 700 };
      const p3 = { id: randomUUID(), name: "p3", cwd: "/p3", ownerKey: "owner-proj-same", createdAt: 700 };
      await projects.create(p2);
      await projects.create(p3);
      const projs = await projects.listByOwner("owner-proj-same");
      expect(projs.map((r) => r.id)).toEqual([p2.id, p3.id].sort().reverse());
    });
  });

  describe("FK CASCADE（数据库层兑底）", () => {
    it("直接删项目（绕过应用层事务）→ 会话由 ON DELETE CASCADE 自动删除；deleteProjectWithSessions 事务同语义", async () => {
      const p = { id: randomUUID(), name: "级联", cwd: "/c", ownerKey: "o", createdAt: 1 } satisfies ProjectSeed;
      await projects.create(p);
      const rec = session({ id: randomUUID(), projectId: p.id });
      await sessions.create(rec);
      // 绕过应用层，直接数据库级 DELETE projects → FK CASCADE 删会话
      await pool.query(`DELETE FROM projects WHERE id = $1`, [p.id]);
      expect(await sessions.get(rec.id)).toBeNull();
      expect(await projects.get(p.id)).toBeNull();

      // deleteProjectWithSessions：同一事务删除项目+会话
      const p2 = { id: randomUUID(), name: "级联2", cwd: "/c2", ownerKey: "o", createdAt: 2 } satisfies ProjectSeed;
      await projects.create(p2);
      const rec2 = session({ id: randomUUID(), projectId: p2.id });
      await sessions.create(rec2);
      await projects.deleteProjectWithSessions(p2.id, [rec2.id]);
      expect(await projects.get(p2.id)).toBeNull();
      expect(await sessions.get(rec2.id)).toBeNull();
    });
  });

  describe("ON CONFLICT / 幂等记录（idempotency.put 覆盖 + TTL prune）", () => {
    it("put 后 get 命中 JSON 结果；重复 put 覆盖同一 requestId；prune 按 created_at 删除", async () => {
      // session_id 为 uuid 列：get/put/UPDATE 全部使用合法 UUID，避免 PG 把非法文本当 uuid 解析
      const sidem = randomUUID();
      const sidemOther = randomUUID();
      expect(await idempotency.get(sidem, "r-1")).toBeNull();
      await idempotency.put(sidem, "r-1", { status: "completed", echo: ["a"] });
      expect(await idempotency.get(sidem, "r-1")).toEqual({ status: "completed", echo: ["a"] });
      // 相同请求 id 覆盖（ON CONFLICT DO UPDATE）
      await idempotency.put(sidem, "r-1", { status: "completed", echo: ["b"] });
      expect(await idempotency.get(sidem, "r-1")).toEqual({ status: "completed", echo: ["b"] });
      // 不同 session 同 requestId 互不影响
      expect(await idempotency.get(sidemOther, "r-1")).toBeNull();

      // TTL：把记录的 created_at 推到过去，prune 后删除
      await pool.query(`UPDATE idempotency SET created_at = $1 WHERE session_id = $2 AND request_id = $3`, [
        1000,
        sidem,
        "r-1",
      ]);
      const deleted = await idempotency.prune(Date.now());
      expect(deleted).toBeGreaterThan(0);
      expect(await idempotency.get(sidem, "r-1")).toBeNull();
    });
  });

  describe("JSON 文本往返（非 JSONB）", () => {
    it("sessions.capability_versions / idempotency.result 以 TEXT 存储，Repository 读回 JSON 语义一致", async () => {
      const p = { id: randomUUID(), name: "json", cwd: "/j", ownerKey: "o", createdAt: 1 } satisfies ProjectSeed;
      await projects.create(p);
      const versions = JSON.stringify({ runtime: 3, sse: 2 });
      const rec = session({ id: randomUUID(), projectId: p.id, capabilityVersions: versions });
      await sessions.create(rec);
      // 物理存储确为 text（非 json/jsonb）
      const stored = await pool.query(
        `SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'sessions' AND column_name = 'capability_versions'`,
        [schema],
      );
      expect(stored.rows[0]?.data_type).toBe("text");
      // 读回仍是 JSON 字符串，可 parse 往返
      const row = await sessions.get(rec.id);
      expect(row?.capabilityVersions).toBe(versions);
      expect(JSON.parse(row!.capabilityVersions!)).toEqual({ runtime: 3, sse: 2 });

      const sidemJson = randomUUID();
      await idempotency.put(sidemJson, "r-json", { status: "completed", nested: { list: [1, 2, 3] } });
      expect(await idempotency.get(sidemJson, "r-json")).toEqual({
        status: "completed",
        nested: { list: [1, 2, 3] },
      });
    });
  });

  describe("BIGINT 读回安全 number（int8 边界）", () => {
    it("时间戳列（integer→BIGINT）读回为 JS number，数值一致", async () => {
      const p = { id: randomUUID(), name: "big", cwd: "/b", ownerKey: "o", createdAt: 1718000000000 } satisfies ProjectSeed;
      await projects.create(p);
      const got = await projects.get(p.id);
      expect(typeof got?.createdAt).toBe("number");
      expect(got?.createdAt).toBe(1718000000000);
    });

    it("超出 Number.MAX_SAFE_INTEGER 的 int8 值显式失败（不静默丢精度）", async () => {
      const p = { id: randomUUID(), name: "big2", cwd: "/b2", ownerKey: "o", createdAt: 1 } satisfies ProjectSeed;
      await projects.create(p);
      // 绕过应用层写入超出安全整数范围的 created_at（PG 允许 BIGINT 存此值）
      await pool.query(`UPDATE projects SET created_at = 9223372036854775807 WHERE id = $1`, [p.id]);
      // Repository 读取 → int8 安全解析器显式抛错（查询拒绝）
      await expect(projects.get(p.id)).rejects.toThrow(/超出 JS 安全整数范围/);
    });
  });

  describe("PG 约束错误映射（真实 SQLSTATE）", () => {
    it("projects_pkey 23505 → DuplicateIdError（存储无关）；应用层无需识别 PG code", async () => {
      // 首次写入必须合法（合法 UUID 主键），第二次真正触发 23505
      const p = { id: randomUUID(), name: "dup", cwd: "/d", ownerKey: "o", createdAt: 1 } satisfies ProjectSeed;
      await projects.create(p);
      try {
        await projects.create(p);
        expect.unreachable("应抛 DuplicateIdError");
      } catch (error) {
        expect(error).toBeInstanceOf(DuplicateIdError);
        expect((error as DuplicateIdError).cause).toBeInstanceOf(Error);
        expect(((error as DuplicateIdError).cause as { code?: string }).code).toBe("23505");
      }
    });

    it("sessions.project_id 23503 → ProjectForeignKeyError（合法但不存在的 UUID 写入不存在项目）", async () => {
      // 「合法但不存在」的 UUID：PG 只对合法 uuid 文本执行 FK 检查——非法文本会先报
      // invalid input syntax for type uuid（22P02），不触发 23503
      const sessionId = randomUUID();
      const missingProjectId = randomUUID(); // 合法 UUID，未插入任何项目
      try {
        await sessions.create(session({ id: sessionId, projectId: missingProjectId }));
        expect.unreachable("应抛 ProjectForeignKeyError");
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectForeignKeyError);
        expect(((error as ProjectForeignKeyError).cause as { code?: string }).code).toBe("23503");
      }
    });

    it("复合主键 idempotency_pk 业务冲突不误转（put 走 ON CONFLICT 正常覆盖）", async () => {
      // put 两次同一键：ON CONFLICT DO UPDATE 覆盖，不抛约束错误
      const sid = randomUUID();
      await idempotency.put(sid, "r-pk-1", { status: "first" });
      await idempotency.put(sid, "r-pk-1", { status: "second" });
      expect(await idempotency.get(sid, "r-pk-1")).toEqual({ status: "second" });
    });
  });

  describe("旧 schema 严格兼容性 preflight：任何 DDL 之前 fail-fast（与 SQLite 同契约），失败路径释放自己的 Pool", () => {
    it("旧 managed 表但缺 schema_migrations ledger 时 initializePostgresDatabase 以 legacy fail-closed 拒绝、无 DDL、Pool 已释放", async () => {
      const oldSchema = safeSchemaName();
      const oldPool = new Pool({
        connectionString: withSchemaSearchPath(pgUrl!, oldSchema),
        types: createPgInt8SafeTypes(),
      });
      // 用独立 schema + 独立 Pool：不触碰共享 fixture；bootstrap 失败路径 destroy → 默认会 pool.end
      try {
        await oldPool.query(`CREATE SCHEMA ${oldSchema}`);
        // 构造「表已存在但无 ledger」的 legacy 形态：只建旧的 sessions（缺 Manifest 的
        // capability_versions，且没有 projects / idempotency / schema_migrations）。
        // 严格 preflight 在**任何建表/建索引 DDL 之前**发现库中已含 managed 表但无 ledger
        // → 立即以 legacy fail-closed 拒绝（不允许只建缺失表/只补索引/只补 ledger）。
        await oldPool.query(`
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            owner_key TEXT NOT NULL,
            project_id TEXT NOT NULL,
            title TEXT NOT NULL,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL,
            conversation_ref TEXT,
            model_provider TEXT,
            model_id TEXT,
            thinking_level TEXT,
            system_prompt TEXT
          )
        `);
        // 捕获同一次失败（不得对已因失败关闭的 Pool 再次 initialize）：一次断言 legacy
        // 门禁 fail-closed（managed 表无 ledger → 拒绝采用），另一次断言失败路径已释放 Pool。
        const err = await initializePostgresDatabase(oldPool).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        const message = (err as Error).message;
        // 旧 managed 表但缺 schema_migrations ledger：preflight 在任何 DDL 之前以
        // legacy fail-closed 拒绝（不执行任何 ALTER/补列/建表/建索引），不存在旧「不兼容」文案。
        expect(message).toMatch(/managed tables exist without the migration ledger/);
        expect(message).toMatch(/legacy database/);
        expect(message).toMatch(/apply the single baseline/);
        // 失败路径内 destroy（释放 Pool）：可观测断言（pg-pool 硬错误）
        await expect(oldPool.query("SELECT 1")).rejects.toThrow(/Cannot use a pool after calling end on the pool/);
      } finally {
        // 兜底释放（若失败路径未触发则用独立连接清理自己创建的 schema；严禁触碰 public/连接库）
        if (!(oldPool as { ending?: boolean }).ending) await oldPool.end();
        const cleanupPool = new Pool({ connectionString: pgUrl! });
        try {
          await cleanupPool.query(`DROP SCHEMA IF EXISTS ${oldSchema} CASCADE`);
        } finally {
          await cleanupPool.end();
        }
      }
    });

    it("列名齐全但缺 schema_migrations ledger（即便物理形态完整）→ legacy fail-closed 拒绝，Pool 已释放", async () => {
      const badSchema = safeSchemaName();
      const badPool = new Pool({
        connectionString: withSchemaSearchPath(pgUrl!, badSchema),
        types: createPgInt8SafeTypes(),
      });
      try {
        await badPool.query(`CREATE SCHEMA ${badSchema}`);
        // 3 张表全部存在且列名与 Manifest 完全一致（物理形态足够「完整」），但没有任何
        // schema_migrations ledger。preflight 现在以「managed 表无 ledger = legacy 库」的
        // fail-closed 拒绝 —— ledger 身份是权威，空有表形不再被放行（不执行任何
        // ALTER/补列/建索引）。
        await badPool.query(`
          CREATE TABLE projects (
            id UUID PRIMARY KEY,
            name TEXT NOT NULL,
            cwd TEXT NOT NULL,
            owner_key TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE TABLE sessions (
            id UUID PRIMARY KEY,
            owner_key TEXT NOT NULL,
            project_id UUID NOT NULL DEFAULT '${DEFAULT_PROJECT_ID}'::uuid,
            title TEXT NOT NULL,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL,
            conversation_ref TEXT,
            model_provider TEXT,
            model_id TEXT,
            thinking_level TEXT,
            system_prompt TEXT,
            capability_versions TEXT
          );
          CREATE TABLE idempotency (
            session_id UUID NOT NULL,
            request_id TEXT NOT NULL,
            result TEXT NOT NULL,
            created_at BIGINT NOT NULL,
            PRIMARY KEY (session_id, request_id)
          );
        `);
        const err = await initializePostgresDatabase(badPool).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        const message = (err as Error).message;
        // 同样走 managed 表无 ledger 的 legacy fail-closed（旧「不兼容」文案不再出现）。
        expect(message).toMatch(/managed tables exist without the migration ledger/);
        expect(message).toMatch(/legacy database/);
        expect(message).toMatch(/apply the single baseline/);
        await expect(badPool.query("SELECT 1")).rejects.toThrow(/Cannot use a pool after calling end on the pool/);
      } finally {
        if (!(badPool as { ending?: boolean }).ending) await badPool.end();
        const cleanupPool = new Pool({ connectionString: pgUrl! });
        try {
          await cleanupPool.query(`DROP SCHEMA IF EXISTS ${badSchema} CASCADE`);
        } finally {
          await cleanupPool.end();
        }
      }
    });
  });

  describe("原子 bootstrap（P1）：中途 DDL 失败整库回滚、保持空库、重试成功", () => {
    it("注入失败后事务回滚（无任何残留 managed 表），生产 Manifest 重试建全 schema 成功", async () => {
      const atomicSchema = safeSchemaName();
      const schemaSetupPool = new Pool({
        connectionString: withSchemaSearchPath(pgUrl!, atomicSchema),
        types: createPgInt8SafeTypes(),
      });
      try {
        await schemaSetupPool.query(`CREATE SCHEMA ${atomicSchema}`);
        await schemaSetupPool.end();

        // 注入一份 DDL 中途必失败的 Manifest（索引引用不存在的列；绕过 defineSchema 的
        // 运行期校验，让失败点真实发生在数据库层）：第一张表创建成功后第二个 CREATE INDEX 失败。
        const broken: SchemaManifest = {
          tables: [
            {
              name: "t_first",
              columns: [{ name: "id", type: "uuid", nullable: false }],
              primaryKey: { columns: ["id"] },
              foreignKeys: [],
              indexes: [],
            },
            {
              name: "t_second",
              columns: [{ name: "id", type: "uuid", nullable: false }],
              primaryKey: { columns: ["id"] },
              foreignKeys: [],
              indexes: [{ name: "idx_t_second_missing", columns: [{ name: "missing_column" }] }],
            },
          ],
        };
        const failingPool = new Pool({
          connectionString: withSchemaSearchPath(pgUrl!, atomicSchema),
          types: createPgInt8SafeTypes(),
        });
        const err = await initializePostgresDatabase(failingPool, { manifest: broken }).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/missing_column/);
        // 失败路径内部 destroy 了 Pool（与「失败释放 Pool」既有用例同一可观测契约）。
        await expect(failingPool.query("SELECT 1")).rejects.toThrow(/Cannot use a pool after calling end on the pool/);

        // 事务整体回滚：独立只读连接复查，库中不残留任何 managed 表（t_first 也已回滚）。
        const readerPool = new Pool({
          connectionString: withSchemaSearchPath(pgUrl!, atomicSchema),
          types: createPgInt8SafeTypes(),
        });
        try {
          const remaining = await readerPool.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
            [atomicSchema],
          );
          expect(remaining.rows).toEqual([]);
        } finally {
          await readerPool.end();
        }

        // 重试（生产 Manifest）：空库 preflight 放行，完整 schema 建库成功。
        const retryPool = new Pool({
          connectionString: withSchemaSearchPath(pgUrl!, atomicSchema),
          types: createPgInt8SafeTypes(),
        });
        const retryKysely = await initializePostgresDatabase(retryPool);
        const result = await sql<{ table_name: string }>`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
          ORDER BY table_name
        `.execute(retryKysely);
        expect(result.rows.map((r) => r.table_name)).toEqual(
          expect.arrayContaining(["projects", "sessions", "idempotency"]),
        );
        await retryKysely.destroy();
      } finally {
        if (!(schemaSetupPool as { ending?: boolean }).ending) await schemaSetupPool.end().catch(() => undefined);
        const cleanupPool = new Pool({ connectionString: pgUrl! });
        try {
          await cleanupPool.query(`DROP SCHEMA IF EXISTS ${atomicSchema} CASCADE`);
        } finally {
          await cleanupPool.end();
        }
      }
    });
  });

  describe("Pool 生命周期（独立 Pool/Kysely；共享 fixture 永不由此类用例销毁）", () => {
    it("独立 Pool 的 kysely.destroy() 关闭连接：destroy 后 pool 明确拒绝新查询（可观测断言），不依赖末位执行", async () => {
      // 共享 fixture（pool/kysely）绝不由本用例销毁：这里自建独立 Pool + Kysely 验证关闭语义，
      // 本用例可放在任意位置执行（前面用例/后续用例都不受影响，见文件头「用例顺序无关」说明）。
      const closePool = new Pool({
        connectionString: withSchemaSearchPath(pgUrl!, schema),
        types: createPgInt8SafeTypes(),
      });
      const closeKysely = createPostgresKysely(closePool);
      try {
        // Kysely RuntimeDriver 惰性初始化：必须先跑一条查询，destroy 才会真正走到 PostgresDriver.destroy → pool.end
        await sql`select 1`.execute(closeKysely);
        await closeKysely.destroy();
        // 可观测断言（优先于内部状态）：关闭后的 pool 拒绝新查询，错误信息可断言（pg-pool 的硬错误）
        await expect(closePool.query("SELECT 1")).rejects.toThrow(/Cannot use a pool after calling end on the pool/);
        expect(closePool.ending).toBe(true); // 内部状态仅作次要佐证，不作主断言
      } finally {
        // 兜底释放独立 pool（异常时也不会泄漏连接）；共享 pool 必须仍然可用
        if (!closePool.ending) await closePool.end();
        expect(pool.ending).toBe(false);
        await expect(pool.query("SELECT 1")).resolves.toBeDefined();
      }
    });
  });
});