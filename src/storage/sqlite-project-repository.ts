// 项目索引的 Kysely 实现（多项目）。与 SqliteSessionRepository 共用同一个 Kysely/数据库实例。
// 建表统一由 bootstrap.ts 的 initializeDatabase 负责，本类仅负责查询与行映射。

import type { Kysely } from "kysely";
import { DEFAULT_PROJECT_ID, type ProjectRecord, type ProjectStorePort } from "../application/ports/project-store-port.js";
import type { DatabaseSchema } from "./db-schema.js";

type ProjectRow = {
  id: string;
  name: string;
  cwd: string;
  owner_key: string;
  created_at: number;
};

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    ownerKey: row.owner_key,
    createdAt: row.created_at,
  };
}

export class SqliteProjectRepository implements ProjectStorePort {
  private readonly db: Kysely<DatabaseSchema>;

  constructor(db: Kysely<DatabaseSchema>) {
    this.db = db;
  }

  async create(record: ProjectRecord): Promise<void> {
    // 保留 id 由 ensureDefaultProject 独占，普通 create 不得写入（防止把私有项目写成共享默认项目）
    if (record.id === DEFAULT_PROJECT_ID) {
      throw new Error("默认项目 id 由 ensureDefaultProject 独占，不可通过 create 写入");
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
      .execute();
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
    // 数据库层另有外键 ON DELETE CASCADE 兑底。
    await this.db.transaction().execute(async (trx) => {
      if (sessionIds.length > 0) {
        await trx.deleteFrom("sessions").where("id", "in", sessionIds).execute();
      }
      await trx.deleteFrom("projects").where("id", "=", projectId).execute();
    });
  }
}
