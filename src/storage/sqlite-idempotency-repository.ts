// 幂等记录的 SQLite 实现（needs.md §4.2 requestId 去重跨重启）。
// 与会话索引共用同一个 DatabaseSync（WAL 已由会话 repository 启用）。

import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { IdempotencyStorePort } from "../application/ports/idempotency-store-port.js";

type IdempotencyRow = { result: string };

export class SqliteIdempotencyRepository implements IdempotencyStorePort {
  private readonly getStmt: StatementSync;
  private readonly putStmt: StatementSync;
  private readonly pruneStmt: StatementSync;

  constructor(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency (
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, request_id)
      );
    `);
    // 迁移：旧表补 created_at 列（CREATE TABLE IF NOT EXISTS 不会给已有表加列）；
    // 旧记录用迁移时刻作为时间戳，避免 DEFAULT 0 在启动 prune 时被立即删除（破坏升级期幂等语义）
    const cols = db.prepare("PRAGMA table_info(idempotency)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "created_at")) {
      db.exec(`ALTER TABLE idempotency ADD COLUMN created_at INTEGER NOT NULL DEFAULT ${Date.now()}`);
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_idempotency_created_at ON idempotency (created_at)");
    this.getStmt = db.prepare(
      "SELECT result FROM idempotency WHERE session_id = ? AND request_id = ?",
    );
    this.putStmt = db.prepare(
      "INSERT OR REPLACE INTO idempotency (session_id, request_id, result, created_at) VALUES (?, ?, ?, ?)",
    );
    this.pruneStmt = db.prepare("DELETE FROM idempotency WHERE created_at < ?");
  }

  async get(sessionId: string, requestId: string): Promise<unknown | null> {
    const row = this.getStmt.get(sessionId, requestId) as IdempotencyRow | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.result) as unknown;
    } catch {
      return null;
    }
  }

  async put(sessionId: string, requestId: string, result: unknown): Promise<void> {
    this.putStmt.run(sessionId, requestId, JSON.stringify(result), Date.now());
  }

  /** 清理 before 之前的记录（TTL），返回清理条数。 */
  async prune(before: number): Promise<number> {
    const result = this.pruneStmt.run(before);
    return Number(result.changes);
  }
}
