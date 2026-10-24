import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import {
  UploadedFileClaimError,
  UploadedFileConflictError,
  UploadedFileQuotaError,
  type ReserveUploadedFileInput,
} from "../../src/application/ports/uploaded-file-store-port.js";
import { KyselyUploadedFileRepository } from "../../src/storage/kysely-uploaded-file-repository.js";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";

const databases: DatabaseSync[] = [];

async function repository(): Promise<{ db: DatabaseSync; kysely: Kysely<DatabaseSchema>; store: KyselyUploadedFileRepository; close(): Promise<void> }> {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const kysely = await initializeDatabase(db);
  return { db, kysely, store: new KyselyUploadedFileRepository(kysely), close: () => kysely.destroy() };
}

async function seedSession(kysely: Kysely<DatabaseSchema>, owner: string, projectId: string, sessionId: string): Promise<void> {
  await kysely.insertInto("projects").values({ id: projectId, name: "P", cwd: "/p", owner_key: owner, created_at: 1 })
    .onConflict((oc) => oc.column("id").doNothing()).execute();
  await kysely.insertInto("sessions").values({
    id: sessionId, owner_key: owner, visibility: "private", origin: "managed", kind: "chat", project_id: projectId, title: "S", created_at: 1, updated_at: 1,
    agent_kind: "pi", conversation_format: "pi-jsonl-v3", conversation_ref: null, model_provider: null,
    model_id: null, thinking_level: null, system_prompt: null, capability_versions: null,
  }).onConflict((oc) => oc.column("id").doNothing()).execute();
}

function input(overrides: Partial<ReserveUploadedFileInput> = {}): ReserveUploadedFileInput {
  return {
    ownerKey: "owner-a",
    projectId: "project-a",
    uploadKey: "upload-a",
    name: "report.txt",
    mediaType: "text/plain",
    size: 17,
    checksum: "sha256:abc",
    storageKey: "blobs/report-a",
    agentPath: "uploads/report-a.txt",
    createdAt: 10,
    ...overrides,
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    try { db.close(); } catch { /* already closed by Kysely */ }
  }
});

describe("KyselyUploadedFileRepository (SQLite)", () => {
  it("atomically reserves upload keys, recovers same-payload retries and rejects payload conflicts", async () => {
    const { store, close } = await repository();
    try {
      const first = await store.reserve(input());
      expect(first).toMatchObject({ status: "uploading", sessionId: null, fileId: expect.any(String) });
      const retry = await store.reserve(input({ storageKey: "retry-must-use-canonical-path", agentPath: "retry-path" }));
      expect(retry).toEqual(first);
      expect(await store.findById(first.fileId)).toEqual(first);
      expect(await store.findByUploadKey("owner-a", "project-a", "upload-a")).toEqual(first);
      await expect(store.reserve(input({ checksum: "sha256:different" }))).rejects.toBeInstanceOf(UploadedFileConflictError);
      await expect(store.reserve(input({ size: 18 }))).rejects.toBeInstanceOf(UploadedFileConflictError);
      expect((await store.findByUploadKey("owner-a", "project-a", "upload-a"))?.fileId).toBe(first.fileId);
    } finally {
      await close();
    }
  });

  it("reuses the same upload key without charging quota twice", async () => {
    const { store, close } = await repository();
    try {
      const limits = { ownerMaxBytes: 8, globalMaxBytes: 8 };
      const reserved = await store.reserve(input({ size: 8 }), limits);
      expect(await store.reserve(input({ size: 8, storageKey: "different-path" }), limits)).toEqual(reserved);
      await expect(store.reserve(input({ uploadKey: "new-key", size: 1 }), limits))
        .rejects.toMatchObject({ name: "UploadedFileQuotaError", scope: "owner" });
    } finally {
      await close();
    }
  });

  it("counts uploading and ready records against only their owner's quota", async () => {
    const { store, close } = await repository();
    try {
      const limits = { ownerMaxBytes: 10, globalMaxBytes: 100 };
      await store.reserve(input({ size: 4 }), limits);
      await store.createReady(input({ uploadKey: "ready-a", size: 3 }));
      await expect(store.reserve(input({ uploadKey: "over-owner", size: 4 }), limits))
        .rejects.toMatchObject({ name: "UploadedFileQuotaError", scope: "owner" });
      await expect(store.reserve(input({ ownerKey: "owner-b", uploadKey: "other-owner", size: 10 }), limits))
        .resolves.toMatchObject({ ownerKey: "owner-b", size: 10 });
    } finally {
      await close();
    }
  });

  it("enforces the global quota across owners", async () => {
    const { store, close } = await repository();
    try {
      const limits = { ownerMaxBytes: 10, globalMaxBytes: 10 };
      await store.reserve(input({ size: 6 }), limits);
      await store.reserve(input({ ownerKey: "owner-b", uploadKey: "global-b", size: 4 }), limits);
      await expect(store.reserve(input({ ownerKey: "owner-c", uploadKey: "global-c", size: 1 }), limits))
        .rejects.toMatchObject({ name: "UploadedFileQuotaError", scope: "global" });
    } finally {
      await close();
    }
  });

  it("serializes concurrent reservations so the global quota cannot be exceeded", async () => {
    const { store, close } = await repository();
    try {
      const limits = { ownerMaxBytes: 10, globalMaxBytes: 10 };
      const results = await Promise.allSettled([
        store.reserve(input({ ownerKey: "owner-a", uploadKey: "concurrent-a", size: 6 }), limits),
        store.reserve(input({ ownerKey: "owner-b", uploadKey: "concurrent-b", size: 6 }), limits),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.status).toBe("rejected");
      if (rejected?.status === "rejected") {
        expect(rejected.reason).toBeInstanceOf(UploadedFileQuotaError);
        expect(rejected.reason.scope).toBe("global");
      }
    } finally {
      await close();
    }
  });

  it("completes a reservation idempotently and creates directly-ready files", async () => {
    const { store, close } = await repository();
    try {
      const reserved = await store.reserve(input());
      expect(await store.completeReady(reserved.fileId)).toMatchObject({ status: "ready" });
      expect(await store.completeReady(reserved.fileId)).toMatchObject({ status: "ready" });
      expect(await store.createReady(input({ uploadKey: "ready-key" }))).toMatchObject({ status: "ready", sessionId: null });
      await expect(store.completeReady("missing-id")).rejects.toThrow(/not found/);
    } finally {
      await close();
    }
  });

  it("claims ready batches atomically, idempotently for one session, and rejects mixed/foreign batches without partial updates", async () => {
    const { store, kysely, close } = await repository();
    try {
      await seedSession(kysely, "owner-a", "project-a", "session-a");
      await seedSession(kysely, "owner-a", "project-a", "session-b");
      const a = await store.createReady(input({ uploadKey: "a" }));
      const b = await store.createReady(input({ uploadKey: "b" }));
      await expect(store.claimBatch({ ownerKey: "owner-a", projectId: "project-a", sessionId: "missing-session", fileIds: [a.fileId] })).rejects.toBeInstanceOf(UploadedFileClaimError);
      expect((await store.findById(a.fileId))?.sessionId).toBeNull();
      const claimed = await store.claimBatch({ ownerKey: "owner-a", projectId: "project-a", sessionId: "session-a", fileIds: [a.fileId, b.fileId] });
      expect(claimed.map((row) => row.sessionId)).toEqual(["session-a", "session-a"]);
      expect(await store.claimBatch({ ownerKey: "owner-a", projectId: "project-a", sessionId: "session-a", fileIds: [a.fileId, b.fileId] })).toEqual(claimed);
      await expect(store.claimBatch({ ownerKey: "owner-a", projectId: "project-a", sessionId: "session-b", fileIds: [a.fileId] })).rejects.toBeInstanceOf(UploadedFileClaimError);

      const stillUnbound = await store.createReady(input({ uploadKey: "still-unbound" }));
      await seedSession(kysely, "owner-a", "project-a", "deleted-before-claim");
      await kysely.deleteFrom("sessions").where("id", "=", "deleted-before-claim").execute();
      await expect(store.claimBatch({ ownerKey: "owner-a", projectId: "project-a", sessionId: "deleted-before-claim", fileIds: [stillUnbound.fileId] })).rejects.toBeInstanceOf(UploadedFileClaimError);
      await seedSession(kysely, "owner-b", "project-a", "wrong-owner-session");
      await expect(store.claimBatch({ ownerKey: "owner-a", projectId: "project-a", sessionId: "wrong-owner-session", fileIds: [stillUnbound.fileId] })).rejects.toBeInstanceOf(UploadedFileClaimError);
      await seedSession(kysely, "owner-a", "project-b", "wrong-project-session");
      await expect(store.claimBatch({ ownerKey: "owner-a", projectId: "project-a", sessionId: "wrong-project-session", fileIds: [stillUnbound.fileId] })).rejects.toBeInstanceOf(UploadedFileClaimError);
      expect((await store.findById(stillUnbound.fileId))?.sessionId).toBeNull();
      await expect(store.claimBatch({ ownerKey: "owner-a", projectId: "project-a", sessionId: "session-a", fileIds: [stillUnbound.fileId, "missing"] })).rejects.toBeInstanceOf(UploadedFileClaimError);
      expect((await store.findById(stillUnbound.fileId))?.sessionId).toBeNull();

      const foreign = await store.createReady(input({ ownerKey: "owner-b", uploadKey: "foreign" }));
      await expect(store.claimBatch({ ownerKey: "owner-a", projectId: "project-a", sessionId: "session-a", fileIds: [stillUnbound.fileId, foreign.fileId] })).rejects.toBeInstanceOf(UploadedFileClaimError);
      expect((await store.findById(stillUnbound.fileId))?.sessionId).toBeNull();

      await kysely.deleteFrom("sessions").where("id", "=", "session-a").execute();
      expect((await store.findById(a.fileId))?.sessionId).toBe("session-a");
    } finally {
      await close();
    }
  });

  it("keeps metadata when projects/sessions are absent or deleted (no cascading foreign keys)", async () => {
    const { db, store, close } = await repository();
    try {
      const row = await store.createReady(input({ projectId: "deleted-project" }));
      expect(await store.findById(row.fileId)).toEqual(row);
      expect(db.prepare("PRAGMA foreign_key_list(uploaded_files)").all()).toEqual([]);
      await db.prepare("DELETE FROM projects WHERE id = ?").run("deleted-project");
      expect(await store.findById(row.fileId)).toEqual(row);
    } finally {
      await close();
    }
  });
});
