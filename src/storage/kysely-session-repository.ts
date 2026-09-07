// 会话索引的中立 Kysely 实现（needs.md §4.1，方言无关：SQLite/PG 共用）。
// 与 KyselyProjectRepository 共用同一个 Kysely/数据库实例；建表统一由各方言 bootstrap
// 消费同一 Manifest 负责，本类仅负责查询与行映射。方言约束错误映射由构造函数注入
// ConstraintErrorMapper（SQLite/PG 各自实现），本类不识别任何底层错误码。

import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./db-schema.js";
import type {
  ConversationReservationInput,
  SessionRecord,
  SessionRecordPatch,
  SessionStorePort,
} from "../application/ports/session-store-port.js";
import type { ConstraintErrorMapper } from "./constraint-error-mapper.js";
import type { ConversationCleanupPlan, ConversationDescriptor } from "../application/ports/conversation-port.js";
import { KyselyFileOperationRepository, type FileOperationTransactionWriter } from "./kysely-file-operation-repository.js";
import { acquireTombstoneAdvisoryXactLock } from "./pg-advisory-lock.js";
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
    agentKind: row.agent_kind,
    conversationFormat: row.conversation_format,
    conversationRef: row.conversation_ref,
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
  /** 将通用会话引用转换为事务内可入队的清理操作；具体格式由 Agent storage 实现解释。 */
  readonly cleanupPlan?: (input: {
    readonly sessionId: string;
    readonly projectId: string;
    readonly conversation: ConversationDescriptor;
  }) => ConversationCleanupPlan | null;
  readonly dialect?: "sqlite" | "postgres";
}

export class KyselySessionRepository implements SessionStorePort {
  private readonly db: Kysely<DatabaseSchema>;
  private readonly constraintMapper: ConstraintErrorMapper;
  private readonly fileOperations: FileOperationTransactionWriter;
  private readonly cleanupPlan?: KyselySessionRepositoryOptions["cleanupPlan"];
  private readonly dialect: "sqlite" | "postgres";

  constructor(db: Kysely<DatabaseSchema>, constraintMapper: ConstraintErrorMapper, options: KyselySessionRepositoryOptions = {}) {
    this.db = db;
    this.constraintMapper = constraintMapper;
    this.fileOperations = options.fileOperations ?? new KyselyFileOperationRepository(db);
    this.cleanupPlan = options.cleanupPlan;
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
            agent_kind: record.agentKind,
            conversation_format: record.conversationFormat,
            conversation_ref: record.conversationRef,
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
    // 只把显式提供的元数据字段写入（patch 字段可选）；conversation_ref
    // 只能经 reservation/commit/release 生命周期 API 修改，不能被普通 update 绕过。
    const set: Partial<SessionRow> = {};
    if (patch.title !== undefined && patch.title !== null) set.title = patch.title;
    if (patch.updatedAt !== undefined && patch.updatedAt !== null) set.updated_at = patch.updatedAt;
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

  async reserveConversation(id: string, reservation: ConversationReservationInput): Promise<boolean> {
    if (reservation.conversationRef.length === 0) throw new Error("conversation reference must be non-empty");
    if (reservation.tombstoneOperationKey.length === 0) {
      throw new Error("tombstone operation key must be non-empty");
    }
    return this.withWriteLock(() => this.db.transaction().execute(async (transaction) => {
      const tx = transaction as unknown as Kysely<DatabaseSchema>;
      // 与 session/project delete 对同一 tombstone operationKey 的 outbox 写入串行化：
      // PG 先取 transaction-scoped advisory lock，再执行 NOT EXISTS 条件 update，确保
      // 子查询看到的是已经提交的 tombstone 状态；SQLite 由 BEGIN IMMEDIATE +
      // withSqliteWriteLock 承担同一串行化。
      if (this.dialect === "postgres") {
        await acquireTombstoneAdvisoryXactLock(tx, reservation.tombstoneOperationKey);
      }
      // 同一条件更新内同时要求：conversation_ref 仍为 NULL，且 file_operations
      // 不存在该 operation_key。无论 tombstone 处于 pending/processing/completed/failed
      // 任一状态，都视为已被删除而禁止复用（永久 tombstone）。SQLite/PG 语义一致。
      const result = await tx
        .updateTable("sessions")
        .set({ conversation_ref: reservation.conversationRef })
        .where("id", "=", id)
        .where("conversation_ref", "is", null)
        .where(({ not, exists }) => not(exists(
          tx
            .selectFrom("file_operations")
            .select("operation_key")
            .where("operation_key", "=", reservation.tombstoneOperationKey),
        )))
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    }));
  }

  async commitConversationReservation(id: string, expectedRef: string, actualRef: string): Promise<boolean> {
    if (expectedRef.length === 0 || actualRef.length === 0) {
      throw new Error("conversation reference must be non-empty");
    }
    return this.withWriteLock(async () => {
      const result = await this.db
        .updateTable("sessions")
        .set({ conversation_ref: actualRef })
        .where("id", "=", id)
        .where("conversation_ref", "=", expectedRef)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    });
  }

  async releaseConversationReservation(id: string, expectedRef: string): Promise<boolean> {
    if (expectedRef.length === 0) throw new Error("conversation reference must be non-empty");
    return this.withWriteLock(async () => {
      const result = await this.db
        .updateTable("sessions")
        .set({ conversation_ref: null })
        .where("id", "=", id)
        .where("conversation_ref", "=", expectedRef)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
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
        ? (await sql<{
            id: string;
            project_id: string;
            agent_kind: string;
            conversation_format: string;
            conversation_ref: string | null;
          }>`
            SELECT id, project_id, agent_kind, conversation_format, conversation_ref FROM "sessions" WHERE id = ${id} FOR UPDATE
          `.execute(tx)).rows[0]
        : await tx
            .selectFrom("sessions")
            .select(["id", "project_id", "agent_kind", "conversation_format", "conversation_ref"])
            .where("id", "=", id)
            .executeTakeFirst();
      if (!existing) return false;
      if (existing.conversation_ref !== null) {
        // 非空 conversation identity 由 idx_sessions_conversation 唯一约束独占：
        // 同 (agent_kind, conversation_format, conversation_ref) 至多一个会话。
        // 删除本会话即代表该实际引用不再被任何会话引用，直接登记清理，无需再检查共享引用。
        if (!this.cleanupPlan) throw new Error("conversation cleanup planner is not configured");
        const plan = this.cleanupPlan({
          sessionId: existing.id,
          projectId: existing.project_id,
          conversation: {
            agentKind: existing.agent_kind,
            conversationFormat: existing.conversation_format,
            conversationRef: existing.conversation_ref,
          },
        });
        if (plan) {
          // 与 reserveConversation 对同一 operationKey 的 tombstone 检查串行化：
          // 先取 PG advisory xact lock，再写入同一 artifact delete outbox，再删除会话。
          if (this.dialect === "postgres") {
            await acquireTombstoneAdvisoryXactLock(tx, plan.operationKey);
          }
          await this.fileOperations.enqueueInTransaction(tx, {
            ...plan,
            createdAt: Date.now(),
          });
        }
      }
      const result = await tx.deleteFrom("sessions").where("id", "=", id).executeTakeFirst();
      return Number(result?.numDeletedRows ?? 0) > 0;
    }));
  }

  private withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    return this.dialect === "sqlite" ? withSqliteWriteLock(this.db, action) : action();
  }
}