// WP4A real PostgreSQL gate. No URL means skip; this file never falls back to SQLite.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";
import { createPostgresKysely, createPostgresPool } from "../../src/storage/postgres-bootstrap.js";
import { KyselyFileOperationRepository } from "../../src/storage/kysely-file-operation-repository.js";
import { KyselyProjectRepository } from "../../src/storage/kysely-project-repository.js";
import { KyselySessionRepository } from "../../src/storage/kysely-session-repository.js";
import { pgConstraintErrorMapper } from "../../src/storage/pg-constraint-errors.js";
import { migrationDefinitions } from "../../src/storage/migration-manifest.js";
import { runPostgresMigrations, runPostgresMigrationsForTest } from "../../src/storage/migration-engine.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import { artifactDeleteOperationKey } from "../../src/storage/file-operation-policy.js";
import type { ConversationDescriptor } from "../../src/application/ports/conversation-port.js";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";
import type { Kysely } from "kysely";

const pgUrl = process.env.PI_TEST_PG_URL?.trim();
assertRequiredPgTestEnvironment("tests/postgres/file-operation-repository", pgUrl, false);
const describePg = pgUrl ? describe : describe.skip;

function schemaName(): string {
  return `pi_file_ops_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-zA-Z0-9_]/g, "_");
}
function scopedUrl(schema: string): string {
  const url = new URL(pgUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

 describePg("WP4A file_operations outbox（real PostgreSQL）", () => {
  let schema: string;
  let admin: Pool;
  let pool: Pool;
  let kysely: Kysely<DatabaseSchema>;
  let projects: KyselyProjectRepository;
  let sessions: KyselySessionRepository;
  let operations: KyselyFileOperationRepository;

  beforeAll(async () => {
    schema = schemaName();
    admin = new Pool({ connectionString: pgUrl! });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = createPostgresPool(scopedUrl(schema));
    kysely = createPostgresKysely(pool);
    await runPostgresMigrations(kysely);
    operations = new KyselyFileOperationRepository(kysely, "postgres");
    const opts = {
      fileOperations: operations,
      cleanupPlan: ({ sessionId, projectId, conversation }: { sessionId: string; projectId: string; conversation: ConversationDescriptor }) => conversation.conversationRef === null ? null : {
        operationKey: artifactDeleteOperationKey(conversation.agentKind, conversation.conversationFormat, conversation.conversationRef),
        kind: "delete" as const,
        relativePath: conversation.conversationRef,
        sessionId,
        projectId,
      },
    } as const;
    projects = new KyselyProjectRepository(kysely, pgConstraintErrorMapper, opts);
    sessions = new KyselySessionRepository(kysely, pgConstraintErrorMapper, opts);
    await projects.ensureDefaultProject({ id: DEFAULT_PROJECT_ID, name: "默认项目", cwd: "/tmp/default", ownerKey: "", createdAt: 0 });
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE file_operations");
  });

  afterEach(async () => {
    await pool.query("TRUNCATE TABLE file_operations");
  });

  afterAll(async () => {
    await kysely?.destroy().catch(() => undefined);
    if (admin) {
      try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.end(); }
    }
  });

  it("v0 → v1 migration preserves data and creates the same outbox contract", async () => {
    // This test uses a separate random schema/connection so the shared fixture's
    // v1 state is not mutated.
    const isolatedSchema = schemaName();
    const isolatedAdmin = new Pool({ connectionString: pgUrl! });
    const isolatedPool = createPostgresPool(scopedUrl(isolatedSchema));
    const isolated = createPostgresKysely(isolatedPool);
    try {
      await isolatedAdmin.query(`CREATE SCHEMA ${isolatedSchema}`);
      await runPostgresMigrationsForTest(isolated, { migrations: [migrationDefinitions[0]!] });
      await isolatedPool.query(`INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES ('00000000-0000-4000-8000-000000000001', 'kept', '/p', 'o', 1)`);
      await runPostgresMigrations(isolated);
      expect((await isolatedPool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0]?.n).toBe(1);
      expect((await isolatedPool.query("SELECT count(*)::int AS n FROM file_operations")).rows[0]?.n).toBe(0);
      expect((await isolatedPool.query("SELECT name FROM projects WHERE id = '00000000-0000-4000-8000-000000000001'")).rows[0]?.name).toBe("kept");
    } finally {
      await isolated.destroy().catch(() => undefined);
      try { await isolatedAdmin.query(`DROP SCHEMA IF EXISTS ${isolatedSchema} CASCADE`); } finally { await isolatedAdmin.end(); }
    }
  });

  it("independent PG connections interleave lazy reservation and delete without a lock-order race or path-key collision", async () => {
    const firstPool = createPostgresPool(scopedUrl(schema));
    const secondPool = createPostgresPool(scopedUrl(schema));
    const secondKysely = createPostgresKysely(secondPool);
    const secondOperations = new KyselyFileOperationRepository(secondKysely, "postgres");
    const secondSessions = new KyselySessionRepository(secondKysely, pgConstraintErrorMapper, {
      fileOperations: secondOperations,
      cleanupPlan: ({ sessionId, projectId, conversation }: { sessionId: string; projectId: string; conversation: ConversationDescriptor }) => conversation.conversationRef === null ? null : {
        operationKey: artifactDeleteOperationKey(conversation.agentKind, conversation.conversationFormat, conversation.conversationRef),
        kind: "delete" as const,
        relativePath: conversation.conversationRef,
        sessionId,
        projectId,
      },
      dialect: "postgres",
    });
    const holder = await firstPool.connect();
    const projectId = "00000000-0000-4000-8000-000000000020";
    const sessionId = "00000000-0000-4000-8000-000000000021";
    const reservedPath = "projects/p-reserved/sessions/s-reserved/reserved.jsonl";
    const actualPath = "projects/p-reserved/sessions/s-reserved/actual.jsonl";
    try {
      await projects.create({ id: projectId, name: "reservation", cwd: "/p", ownerKey: "owner", createdAt: 1 });
      await sessions.create({
        id: sessionId, ownerKey: "owner", projectId, title: "S", createdAt: 1, updatedAt: 1,
        agentKind: "pi",
        conversationFormat: "pi-jsonl-v3",
        conversationRef: null, modelProvider: null, modelId: null, thinkingLevel: null,
        systemPrompt: null, capabilityVersions: null,
      });

      // Hold the row lock exactly as the lazy reservation UPDATE does. The
      // delete must wait here, then lock/read the row before its outbox write.
      await holder.query("BEGIN");
      await holder.query("UPDATE sessions SET conversation_ref = $1 WHERE id = $2", [reservedPath, sessionId]);
      let deleteFinished = false;
      const deleting = secondSessions.delete(sessionId).then((value) => {
        deleteFinished = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(deleteFinished).toBe(false);
      await holder.query("COMMIT");
      await expect(deleting).resolves.toBe(true);

      // The SDK may have materialized a different path after the reservation.
      // Its fallback enqueue must use a different durable idempotency key.
      await secondOperations.enqueue({
        operationKey: artifactDeleteOperationKey("pi", "pi-jsonl-v3", actualPath),
        relativePath: actualPath,
        sessionId,
        projectId,
        createdAt: 2,
      });
      const rows = await operations.list();
      const ours = rows.filter((row) => row.sessionId === sessionId);
      expect(ours.map((row) => row.relativePath).sort()).toEqual([actualPath, reservedPath].sort());
      expect(new Set(ours.map((row) => row.operationKey)).size).toBe(2);
      expect(ours.find((row) => row.relativePath === reservedPath)?.operationKey)
        .toBe(artifactDeleteOperationKey("pi", "pi-jsonl-v3", reservedPath));
      expect(ours.find((row) => row.relativePath === actualPath)?.operationKey)
        .toBe(artifactDeleteOperationKey("pi", "pi-jsonl-v3", actualPath));
    } finally {
      try { await holder.query("ROLLBACK"); } catch { /* already committed */ }
      holder.release();
      await secondKysely.destroy().catch(() => undefined);
      if (!firstPool.ending) await firstPool.end();
    }
  });

  it("delete + atomic claim/fail/complete matches SQLite semantics and retains outbox after parent delete", async () => {
    const projectId = "00000000-0000-4000-8000-000000000010";
    const sessionId = "00000000-0000-4000-8000-000000000011";
    const relativePath = "projects/p/sessions/s/history.jsonl";
    const operationKey = artifactDeleteOperationKey("pi", "pi-jsonl-v3", relativePath);
    await projects.create({ id: projectId, name: "P", cwd: "/p", ownerKey: "owner", createdAt: 1 });
    await sessions.create({
      id: sessionId, ownerKey: "owner", projectId, title: "S", createdAt: 1, updatedAt: 1,
      agentKind: "pi",
      conversationFormat: "pi-jsonl-v3",
      conversationRef: relativePath, modelProvider: null, modelId: null,
      thinkingLevel: null, systemPrompt: null, capabilityVersions: null,
    });
    await projects.deleteProjectWithSessions(projectId, [sessionId]);
    const row = await operations.getByOperationKey(operationKey);
    expect(row).toMatchObject({ state: "pending", relativePath, sessionId, projectId });
    const claimed = await operations.claim(row!.availableAt, 1, 10);
    expect(claimed).toHaveLength(1);
    expect(await operations.fail(row!.id, new Error("token=secret /Users/private"), 20, claimed[0]!.leaseToken!)).toBe(true);
    expect((await operations.getByOperationKey(operationKey))?.lastError).not.toContain("secret");
    const failed = await operations.getByOperationKey(operationKey);
    const retry = await operations.claim(failed!.availableAt, 1, 10);
    expect(await operations.complete(row!.id, retry[0]!.leaseToken!)).toBe(true);
    expect((await operations.getByOperationKey(operationKey))?.state).toBe("completed");
  });
});
