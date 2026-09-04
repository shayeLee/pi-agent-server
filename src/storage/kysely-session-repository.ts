// 会话索引的中立 Kysely 实现（needs.md §4.1，方言无关：SQLite/PG 共用）。
// 与 KyselyProjectRepository 共用同一个 Kysely/数据库实例；建表统一由各方言 bootstrap
// 消费同一 Manifest 负责，本类仅负责查询与行映射。方言约束错误映射由构造函数注入
// ConstraintErrorMapper（SQLite/PG 各自实现），本类不识别任何底层错误码。

import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./db-schema.js";
import type {
  SessionRecord,
  SessionRecordPatch,
  SessionStorePort,
} from "../application/ports/session-store-port.js";
import type { ConstraintErrorMapper } from "./constraint-error-mapper.js";
import { KyselyFileOperationRepository, type FileOperationTransactionWriter } from "./kysely-file-operation-repository.js";
import { relativeWhitelistedPath, sessionDeleteOperationKey } from "./file-operation-policy.js";
import { withSqliteWriteLock } from "./sqlite-write-lock.js";

// 表行形态直接引用由 Schema Manifest 推导的 DatabaseSchema（无第二份手工声明）。
type SessionRow = DatabaseSchema["sessions"];

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    ownerKey: row.owner_key,
    projectId: row.project_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    piSessionFile: row.pi_session_file,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    thinkingLevel: row.thinking_level,
    systemPrompt: row.system_prompt,
    capabilityVersions: row.capability_versions,
  };
}

export interface KyselySessionRepositoryOptions {
  /** 共享的 file_operations writer；必须与本 repository 使用同一 Kysely/事务。 */
  readonly fileOperations?: FileOperationTransactionWriter;
  /** 将 DB 中的历史绝对 pi_session_file 转为 DATA_DIR 下的相对路径。 */
  readonly relativePath?: (filePath: string) => string;
  readonly dialect?: "sqlite" | "postgres";
}

export class KyselySessionRepository implements SessionStorePort {
  private readonly db: Kysely<DatabaseSchema>;
  private readonly constraintMapper: ConstraintErrorMapper;
  private readonly fileOperations: FileOperationTransactionWriter;
  private readonly relativePath: (filePath: string) => string;
  private readonly dialect: "sqlite" | "postgres";

  constructor(db: Kysely<DatabaseSchema>, constraintMapper: ConstraintErrorMapper, options: KyselySessionRepositoryOptions = {}) {
    this.db = db;
    this.constraintMapper = constraintMapper;
    this.fileOperations = options.fileOperations ?? new KyselyFileOperationRepository(db);
    this.relativePath = options.relativePath ?? ((filePath) => relativeWhitelistedPath("/", filePath));
    this.dialect = options.dialect ??
      (options.fileOperations instanceof KyselyFileOperationRepository ? options.fileOperations.dialect : undefined) ??
      constraintMapper.dialect ?? "sqlite";
  }

  async create(record: SessionRecord): Promise<void> {
    await this.withWriteLock(async () => {
      try {
        await this.db
          .insertInto("sessions")
          .values({
            id: record.id,
            owner_key: record.ownerKey,
            project_id: record.projectId,
            title: record.title,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
            pi_session_file: record.piSessionFile,
            model_provider: record.modelProvider,
            model_id: record.modelId,
            thinking_level: record.thinkingLevel,
            system_prompt: record.systemPrompt,
            capability_versions: record.capabilityVersions,
          })
          .execute();
      } catch (error) {
        // FK（并发删除项目竞态）→ 存储无关 ProjectForeignKeyError；
        // 撞 id 主键/唯一约束 → 存储无关 DuplicateIdError（应用层有界重试）；其余错误原样抛出
        if (this.constraintMapper.isForeignKeyError(error)) {
          this.constraintMapper.throwProjectForeignKeyOrOriginal(error);
        }
        this.constraintMapper.throwDuplicateIdOrOriginal(error, "sessions");
      }
    });
  }

  async get(id: string): Promise<SessionRecord | null> {
    const row = await this.db
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async listByOwner(ownerKey: string): Promise<SessionRecord[]> {
    const rows = await this.db
      .selectFrom("sessions")
      .selectAll()
      .where("owner_key", "=", ownerKey)
      .orderBy("updated_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return rows.map(toRecord);
  }

  async listByProject(ownerKey: string, projectId: string): Promise<SessionRecord[]> {
    const rows = await this.db
      .selectFrom("sessions")
      .selectAll()
      .where("owner_key", "=", ownerKey)
      .where("project_id", "=", projectId)
      .orderBy("updated_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return rows.map(toRecord);
  }

  async backfillSystemPrompt(systemPrompt: string): Promise<number> {
    return this.withWriteLock(async () => {
      const result = await this.db
        .updateTable("sessions")
        .set({ system_prompt: systemPrompt })
        .where("system_prompt", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    });
  }

  async update(id: string, patch: SessionRecordPatch): Promise<boolean> {
    return this.withWriteLock(async () => {
    // 只把显式提供的字段写入（patch 字段可选）；null 视为「未提供」，与旧 COALESCE(?, col) 语义一致
    // （旧实现用 null → 保持原值，无法置空）。应用层也约定不用 null 表示未提供（见 session-service）。
    const set: Partial<SessionRow> = {};
    if (patch.title !== undefined && patch.title !== null) set.title = patch.title;
    if (patch.updatedAt !== undefined && patch.updatedAt !== null) set.updated_at = patch.updatedAt;
    if (patch.piSessionFile !== undefined && patch.piSessionFile !== null)
      set.pi_session_file = patch.piSessionFile;
    if (patch.modelProvider !== undefined && patch.modelProvider !== null)
      set.model_provider = patch.modelProvider;
    if (patch.modelId !== undefined && patch.modelId !== null) set.model_id = patch.modelId;
    if (patch.thinkingLevel !== undefined && patch.thinkingLevel !== null)
      set.thinking_level = patch.thinkingLevel;
    if (patch.systemPrompt !== undefined && patch.systemPrompt !== null)
      set.system_prompt = patch.systemPrompt;

    if (Object.keys(set).length === 0) {
      // 无字段可更新（如仅传 null）：按存在性判定（与旧实现 COALESCE 全 null 时 changes=0 一致）
      return (await this.get(id)) !== null;
    }

    const result = await this.db
      .updateTable("sessions")
      .set(set)
      .where("id", "=", id)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) > 0) return true;
    // 相同值更新时 numAffected=0，行仍存在 → 按存在性判定（SQLite 是 changes=0；PG 同语义）
    return (await this.get(id)) !== null;
    });
  }

  async delete(id: string): Promise<boolean> {
    // 删除与 file_operations enqueue 处于同一事务；enqueue 失败时会话也保留。
    // PG lock order is session row -> outbox unique key -> session DELETE,
    // matching the lazy reservation/actual-path fallback (session UPDATE
    // first, then enqueue) and avoiding a session/outbox lock inversion.
    return this.withWriteLock(() => this.db.transaction().execute(async (transaction) => {
      const tx = transaction as unknown as Kysely<DatabaseSchema>;
      const existing = this.dialect === "postgres"
        ? (await sql<{ id: string; project_id: string; pi_session_file: string | null }>`
            SELECT id, project_id, pi_session_file FROM "sessions" WHERE id = ${id} FOR UPDATE
          `.execute(tx)).rows[0]
        : await tx
            .selectFrom("sessions")
            .select(["id", "project_id", "pi_session_file"])
            .where("id", "=", id)
            .executeTakeFirst();
      if (!existing) return false;
      if (existing.pi_session_file !== null) {
        const relativePath = this.relativePath(existing.pi_session_file);
        await this.fileOperations.enqueueInTransaction(tx, {
          operationKey: sessionDeleteOperationKey(existing.id, relativePath),
          kind: "delete",
          relativePath,
          sessionId: existing.id,
          projectId: existing.project_id,
          createdAt: Date.now(),
        });
      }
      const result = await tx.deleteFrom("sessions").where("id", "=", id).executeTakeFirst();
      return Number(result?.numDeletedRows ?? 0) > 0;
    }));
  }

  private withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    return this.dialect === "sqlite" ? withSqliteWriteLock(this.db, action) : action();
  }
}