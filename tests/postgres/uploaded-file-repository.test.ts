import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";
import { createPostgresPool, initializePostgresDatabase } from "../../src/storage/postgres-bootstrap.js";
import { KyselyUploadedFileRepository } from "../../src/storage/kysely-uploaded-file-repository.js";
import {
  UploadedFileClaimError,
  UploadedFileConflictError,
  UploadedFileQuotaError,
} from "../../src/application/ports/uploaded-file-store-port.js";

const pgUrl = process.env.PI_TEST_PG_URL?.trim();
assertRequiredPgTestEnvironment("tests/postgres/uploaded-file-repository", pgUrl, false);
const describePg = pgUrl ? describe : describe.skip;

function schemaName(): string {
  return `pi_upload_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function scopedUrl(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schema}`);
  return parsed.toString();
}

const sample = (overrides: Record<string, unknown> = {}) => ({
  ownerKey: "owner-a",
  projectId: randomUUID(),
  uploadKey: "upload-a",
  name: "report.txt",
  mediaType: "text/plain",
  size: 17,
  checksum: "sha256:abc",
  storageKey: "blobs/report-a",
  agentPath: "uploads/report-a.txt",
  ...overrides,
});

async function seedSession(pool: Pool, owner: string, projectId: string, sessionId: string): Promise<void> {
  await pool.query("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES ($1, 'P', '/p', $2, 1) ON CONFLICT (id) DO NOTHING", [projectId, owner]);
  await pool.query("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at) VALUES ($1, $2, $3, 'S', 1, 1) ON CONFLICT (id) DO NOTHING", [sessionId, owner, projectId]);
}

describePg("KyselyUploadedFileRepository (PostgreSQL)", () => {
  let schema: string;
  let admin: Pool;
  let pool: Pool;
  let store: KyselyUploadedFileRepository;
  let kysely: Awaited<ReturnType<typeof initializePostgresDatabase>>;

  beforeAll(async () => {
    schema = schemaName();
    admin = new Pool({ connectionString: pgUrl! });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = createPostgresPool(scopedUrl(pgUrl!, schema));
    kysely = await initializePostgresDatabase(pool);
    store = new KyselyUploadedFileRepository(kysely, "postgres");
  });

  afterAll(async () => {
    if (kysely) await kysely.destroy().catch(() => undefined);
    if (pool && !pool.ending) await pool.end().catch(() => undefined);
    if (admin) {
      try { if (schema) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
      finally { await admin.end(); }
    }
  });

  it("uses the database unique key for concurrent reservation and rejects a different payload", async () => {
    const payload = sample({ projectId: randomUUID() });
    const [a, b] = await Promise.all([
      store.reserve(payload),
      store.reserve({ ...payload, storageKey: "another-process-path", agentPath: "another-path" }),
    ]);
    expect(a.fileId).toBe(b.fileId);
    expect(a.status).toBe("uploading");
    await expect(store.reserve({ ...payload, checksum: "sha256:different" })).rejects.toBeInstanceOf(UploadedFileConflictError);
    expect(await store.findByUploadKey(payload.ownerKey, payload.projectId, payload.uploadKey)).toMatchObject({ fileId: a.fileId });
  });

  it("reuses an existing same-payload key without charging quota again", async () => {
    const payload = sample({ projectId: randomUUID(), size: 8 });
    const limits = { ownerMaxBytes: 8, globalMaxBytes: 8 };
    const first = await store.reserve(payload, limits);
    expect(await store.reserve({ ...payload, storageKey: "retry-path" }, limits)).toEqual(first);
    await expect(store.reserve({ ...payload, uploadKey: "new-key", size: 1 }, limits))
      .rejects.toMatchObject({ name: "UploadedFileQuotaError", scope: "owner" });
  });

  it("enforces owner limits across uploading/ready records without combining different owners", async () => {
    const projectId = randomUUID();
    const limits = { ownerMaxBytes: 10, globalMaxBytes: 100 };
    await store.reserve(sample({ projectId, size: 4 }), limits);
    await store.createReady(sample({ projectId, uploadKey: "ready-owner-a", size: 3 }));
    await expect(store.reserve(sample({ projectId, uploadKey: "owner-over", size: 4 }), limits))
      .rejects.toMatchObject({ name: "UploadedFileQuotaError", scope: "owner" });
    await expect(store.reserve(sample({ projectId, ownerKey: "owner-b", uploadKey: "owner-b", size: 10 }), limits))
      .resolves.toMatchObject({ ownerKey: "owner-b", size: 10 });
  });

  it("enforces a global limit across owners", async () => {
    const projectId = randomUUID();
    const limits = { ownerMaxBytes: 10, globalMaxBytes: 10 };
    await store.reserve(sample({ projectId, size: 6 }), limits);
    await store.reserve(sample({ projectId, ownerKey: "owner-b", uploadKey: "global-b", size: 4 }), limits);
    await expect(store.reserve(sample({ projectId, ownerKey: "owner-c", uploadKey: "global-c", size: 1 }), limits))
      .rejects.toMatchObject({ name: "UploadedFileQuotaError", scope: "global" });
  });

  it("serializes concurrent reservations so the global quota cannot be exceeded", async () => {
    const projectId = randomUUID();
    const limits = { ownerMaxBytes: 10, globalMaxBytes: 10 };
    const results = await Promise.allSettled([
      store.reserve(sample({ projectId, ownerKey: "owner-a", uploadKey: "concurrent-a", size: 6 }), limits),
      store.reserve(sample({ projectId, ownerKey: "owner-b", uploadKey: "concurrent-b", size: 6 }), limits),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(UploadedFileQuotaError);
      expect(rejected.reason.scope).toBe("global");
    }
  });

  it("claims atomically, makes same-session retries idempotent and rejects another session", async () => {
    const payload = sample({ projectId: randomUUID(), uploadKey: "claim-a" });
    const first = await store.createReady(payload);
    const second = await store.createReady({ ...payload, uploadKey: "claim-b" });
    await expect(store.claimBatch({ ownerKey: payload.ownerKey, projectId: payload.projectId, sessionId: randomUUID(), fileIds: [first.fileId] })).rejects.toBeInstanceOf(UploadedFileClaimError);
    expect((await store.findById(first.fileId))?.sessionId).toBeNull();
    const sessionId = randomUUID();
    await seedSession(pool, payload.ownerKey, payload.projectId, sessionId);
    const claim = { ownerKey: payload.ownerKey, projectId: payload.projectId, sessionId, fileIds: [first.fileId, second.fileId] };
    const claimed = await store.claimBatch(claim);
    expect(await store.claimBatch(claim)).toEqual(claimed);
    const otherSessionId = randomUUID();
    await seedSession(pool, payload.ownerKey, payload.projectId, otherSessionId);
    await expect(store.claimBatch({ ...claim, sessionId: otherSessionId })).rejects.toBeInstanceOf(UploadedFileClaimError);
    const wrongOwnerSessionId = randomUUID();
    await seedSession(pool, "owner-b", payload.projectId, wrongOwnerSessionId);
    await expect(store.claimBatch({ ...claim, sessionId: wrongOwnerSessionId })).rejects.toBeInstanceOf(UploadedFileClaimError);
    const wrongProjectSessionId = randomUUID();
    await seedSession(pool, payload.ownerKey, randomUUID(), wrongProjectSessionId);
    await expect(store.claimBatch({ ...claim, sessionId: wrongProjectSessionId })).rejects.toBeInstanceOf(UploadedFileClaimError);

    const unbound = await store.createReady({ ...payload, uploadKey: "unbound" });
    await expect(store.claimBatch({ ...claim, fileIds: [unbound.fileId, "missing"] })).rejects.toBeInstanceOf(UploadedFileClaimError);
    expect((await store.findById(unbound.fileId))?.sessionId).toBeNull();
  });

  it("keeps uploaded metadata independent of project/session foreign keys", async () => {
    const row = await store.createReady(sample({ projectId: randomUUID() }));
    const result = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM information_schema.table_constraints WHERE table_schema = current_schema() AND table_name = 'uploaded_files' AND constraint_type = 'FOREIGN KEY'");
    expect(result.rows[0]?.count).toBe("0");
    expect(await store.findById(row.fileId)).toEqual(row);
  });
});
