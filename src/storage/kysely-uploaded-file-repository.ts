// Durable uploaded-file metadata repository shared by SQLite and PostgreSQL.
// This repository never reads, writes, or deletes uploaded file contents.

import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import {
  UploadedFileClaimError,
  UploadedFileConflictError,
  UploadedFileNotFoundError,
  UploadedFileQuotaError,
  UPLOADED_FILE_STATUSES,
  type ClaimUploadedFilesInput,
  type ReserveUploadedFileInput,
  type UploadedFileQuotaLimits,
  type UploadedFileRecord,
  type UploadedFileStatus,
  type UploadedFileStorePort,
} from "../application/ports/uploaded-file-store-port.js";
import type { DatabaseSchema } from "./db-schema.js";
import { withSqliteWriteLock } from "./sqlite-write-lock.js";

export type UploadedFileDialect = "sqlite" | "postgres";
type UploadedFileRow = DatabaseSchema["uploaded_files"];
type UploadState = "uploading" | "ready";

// Stable application-wide key for serializing quota-checked PostgreSQL reservations.
// Advisory locks live in PostgreSQL's lock manager and do not depend on a schema/search_path.
const UPLOADED_FILE_QUOTA_ADVISORY_LOCK_KEY = 0x50494147454e5451n;

function requiredString(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`uploaded file ${field} must be non-empty`);
  return value;
}

function ownerKey(value: string): string {
  if (typeof value !== "string") throw new Error("uploaded file ownerKey must be a string");
  return value;
}

function validSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("uploaded file size must be a non-negative safe integer");
  return value;
}

function validTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("uploaded file createdAt must be a non-negative safe integer");
  return value;
}

function normalizeQuotaLimits(limits: UploadedFileQuotaLimits): UploadedFileQuotaLimits {
  if (!limits || typeof limits !== "object") throw new Error("uploaded file quota limits must be an object");
  if (!Number.isSafeInteger(limits.ownerMaxBytes) || limits.ownerMaxBytes < 0) {
    throw new Error("uploaded file ownerMaxBytes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(limits.globalMaxBytes) || limits.globalMaxBytes < 0) {
    throw new Error("uploaded file globalMaxBytes must be a non-negative safe integer");
  }
  return {
    ownerMaxBytes: limits.ownerMaxBytes,
    globalMaxBytes: limits.globalMaxBytes,
  };
}

function validateStatus(value: string): asserts value is UploadedFileStatus {
  if (!(UPLOADED_FILE_STATUSES as readonly string[]).includes(value)) throw new Error("uploaded file status is invalid");
}

function toRecord(row: UploadedFileRow): UploadedFileRecord {
  validateStatus(row.status);
  return {
    fileId: row.id,
    ownerKey: row.owner_key,
    projectId: row.project_id,
    uploadKey: row.upload_key,
    name: row.name,
    mediaType: row.media_type,
    size: row.size,
    checksum: row.checksum,
    storageKey: row.storage_key,
    agentPath: row.agent_path,
    status: row.status,
    createdAt: row.created_at,
    sessionId: row.session_id,
  };
}

function normalizeInput(input: ReserveUploadedFileInput): {
  ownerKey: string;
  projectId: string;
  uploadKey: string;
  name: string;
  mediaType: string;
  size: number;
  checksum: string;
  storageKey: string;
  agentPath: string;
  createdAt: number;
} {
  return {
    ownerKey: ownerKey(input.ownerKey),
    projectId: requiredString(input.projectId, "projectId"),
    uploadKey: requiredString(input.uploadKey, "uploadKey"),
    name: requiredString(input.name, "name"),
    mediaType: requiredString(input.mediaType, "mediaType"),
    size: validSize(input.size),
    checksum: requiredString(input.checksum, "checksum"),
    storageKey: requiredString(input.storageKey, "storageKey"),
    agentPath: requiredString(input.agentPath, "agentPath"),
    createdAt: validTimestamp(input.createdAt ?? Date.now()),
  };
}

function assertSamePayload(row: UploadedFileRow, input: ReturnType<typeof normalizeInput>): void {
  if (row.checksum !== input.checksum || row.size !== input.size) throw new UploadedFileConflictError();
}

export class KyselyUploadedFileRepository implements UploadedFileStorePort {
  constructor(
    private readonly db: Kysely<DatabaseSchema>,
    readonly dialect: UploadedFileDialect = "sqlite",
  ) {}

  reserve(input: ReserveUploadedFileInput, quotaLimits?: UploadedFileQuotaLimits): Promise<UploadedFileRecord> {
    return this.createOrGet(input, "uploading", quotaLimits);
  }

  createReady(input: ReserveUploadedFileInput): Promise<UploadedFileRecord> {
    return this.createOrGet(input, "ready");
  }

  private createOrGet(
    input: ReserveUploadedFileInput,
    initialStatus: UploadState,
    quotaLimits?: UploadedFileQuotaLimits,
  ): Promise<UploadedFileRecord> {
    const normalized = normalizeInput(input);
    const quotas = quotaLimits === undefined ? undefined : normalizeQuotaLimits(quotaLimits);
    return this.withWriteLock(() => this.db.transaction().execute(async (transaction) => {
      const tx = transaction as unknown as Kysely<DatabaseSchema>;
      if (quotas && this.dialect === "postgres") {
        await sql`SELECT pg_advisory_xact_lock(${UPLOADED_FILE_QUOTA_ADVISORY_LOCK_KEY}::bigint)`.execute(tx);
      }

      const existing = await tx.selectFrom("uploaded_files").selectAll()
        .where("owner_key", "=", normalized.ownerKey)
        .where("project_id", "=", normalized.projectId)
        .where("upload_key", "=", normalized.uploadKey)
        .executeTakeFirst();
      if (existing) {
        assertSamePayload(existing, normalized);
        return toRecord(existing);
      }

      if (quotas) await this.assertWithinQuota(tx, normalized.ownerKey, normalized.size, quotas);

      await tx.insertInto("uploaded_files").values({
        id: randomUUID(),
        owner_key: normalized.ownerKey,
        project_id: normalized.projectId,
        upload_key: normalized.uploadKey,
        name: normalized.name,
        media_type: normalized.mediaType,
        size: normalized.size,
        checksum: normalized.checksum,
        storage_key: normalized.storageKey,
        agent_path: normalized.agentPath,
        status: initialStatus,
        created_at: normalized.createdAt,
        session_id: null,
      }).onConflict((oc) => oc.columns(["owner_key", "project_id", "upload_key"]).doNothing()).execute();

      const row = await tx.selectFrom("uploaded_files").selectAll()
        .where("owner_key", "=", normalized.ownerKey)
        .where("project_id", "=", normalized.projectId)
        .where("upload_key", "=", normalized.uploadKey)
        .executeTakeFirst();
      if (!row) throw new Error("uploaded file reservation did not return its durable record");
      assertSamePayload(row, normalized);
      return toRecord(row);
    }));
  }

  private async assertWithinQuota(
    tx: Kysely<DatabaseSchema>,
    scopedOwner: string,
    requestedSize: number,
    limits: UploadedFileQuotaLimits,
  ): Promise<void> {
    const totals = await tx.selectFrom("uploaded_files").select((eb) => [
      sql<string>`CAST(COALESCE(SUM(CASE WHEN ${eb.ref("owner_key")} = ${scopedOwner} THEN ${eb.ref("size")} ELSE 0 END), 0) AS TEXT)`.as("owner_bytes"),
      sql<string>`CAST(COALESCE(SUM(${eb.ref("size")}), 0) AS TEXT)`.as("global_bytes"),
    ]).where("status", "in", ["uploading", "ready"]).executeTakeFirstOrThrow();
    const requested = BigInt(requestedSize);
    if (BigInt(totals.owner_bytes) + requested > BigInt(limits.ownerMaxBytes)) throw new UploadedFileQuotaError("owner");
    if (BigInt(totals.global_bytes) + requested > BigInt(limits.globalMaxBytes)) throw new UploadedFileQuotaError("global");
  }

  async findById(id: string): Promise<UploadedFileRecord | null> {
    const fileId = requiredString(id, "fileId");
    const row = await this.db.selectFrom("uploaded_files").selectAll().where("id", "=", fileId).executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async findByUploadKey(owner: string, project: string, key: string): Promise<UploadedFileRecord | null> {
    const scopedOwner = ownerKey(owner);
    const scopedProject = requiredString(project, "projectId");
    const uploadKey = requiredString(key, "uploadKey");
    const row = await this.db.selectFrom("uploaded_files").selectAll()
      .where("owner_key", "=", scopedOwner)
      .where("project_id", "=", scopedProject)
      .where("upload_key", "=", uploadKey)
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async completeReady(id: string): Promise<UploadedFileRecord> {
    const fileId = requiredString(id, "fileId");
    return this.withWriteLock(async () => {
      await this.db.updateTable("uploaded_files").set({ status: "ready" })
        .where("id", "=", fileId)
        .where("status", "=", "uploading")
        .execute();
      const row = await this.db.selectFrom("uploaded_files").selectAll().where("id", "=", fileId).executeTakeFirst();
      if (!row) throw new UploadedFileNotFoundError(fileId);
      const record = toRecord(row);
      if (record.status !== "ready") throw new Error(`uploaded file '${fileId}' cannot transition to ready from '${record.status}'`);
      return record;
    });
  }

  async claimBatch(input: ClaimUploadedFilesInput): Promise<UploadedFileRecord[]> {
    const scopedOwner = ownerKey(input.ownerKey);
    const scopedProject = requiredString(input.projectId, "projectId");
    const sessionId = requiredString(input.sessionId, "sessionId");
    const fileIds = input.fileIds.map((id) => requiredString(id, "fileId"));
    if (new Set(fileIds).size !== fileIds.length) throw new UploadedFileClaimError("uploaded file claim batch contains duplicate IDs");
    if (fileIds.length === 0) return [];

    return this.withWriteLock(() => this.db.transaction().execute(async (transaction) => {
      const tx = transaction as unknown as Kysely<DatabaseSchema>;
      const session = this.dialect === "postgres"
        ? await tx.selectFrom("sessions").select("id").where("id", "=", sessionId)
          .where("owner_key", "=", scopedOwner).where("project_id", "=", scopedProject).forUpdate().executeTakeFirst()
        : await tx.selectFrom("sessions").select("id").where("id", "=", sessionId)
          .where("owner_key", "=", scopedOwner).where("project_id", "=", scopedProject).executeTakeFirst();
      if (!session) throw new UploadedFileClaimError("uploaded file claim session is missing or does not match owner/project");

      const rows = this.dialect === "postgres"
        ? await tx.selectFrom("uploaded_files").selectAll().where("id", "in", fileIds).forUpdate().execute()
        : await tx.selectFrom("uploaded_files").selectAll().where("id", "in", fileIds).execute();

      if (rows.length !== fileIds.length || rows.some((row) =>
        row.owner_key !== scopedOwner || row.project_id !== scopedProject || row.status !== "ready" ||
        (row.session_id !== null && row.session_id !== sessionId),
      )) {
        throw new UploadedFileClaimError();
      }

      const unboundIds = rows.filter((row) => row.session_id === null).map((row) => row.id);
      if (unboundIds.length > 0) {
        const updated = await tx.updateTable("uploaded_files").set({ session_id: sessionId })
          .where("id", "in", unboundIds)
          .where("owner_key", "=", scopedOwner)
          .where("project_id", "=", scopedProject)
          .where("status", "=", "ready")
          .where("session_id", "is", null)
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows) !== unboundIds.length) throw new UploadedFileClaimError();
      }

      const claimed = await tx.selectFrom("uploaded_files").selectAll().where("id", "in", fileIds).execute();
      const byId = new Map(claimed.map((row) => [row.id, toRecord(row)]));
      return fileIds.map((fileId) => {
        const record = byId.get(fileId);
        if (!record || record.sessionId !== sessionId) throw new UploadedFileClaimError();
        return record;
      });
    }));
  }

  private withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    return this.dialect === "sqlite" ? withSqliteWriteLock(this.db, action) : action();
  }
}
