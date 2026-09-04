// 共用 Repository 行为契约（H4）—— PostgreSQL 方言注册（PI_TEST_PG_URL 门控）。
// 与 SQLite 侧（tests/storage/repository-contract.sqlite.test.ts）运行同一组契约；
// 每次用例前 TRUNCATE + 重种默认项目（用例顺序无关），共享 Pool/Kysely 由本文件 afterAll 统一释放。
//
// 另含「真实 PG 约束映射」补充（方言专有 DDL，不进共享契约）：
// 在隔离 schema 内临时创建非 id / 复合唯一约束，触发**真实** 23505，断言原样抛出
// （非 DuplicateIdError）且 code/constraint 字段保留 —— 不只是 synthetic 错误。
// 用例内 finally 必 DROP 临时唯一索引，避免污染同 schema 后续用例（schema 最后整体 DROP）。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";
import { randomUUID } from "node:crypto";
import { KyselyProjectRepository } from "../../src/storage/kysely-project-repository.js";
import { KyselySessionRepository } from "../../src/storage/kysely-session-repository.js";
import { KyselyIdempotencyRepository } from "../../src/storage/kysely-idempotency-repository.js";
import { KyselyFileOperationRepository } from "../../src/storage/kysely-file-operation-repository.js";
import { initializePostgresDatabase } from "../../src/storage/postgres-bootstrap.js";
import { createPgInt8SafeTypes } from "../../src/storage/pg-int8.js";
import { pgConstraintErrorMapper, PG_UNIQUE_VIOLATION } from "../../src/storage/pg-constraint-errors.js";
import { DuplicateIdError } from "../../src/application/ports/store-errors.js";
import { identityKey } from "../../src/core/user-identity.js";
import { defineRepositoryContract, DEFAULT_PROJECT_RECORD, type RepositoryContractStorage } from "../storage/repository-contract.js";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";

const pgUrl = process.env.PI_TEST_PG_URL?.trim() || undefined;
assertRequiredPgTestEnvironment("tests/postgres/repository-contract", pgUrl, false);
if (!pgUrl) {
  console.warn(
    "[postgres repository-contract] PI_TEST_PG_URL 未配置：PG 共用契约整组跳过（不尝试连接、不静默通过）；复跑见 docs/postgres-podman-test.md",
  );
}

const describePg = pgUrl ? describe : describe.skip;

function withSchemaSearchPath(url: string, schema: string): string {
  const u = new URL(url);
  u.searchParams.set("options", `-c search_path=${schema}`);
  return u.toString();
}

function safeSchemaName(): string {
  const rand = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `pi_test_${rand}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** PG 约束数据库错误（node-postgres DatabaseError 形态，真实错误由 PG 抛）。 */
type PgConstraintError = Error & { code?: string; constraint?: string; detail?: string };

const OWNER_A = identityKey({ kind: "ip", ip: "10.0.0.1" });

describePg("共用 Repository 行为契约（PostgreSQL，PI_TEST_PG_URL 门控）+ 真实唯一约束 23505", () => {
  let schema: string;
  let pool: Pool;
  let kysely: Kysely<DatabaseSchema>;
  let projects: KyselyProjectRepository;
  let sessions: KyselySessionRepository;
  let idempotency: KyselyIdempotencyRepository;
  let fileOperations: KyselyFileOperationRepository;
  let truncateAndReseed: () => Promise<void>;

  beforeAll(async () => {
    schema = safeSchemaName();
    pool = new Pool({ connectionString: withSchemaSearchPath(pgUrl!, schema), types: createPgInt8SafeTypes() });
    await pool.query(`CREATE SCHEMA ${schema}`);
    kysely = await initializePostgresDatabase(pool);
    fileOperations = new KyselyFileOperationRepository(kysely, "postgres");
    const fileOperationOptions = { fileOperations, relativePath: (filePath: string) => filePath } as const;
    projects = new KyselyProjectRepository(kysely, pgConstraintErrorMapper, fileOperationOptions);
    sessions = new KyselySessionRepository(kysely, pgConstraintErrorMapper, fileOperationOptions);
    idempotency = new KyselyIdempotencyRepository(kysely);
    truncateAndReseed = async () => {
      await pool.query(`TRUNCATE TABLE file_operations, idempotency, sessions, projects CASCADE`);
      await projects.ensureDefaultProject(DEFAULT_PROJECT_RECORD);
    };
  });

  afterAll(async () => {
    // 独立清理：setup 失败时不得访问未初始化对象（schema / kysely 可能未赋值）；destroy 错误
    // 不掩盖 beforeAll 等原始失败（vitest 已记录其错误）。共享 Pool/Kysely 由本处统一释放。
    try {
      if (kysely) await kysely.destroy();
    } catch {
      // 忽略次要清理错误
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

  defineRepositoryContract(
    "共用 Repository 行为契约（PostgreSQL，每个用例 TRUNCATE + 重种默认项目）",
    async (): Promise<RepositoryContractStorage> => {
      await truncateAndReseed();
      return { kysely, projects, sessions, idempotency, close: async () => {} };
    },
  );

  describe("真实 PG 约束：非 id / 复合唯一约束的 23505 原样抛出（不污染有界重试）", () => {
    beforeEach(async () => {
      await truncateAndReseed();
    });

    it("单列非 id 唯一索引（projects.owner_key）→ 真实 23505 原样抛出，code/constraint 保留（真实 DDL，非 synthetic）", async () => {
      const indexName = `contract_uk_owner_${Date.now().toString(36)}`;
      await pool.query(`CREATE UNIQUE INDEX ${indexName} ON projects(owner_key)`);
      try {
        const ownerP1 = identityKey({ kind: "ip", ip: "10.77.0.1" });
        const ownerP2 = identityKey({ kind: "ip", ip: "10.77.0.2" });
        await projects.create({ id: randomUUID(), name: "项目1", cwd: "/p1", ownerKey: ownerP1, createdAt: 1 });
        await projects.create({ id: randomUUID(), name: "项目2", cwd: "/p2", ownerKey: ownerP2, createdAt: 2 });
        // 第三行 owner 撞 ownerP1：唯一索引在非 id 列上冲突，必须触发真实 23505
        const err = await projects
          .create({ id: randomUUID(), name: "项目3", cwd: "/p3", ownerKey: ownerP1, createdAt: 3 })
          .then(() => null, (e: unknown) => e) as PgConstraintError | null;
        expect(err).toBeDefined();
        // 仅「表自身单列 id 主键」才映射 DuplicateIdError：非 id 唯一约束必须原样抛出
        expect(err).not.toBeInstanceOf(DuplicateIdError);
        // 真实 SQLSTATE 与约束名保留（synthetic 无法覆盖这两点）
        expect(err!.code).toBe(PG_UNIQUE_VIOLATION);
        expect(err!.constraint).toBe(indexName);
      } finally {
        // 删除临时索引，避免影响同 schema 内后续用例（含共享契约的 same-owner 用例）
        await pool.query(`DROP INDEX IF EXISTS ${indexName}`);
      }
    });

    it("复合唯一约束（owner_key + name）→ 真实 23505 原样抛出（复合/非 id 不误转 DuplicateIdError，消息含逗号不误转）", async () => {
      const indexName = `contract_uk_owner_name_${Date.now().toString(36)}`;
      await pool.query(`CREATE UNIQUE INDEX ${indexName} ON projects(owner_key, name)`);
      try {
        const seed = { id: randomUUID(), name: "同名", cwd: "/p", ownerKey: OWNER_A, createdAt: 1 };
        await projects.create(seed);
        // 真实构造冲突：同 owner + 同名（复合唯一约束）；Repository 只做查询/行映射，约束由数据库强制
        const err = await projects
          .create({ ...seed, id: randomUUID() })
          .then(() => null, (e: unknown) => e) as PgConstraintError | null;
        expect(err).toBeDefined();
        expect(err).not.toBeInstanceOf(DuplicateIdError);
        expect(err!.code).toBe(PG_UNIQUE_VIOLATION);
        expect(err!.constraint).toBe(indexName);
      } finally {
        await pool.query(`DROP INDEX IF EXISTS ${indexName}`);
      }
    });
  });
});