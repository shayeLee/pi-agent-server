// file_operations 持久 outbox 的 Kysely 实现（SQLite / PostgreSQL 共用）。
// 本 repository 只写入/预留状态，不执行 unlink；未来 worker 必须在 claim 后自行执行副作用。

import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type {
  EnqueueFileOperationInput,
  FileOperationRecord,
  FileOperationState,
  FileOperationStorePort,
} from "../application/ports/file-operation-store-port.js";
import { FILE_OPERATION_STATES } from "../application/ports/file-operation-store-port.js";
import type { DatabaseSchema } from "./db-schema.js";
import { withSqliteWriteLock } from "./sqlite-write-lock.js";
import {
  assertFileOperationKind,
  FileOperationStateError,
  assertWhitelistedRelativePath,
  canonicalFileOperationErrorCode,
  isFileOperationErrorCodeAllowlisted,
  isRedactedFileOperationError,
} from "./file-operation-policy.js";

export type FileOperationDialect = "sqlite" | "postgres";

/** 删除 repository 也要使用的同事务 enqueue 输入。 */
export type FileOperationTransactionInput = EnqueueFileOperationInput & { createdAt: number };

export interface FileOperationTransactionWriter {
  enqueueInTransaction(
    transaction: Kysely<DatabaseSchema>,
    input: FileOperationTransactionInput,
  ): Promise<FileOperationRecord>;
}

type FileOperationRow = DatabaseSchema["file_operations"];

function toRecord(row: FileOperationRow): FileOperationRecord {
  assertFileOperationKind(row.kind);
  state(row.state);
  if (row.last_error !== null && (!isRedactedFileOperationError(row.last_error) || !isFileOperationErrorCodeAllowlisted(row.last_error))) {
    throw new FileOperationStateError("file operation last_error is not a canonical allowlisted error code or exceeds 1000 bytes");
  }
  const relativePath = assertWhitelistedRelativePath(row.relative_path);
  return {
    id: row.id,
    operationKey: row.operation_key,
    kind: row.kind as FileOperationRecord["kind"],
    relativePath,
    sessionId: row.session_id,
    projectId: row.project_id,
    state: row.state as FileOperationState,
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    leaseUntil: row.lease_until,
    leaseToken: row.lease_token,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`file operation ${field} must be a non-negative safe integer`);
  return value;
}

function operationKey(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 1024) {
    throw new Error("file operation operationKey must be non-empty and at most 1024 characters");
  }
  return value;
}

function leaseToken(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("file operation leaseToken is required");
  }
  return value;
}

function state(value: string): asserts value is FileOperationState {
  if (!(FILE_OPERATION_STATES as readonly string[]).includes(value)) {
    throw new Error("file operation state is invalid");
  }
}

function kind(value: string): asserts value is FileOperationRecord["kind"] {
  assertFileOperationKind(value);
}

function rowFromResult(rows: readonly FileOperationRow[]): FileOperationRecord | null {
  const row = rows[0];
  return row ? toRecord(row) : null;
}

export class KyselyFileOperationRepository implements FileOperationStorePort, FileOperationTransactionWriter {
  private readonly db: Kysely<DatabaseSchema>;
  /** Exposed so repositories sharing this concrete writer can select the same dialect locking rules. */
  readonly dialect: FileOperationDialect;

  constructor(db: Kysely<DatabaseSchema>, dialect: FileOperationDialect = "sqlite") {
    this.db = db;
    this.dialect = dialect;
  }

  async enqueue(input: EnqueueFileOperationInput): Promise<FileOperationRecord> {
    return this.withWriteLock(() => this.db.transaction().execute(async (transaction) =>
      this.enqueueInTransaction(transaction as unknown as Kysely<DatabaseSchema>, {
        ...input,
        createdAt: input.createdAt ?? Date.now(),
      })));
  }

  async enqueueInTransaction(
    transaction: Kysely<DatabaseSchema>,
    input: FileOperationTransactionInput,
  ): Promise<FileOperationRecord> {
    const key = operationKey(input.operationKey);
    const relativePath = assertWhitelistedRelativePath(input.relativePath);
    const operationKind = input.kind ?? "delete";
    kind(operationKind);
    const createdAt = validTimestamp(input.createdAt, "createdAt");
    const sessionId = input.sessionId ?? null;
    const projectId = input.projectId ?? null;

    // DO NOTHING is intentional: a retried delete must not reset a completed or
    // leased operation. The unique key is the durable idempotency boundary.
    await transaction
      .insertInto("file_operations")
      .values({
        id: randomUUID(),
        operation_key: key,
        kind: operationKind,
        relative_path: relativePath,
        session_id: sessionId,
        project_id: projectId,
        state: "pending",
        attempt_count: 0,
        available_at: createdAt,
        lease_until: null,
        lease_token: null,
        last_error: null,
        created_at: createdAt,
        updated_at: createdAt,
      })
      .onConflict((oc) => oc.column("operation_key").doNothing())
      .execute();

    const row = await transaction
      .selectFrom("file_operations")
      .selectAll()
      .where("operation_key", "=", key)
      .executeTakeFirst();
    if (!row) throw new Error("file operation enqueue did not return its durable record");
    return toRecord(row);
  }

  async get(id: string): Promise<FileOperationRecord | null> {
    const row = await this.db.selectFrom("file_operations").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async getByOperationKey(key: string): Promise<FileOperationRecord | null> {
    const row = await this.db
      .selectFrom("file_operations")
      .selectAll()
      .where("operation_key", "=", operationKey(key))
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async list(filterState?: FileOperationState): Promise<FileOperationRecord[]> {
    if (filterState !== undefined) state(filterState);
    const query = this.db.selectFrom("file_operations").selectAll().orderBy("created_at", "asc").orderBy("id", "asc");
    const rows = filterState === undefined
      ? await query.execute()
      : await query.where("state", "=", filterState).execute();
    return rows.map(toRecord);
  }

  /**
   * SQLite 使用单条 UPDATE ... RETURNING 反复预留，UPDATE 本身取得写锁；
   * PostgreSQL 使用 FOR UPDATE SKIP LOCKED + UPDATE 的同一事务。两者都不
   * 存在「先 select、后 update」的可重复 claim 窗口。
   */
  async claim(now = Date.now(), limit = 1, leaseMs = 60_000): Promise<FileOperationRecord[]> {
    validTimestamp(now, "now");
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("file operation claim limit must be a non-negative safe integer");
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("file operation leaseMs must be a positive safe integer");
    const leaseUntil = validTimestamp(now + leaseMs, "leaseUntil");

    return this.withWriteLock(() => this.db.transaction().execute(async (transaction) => {
      const tx = transaction as unknown as Kysely<DatabaseSchema>;
      const claimed: FileOperationRecord[] = [];
      for (let index = 0; index < limit; index++) {
        const token = randomUUID();
        const result = this.dialect === "postgres"
          ? await sql<FileOperationRow>`
              WITH candidate AS (
                SELECT id
                FROM file_operations
                WHERE (
                  (state IN ('pending', 'failed') AND available_at <= ${now})
                  OR (state = 'processing' AND lease_until IS NOT NULL AND lease_until <= ${now})
                )
                ORDER BY available_at ASC, created_at ASC, id ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
              )
              UPDATE file_operations AS operation
              SET state = 'processing',
                  attempt_count = operation.attempt_count + 1,
                  lease_until = ${leaseUntil},
                  lease_token = ${token},
                  updated_at = ${now}
              FROM candidate
              WHERE operation.id = candidate.id
              RETURNING operation.*
            `.execute(tx)
          : await sql<FileOperationRow>`
              UPDATE file_operations
              SET state = 'processing',
                  attempt_count = attempt_count + 1,
                  lease_until = ${leaseUntil},
                  lease_token = ${token},
                  updated_at = ${now}
              WHERE id = (
                SELECT id
                FROM file_operations
                WHERE (
                  (state IN ('pending', 'failed') AND available_at <= ${now})
                  OR (state = 'processing' AND lease_until IS NOT NULL AND lease_until <= ${now})
                )
                ORDER BY available_at ASC, created_at ASC, id ASC
                LIMIT 1
              )
              RETURNING *
            `.execute(tx);
        const record = rowFromResult(result.rows);
        if (!record) break;
        claimed.push(record);
      }
      return claimed;
    }));
  }

  async complete(id: string, token: string): Promise<boolean> {
    const lease = leaseToken(token);
    // A lease must still be fenced as a processing lease.  The token equality
    // is the ownership check; requiring a non-null lease_until also rejects
    // malformed processing rows rather than silently completing them.
    return this.withWriteLock(async () => {
      const result = await this.db
        .updateTable("file_operations")
        .set({ state: "completed", lease_until: null, lease_token: null, updated_at: Date.now() })
        .where("id", "=", id)
        .where("state", "=", "processing")
        .where("lease_token", "=", lease)
        .where("lease_until", "is not", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    });
  }

  async fail(id: string, error: unknown, nextAttemptAt: number | undefined, token: string): Promise<boolean> {
    const lease = leaseToken(token);
    const availableAt = validTimestamp(nextAttemptAt ?? Date.now(), "nextAttemptAt");
    return this.withWriteLock(async () => {
      const result = await this.db
        .updateTable("file_operations")
        .set({
          state: "failed",
          available_at: availableAt,
          lease_until: null,
          lease_token: null,
          last_error: canonicalFileOperationErrorCode(error),
          updated_at: Date.now(),
        })
        .where("id", "=", id)
        .where("state", "=", "processing")
        .where("lease_token", "=", lease)
        .where("lease_until", "is not", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    });
  }

  private withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    return this.dialect === "sqlite" ? withSqliteWriteLock(this.db, action) : action();
  }
}
