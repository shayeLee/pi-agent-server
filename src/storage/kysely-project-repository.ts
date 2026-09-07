// 项目索引的中立 Kysely 实现（多项目，方言无关：SQLite/PG 共用）。
// 与 KyselySessionRepository 共用同一个 Kysely/数据库实例；建表统一由各方言 bootstrap
// （bootstrap.ts / postgres-bootstrap.ts 消费同一 Manifest）负责，本类仅负责查询与行映射。
// 方言约束错误映射由构造函数注入 ConstraintErrorMapper（SQLite/PG 各自实现），
// 本类不识别任何底层错误码。

import { sql, type Kysely } from "kysely";
import {
  DEFAULT_PROJECT_ID,
  type ProjectRecord,
  type ProjectStorePort,
} from "../application/ports/project-store-port.js";
import type { DatabaseSchema } from "./db-schema.js";
import type { ConstraintErrorMapper } from "./constraint-error-mapper.js";
import type { ConversationCleanupPlan, ConversationDescriptor } from "../application/ports/conversation-port.js";
import { KyselyFileOperationRepository, type FileOperationTransactionWriter } from "./kysely-file-operation-repository.js";
import { acquireTombstoneAdvisoryXactLock } from "./pg-advisory-lock.js";
import { withSqliteWriteLock } from "./sqlite-write-lock.js";

// 表行形态直接引用由 Schema Manifest 推导的 DatabaseSchema（无第二份手工声明）。
type ProjectRow = DatabaseSchema["projects"];

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    ownerKey: row.owner_key,
    createdAt: row.created_at,
  };
}

export interface KyselyProjectRepositoryOptions {
  /** 共享的 file_operations writer；必须与本 repository 使用同一 Kysely/事务。 */
  readonly fileOperations?: FileOperationTransactionWriter;
  /** 将通用会话引用转换为事务内可入队的清理操作；具体格式由 Agent storage 实现解释。 */
  readonly cleanupPlan?: (input: {
    readonly sessionId: string;
    readonly projectId: string;
    readonly conversation: ConversationDescriptor;
  }) => ConversationCleanupPlan | null;
  /** PG must use FOR UPDATE; SQLite storage uses BEGIN IMMEDIATE in its adapter. */
  readonly dialect?: "sqlite" | "postgres";
}

export class KyselyProjectRepository implements ProjectStorePort {
  private readonly db: Kysely<DatabaseSchema>;
  private readonly constraintMapper: ConstraintErrorMapper;
  private readonly fileOperations: FileOperationTransactionWriter;
  private readonly cleanupPlan?: KyselyProjectRepositoryOptions["cleanupPlan"];
  private readonly dialect: "sqlite" | "postgres";

  constructor(db: Kysely<DatabaseSchema>, constraintMapper: ConstraintErrorMapper, options: KyselyProjectRepositoryOptions = {}) {
    this.db = db;
    this.constraintMapper = constraintMapper;
    this.fileOperations = options.fileOperations ?? new KyselyFileOperationRepository(db);
    this.cleanupPlan = options.cleanupPlan;
    this.dialect = options.dialect ??
      (options.fileOperations instanceof KyselyFileOperationRepository ? options.fileOperations.dialect : undefined) ??
      constraintMapper.dialect ?? "sqlite";
  }

  async create(record: ProjectRecord): Promise<void> {
    // 保留 id 由 ensureDefaultProject 独占，普通 create 不得写入（防止把私有项目写成共享默认项目）
    if (record.id === DEFAULT_PROJECT_ID) {
      throw new Error("默认项目 id 由 ensureDefaultProject 独占，不可通过 create 写入");
    }
    await this.withWriteLock(async () => {
      try {
        await this.db
          .insertInto("projects")
          .values({
            id: record.id,
            name: record.name,
            cwd: record.cwd,
            owner_key: record.ownerKey,
            created_at: record.createdAt,
          })
          .execute();
      } catch (error) {
        // 撞主键/唯一约束 → 存储无关 DuplicateIdError（应用层有界重试）；其余错误原样抛出
        this.constraintMapper.throwDuplicateIdOrOriginal(error, "projects");
      }
    });
  }

  async get(id: string): Promise<ProjectRecord | null> {
    const row = await this.db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async listByOwner(ownerKey: string): Promise<ProjectRecord[]> {
    const rows = await this.db
      .selectFrom("projects")
      .selectAll()
      .where("owner_key", "=", ownerKey)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return rows.map(toRecord);
  }

  async delete(id: string): Promise<boolean> {
    // 保留 id 不可删：防止绕过应用层误删默认项目（外键 CASCADE 会级联删其所有会话）。
    if (id === DEFAULT_PROJECT_ID) return false;
    return this.withWriteLock(() => this.db.transaction().execute(async (transaction) => {
      const tx = transaction as unknown as Kysely<DatabaseSchema>;
      // Lock the parent before reading children.  PostgreSQL's FK insert
      // takes a KEY SHARE lock on this row and therefore cannot slip between
      // this lock and the delete; SQLite's adapter starts this transaction as
      // BEGIN IMMEDIATE, so the same critical section is writer-exclusive.
      if (!(await this.lockProject(tx, id))) return false;
      const sessions = await this.listProjectSessionsForDelete(tx, id);
      await this.enqueueSessionDeletes(tx, sessions);
      const result = await tx.deleteFrom("projects").where("id", "=", id).executeTakeFirst();
      return Number(result?.numDeletedRows ?? 0) > 0;
    }));
  }

  async ensureDefaultProject(record: ProjectRecord): Promise<void> {
    // 默认项目不变量：必须 id=DEFAULT_PROJECT_ID 且空 owner（共享）；异常调用或异常既有行都显式失败，而非静默 IGNORE
    if (record.id !== DEFAULT_PROJECT_ID) {
      throw new Error("ensureDefaultProject 只能写入默认项目 id");
    }
    if (record.ownerKey !== "") {
      throw new Error("默认项目必须为空 owner（所有用户共享）");
    }
    await this.withWriteLock(async () => {
      const existing = await this.db
        .selectFrom("projects")
        .selectAll()
        .where("id", "=", record.id)
        .executeTakeFirst();
      if (existing && existing.owner_key !== "") {
        throw new Error("默认项目既有记录异常（owner 非空），拒绝覆盖");
      }
      await this.db
        .insertInto("projects")
        .values({
          id: record.id,
          name: record.name,
          cwd: record.cwd,
          owner_key: record.ownerKey,
          created_at: record.createdAt,
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
    });
  }

  async deleteProjectWithSessions(projectId: string, sessionIds: string[]): Promise<void> {
    await this.deleteProjectWithSessionsAndReturnSessionIds(projectId, sessionIds);
  }

  async deleteProjectWithSessionsAndReturnSessionIds(projectId: string, sessionIds: string[]): Promise<readonly string[]> {
    if (projectId === DEFAULT_PROJECT_ID) {
      throw new Error("默认项目不可删除");
    }
    // sessionIds 保留在 port 兼容签名中；事务内重新按 project_id 读取，避免调用方快照
    // 漏掉并发已存在会话。FK 仍是 CASCADE 兑底，但 file_operations 没有任何 FK。
    void sessionIds;
    return this.withWriteLock(() => this.db.transaction().execute(async (transaction) => {
      const tx = transaction as unknown as Kysely<DatabaseSchema>;
      // The parent lock, child listing, outbox enqueue, and both deletes are
      // deliberately one critical section.  Do not use the caller's
      // sessionIds snapshot: it is only a compatibility argument.
      if (!(await this.lockProject(tx, projectId))) return [];
      const sessions = await this.listProjectSessionsForDelete(tx, projectId);
      await this.enqueueSessionDeletes(tx, sessions);
      await tx.deleteFrom("sessions").where("project_id", "=", projectId).execute();
      await tx.deleteFrom("projects").where("id", "=", projectId).execute();
      return sessions.map((session) => session.id);
    }));
  }

  private withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    return this.dialect === "sqlite" ? withSqliteWriteLock(this.db, action) : action();
  }

  private async lockProject(transaction: Kysely<DatabaseSchema>, projectId: string): Promise<boolean> {
    if (this.dialect === "postgres") {
      const result = await sql<{ id: string }>`SELECT id FROM "projects" WHERE id = ${projectId} FOR UPDATE`.execute(transaction);
      return result.rows.length !== 0;
    }
    const row = await transaction.selectFrom("projects").select("id").where("id", "=", projectId).executeTakeFirst();
    return row !== undefined;
  }

  private async listProjectSessionsForDelete(transaction: Kysely<DatabaseSchema>, projectId: string): Promise<Array<{
    id: string;
    project_id: string;
    agent_kind: string;
    conversation_format: string;
    conversation_ref: string | null;
  }>> {
    if (this.dialect === "postgres") {
      const result = await sql<{
        id: string;
        project_id: string;
        agent_kind: string;
        conversation_format: string;
        conversation_ref: string | null;
      }>`
        SELECT id, project_id, agent_kind, conversation_format, conversation_ref FROM "sessions" WHERE project_id = ${projectId} ORDER BY id FOR UPDATE
      `.execute(transaction);
      return result.rows;
    }
    return transaction
      .selectFrom("sessions")
      .select(["id", "project_id", "agent_kind", "conversation_format", "conversation_ref"])
      .where("project_id", "=", projectId)
      .orderBy("id", "asc")
      .execute();
  }

  private async enqueueSessionDeletes(
    transaction: Kysely<DatabaseSchema>,
    sessions: ReadonlyArray<{
      id: string;
      project_id: string;
      agent_kind: string;
      conversation_format: string;
      conversation_ref: string | null;
    }>,
  ): Promise<void> {
    // 先对每个非空 ref 用 cleanupPlan 得出 operationKey，再在同一 deletion transaction
    // 内按 operationKey 取 PG advisory xact lock，最后 enqueue/delete。
    const plans: ConversationCleanupPlan[] = [];
    for (const session of sessions) {
      if (session.conversation_ref === null) continue;
      // 非空 conversation identity 由 idx_sessions_conversation 唯一约束独占：
      // 删除集合内的每个会话引用都是独占的，不会被集合外会话共享，直接登记清理。
      if (!this.cleanupPlan) throw new Error("conversation cleanup planner is not configured");
      const plan = this.cleanupPlan({
        sessionId: session.id,
        projectId: session.project_id,
        conversation: {
          agentKind: session.agent_kind,
          conversationFormat: session.conversation_format,
          conversationRef: session.conversation_ref,
        },
      });
      if (plan) plans.push(plan);
    }
    // 并发项目删除可能按不同顺序取得多个 lock；按 operationKey 排序取锁避免锁顺序反转死锁。
    plans.sort((left, right) =>
      left.operationKey < right.operationKey ? -1 : left.operationKey > right.operationKey ? 1 : 0,
    );
    for (const plan of plans) {
      if (this.dialect === "postgres") {
        await acquireTombstoneAdvisoryXactLock(transaction, plan.operationKey);
      }
      await this.fileOperations.enqueueInTransaction(transaction, {
        ...plan,
        createdAt: Date.now(),
      });
    }
  }
}