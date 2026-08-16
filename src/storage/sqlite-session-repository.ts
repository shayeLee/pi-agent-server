// 会话索引的 SQLite 实现（README §4.1）
// 用 Node 内置 node:sqlite 的 DatabaseSync；文件数据库启用 WAL（PRAGMA journal_mode=WAL），
// :memory: 数据库跳过。WAL 模式下 SQLite 保证单一写者，写操作串行化。

import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SessionRecord, SessionRepository } from "./session-repository.js";

type SessionRow = {
  id: string;
  owner_key: string;
  title: string;
  created_at: number;
  updated_at: number;
  pi_session_file: string | null;
};

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    ownerKey: row.owner_key,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    piSessionFile: row.pi_session_file,
  };
}

function isMemoryDatabase(db: DatabaseSync): boolean {
  const row = db.prepare("PRAGMA database_list").get() as { file?: unknown } | undefined;
  return row?.file === "";
}

export class SqliteSessionRepository implements SessionRepository {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly listStmt: StatementSync;
  private readonly updateStmt: StatementSync;
  private readonly deleteStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;

    if (!isMemoryDatabase(db)) {
      db.exec("PRAGMA journal_mode=WAL");
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        owner_key TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        pi_session_file TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_owner_updated
        ON sessions (owner_key, updated_at DESC);
    `);

    // 迁移：旧库补 pi_session_file 列（CREATE TABLE IF NOT EXISTS 不会给已有表加列）
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "pi_session_file")) {
      db.exec("ALTER TABLE sessions ADD COLUMN pi_session_file TEXT");
    }

    this.insertStmt = db.prepare(
      "INSERT INTO sessions (id, owner_key, title, created_at, updated_at, pi_session_file) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.getStmt = db.prepare(
      "SELECT id, owner_key, title, created_at, updated_at, pi_session_file FROM sessions WHERE id = ?",
    );
    this.listStmt = db.prepare(
      "SELECT id, owner_key, title, created_at, updated_at, pi_session_file FROM sessions WHERE owner_key = ? ORDER BY updated_at DESC, id DESC",
    );
    this.updateStmt = db.prepare(
      "UPDATE sessions SET title = COALESCE(?, title), updated_at = COALESCE(?, updated_at), pi_session_file = COALESCE(?, pi_session_file) WHERE id = ?",
    );
    this.deleteStmt = db.prepare("DELETE FROM sessions WHERE id = ?");
  }

  async create(record: SessionRecord): Promise<void> {
    this.insertStmt.run(
      record.id,
      record.ownerKey,
      record.title,
      record.createdAt,
      record.updatedAt,
      record.piSessionFile,
    );
  }

  async get(id: string): Promise<SessionRecord | null> {
    const row = this.getStmt.get(id) as SessionRow | undefined;
    return row ? toRecord(row) : null;
  }

  async listByOwner(ownerKey: string): Promise<SessionRecord[]> {
    const rows = this.listStmt.all(ownerKey) as SessionRow[];
    return rows.map(toRecord);
  }

  async update(
    id: string,
    patch: { title?: string; updatedAt?: number; piSessionFile?: string | null },
  ): Promise<boolean> {
    const result = this.updateStmt.run(
      patch.title ?? null,
      patch.updatedAt ?? null,
      patch.piSessionFile ?? null,
      id,
    );
    if (Number(result.changes) > 0) return true;
    // SQLite 相同值更新时 changes=0，行仍存在 → 按存在性判定
    return (this.getStmt.get(id) as SessionRow | undefined) !== undefined;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.deleteStmt.run(id);
    return Number(result.changes) > 0;
  }
}