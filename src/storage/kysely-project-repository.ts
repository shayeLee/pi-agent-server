// 项目索引的中立 Kysely 实现（多项目，方言无关：SQLite/PG 共用）。
// 与 KyselySessionRepository 共用同一个 Kysely/数据库实例；建表统一由各方言 bootstrap
// （bootstrap.ts / postgres-bootstrap.ts 消费同一 Manifest）负责，本类仅负责查询与行映射。
// 方言约束错误映射由构造函数注入 ConstraintErrorMapper（SQLite/PG 各自实现），
// 本类不识别任何底层错误码。

import type { Kysely } from "kysely";
import {
  DEFAULT_PROJECT_ID,
  type ProjectRecord,
  type ProjectStorePort,
} from "../application/ports/project-store-port.js";
import type { DatabaseSchema } from "./db-schema.js";
import type { ConstraintErrorMapper } from "./constraint-error-mapper.js";

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

export class KyselyProjectRepository implements ProjectStorePort {
  private readonly db: Kysely<DatabaseSchema>;
  private readonly constraintMapper: ConstraintErrorMapper;

  constructor(db: Kysely<DatabaseSchema>, constraintMapper: ConstraintErrorMapper) {
    this.db = db;
    this.constraintMapper = constraintMapper;
  }

  async create(record: ProjectRecord): Promise<void> {
    // 保留 id 由 ensureDefaultProject 独占，普通 create 不得写入（防止把私有项目写成共享默认项目）
    if (record.id === DEFAULT_PROJECT_ID) {
      throw new Error("默认项目 id 由 ensureDefaultProject 独占，不可通过 create 写入");
    }
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
    // 保留 id 不可删：防止绕过应用层误删默认项目（外键 CASCADE 会级联删其所有会话）
    if (id === DEFAULT_PROJECT_ID) return false;
    const result = await this.db.deleteFrom("projects").where("id", "=", id).executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0) > 0;
  }

  async ensureDefaultProject(record: ProjectRecord): Promise<void> {
    // 默认项目不变量：必须 id=DEFAULT_PROJECT_ID 且空 owner（共享）；异常调用或异常既有行都显式失败，而非静默 IGNORE
    if (record.id !== DEFAULT_PROJECT_ID) {
      throw new Error("ensureDefaultProject 只能写入默认项目 id");
    }
    if (record.ownerKey !== "") {
      throw new Error("默认项目必须为空 owner（所有用户共享）");
    }
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
  }

  async deleteProjectWithSessions(projectId: string, sessionIds: string[]): Promise<void> {
    if (projectId === DEFAULT_PROJECT_ID) {
      throw new Error("默认项目不可删除");
    }
    // 同一事务内逻辑删除：项目与会话要么全删、要么全保留（避免半删留下孤儿会话），
    // 数据库层另有外键 ON DELETE CASCADE 兑底（SQLite/PG 同语义）。
    await this.db.transaction().execute(async (trx) => {
      if (sessionIds.length > 0) {
        await trx.deleteFrom("sessions").where("id", "in", sessionIds).execute();
      }
      await trx.deleteFrom("projects").where("id", "=", projectId).execute();
    });
  }
}