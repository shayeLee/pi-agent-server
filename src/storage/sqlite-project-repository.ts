// 项目索引的 SQLite 实现（多项目）。
// 与 SqliteSessionRepository 共用同一个 DatabaseSync 实例（同库不同表）。

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { DEFAULT_PROJECT_ID, type ProjectRecord, type ProjectStorePort } from "../application/ports/project-store-port.js";

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
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly listStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly ensureDefaultStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projects_owner
        ON projects (owner_key);
    `);

    this.insertStmt = db.prepare(
      "INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.ensureDefaultStmt = db.prepare(
      "INSERT OR IGNORE INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.getStmt = db.prepare(
      "SELECT id, name, cwd, owner_key, created_at FROM projects WHERE id = ?",
    );
    this.listStmt = db.prepare(
      "SELECT id, name, cwd, owner_key, created_at FROM projects WHERE owner_key = ? ORDER BY created_at DESC, id DESC",
    );
    this.deleteStmt = db.prepare("DELETE FROM projects WHERE id = ?");
  }

  async create(record: ProjectRecord): Promise<void> {
    // 保留 id 由 ensureDefaultProject 独占，普通 create 不得写入（防止把私有项目写成共享默认项目）
    if (record.id === DEFAULT_PROJECT_ID) {
      throw new Error("默认项目 id 由 ensureDefaultProject 独占，不可通过 create 写入");
    }
    this.insertStmt.run(record.id, record.name, record.cwd, record.ownerKey, record.createdAt);
  }

  async get(id: string): Promise<ProjectRecord | null> {
    const row = this.getStmt.get(id) as ProjectRow | undefined;
    return row ? toRecord(row) : null;
  }

  async listByOwner(ownerKey: string): Promise<ProjectRecord[]> {
    const rows = this.listStmt.all(ownerKey) as ProjectRow[];
    return rows.map(toRecord);
  }

  async delete(id: string): Promise<boolean> {
    // 保留 id 不可删：防止绕过应用层误删默认项目（外键 CASCADE 会级联删其所有会话）
    if (id === DEFAULT_PROJECT_ID) return false;
    const result = this.deleteStmt.run(id);
    return Number(result.changes) > 0;
  }

  async ensureDefaultProject(record: ProjectRecord): Promise<void> {
    // 默认项目不变量：必须 id='default' 且空 owner（共享）；异常调用或异常既有行都显式失败，而非静默 IGNORE
    if (record.id !== DEFAULT_PROJECT_ID) {
      throw new Error("ensureDefaultProject 只能写入默认项目 id");
    }
    if (record.ownerKey !== "") {
      throw new Error("默认项目必须为空 owner（所有用户共享）");
    }
    // 同步查询既有行（不用 await this.get()，避免引入异步边界使 fire-and-forget 调用丢失顺序）
    const existing = this.getStmt.get(record.id) as ProjectRow | undefined;
    if (existing && existing.owner_key !== "") {
      throw new Error("默认项目既有记录异常（owner 非空），拒绝覆盖");
    }
    this.ensureDefaultStmt.run(record.id, record.name, record.cwd, record.ownerKey, record.createdAt);
  }

  async deleteProjectWithSessions(projectId: string, sessionIds: string[]): Promise<void> {
    if (projectId === DEFAULT_PROJECT_ID) {
      throw new Error("默认项目不可删除");
    }
    // sessions 表由 SqliteSessionRepository 创建；这里临时 prepare（避免构造时强依赖 sessions 表）。
    const deleteSession = this.db.prepare("DELETE FROM sessions WHERE id = ?");
    // 同一事务内逻辑删除：项目与会话要么全删、要么全保留（避免半删留下孤儿会话）
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const sessionId of sessionIds) {
        deleteSession.run(sessionId);
      }
      this.deleteStmt.run(projectId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
