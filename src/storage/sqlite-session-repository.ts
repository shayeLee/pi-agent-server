// 会话索引的 SQLite 实现（needs.md §4.1）
// 用 Node 内置 node:sqlite 的 DatabaseSync；文件数据库启用 WAL（PRAGMA journal_mode=WAL），
// :memory: 数据库跳过。WAL 模式下 SQLite 保证单一写者，写操作串行化。

import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  SessionRecord,
  SessionRecordPatch,
  SessionStorePort,
} from "../application/ports/session-store-port.js";

type SessionRow = {
  id: string;
  owner_key: string;
  project_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  pi_session_file: string | null;
  model_provider: string | null;
  model_id: string | null;
  thinking_level: string | null;
  system_prompt: string | null;
  capability_versions: string | null;
};

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

function isMemoryDatabase(db: DatabaseSync): boolean {
  const row = db.prepare("PRAGMA database_list").get() as { file?: unknown } | undefined;
  return row?.file === "";
}

export class SqliteSessionRepository implements SessionStorePort {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly listStmt: StatementSync;
  private readonly listByProjectStmt: StatementSync;
  private readonly backfillSystemPromptStmt: StatementSync;
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
        project_id TEXT NOT NULL DEFAULT 'default',
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        pi_session_file TEXT,
        model_provider TEXT,
        model_id TEXT,
        thinking_level TEXT,
        system_prompt TEXT,
        capability_versions TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_owner_updated
        ON sessions (owner_key, updated_at DESC);
    `);

    // 迁移：旧库补列（CREATE TABLE IF NOT EXISTS 不会给已有表加列）
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "pi_session_file")) {
      db.exec("ALTER TABLE sessions ADD COLUMN pi_session_file TEXT");
    }
    // 迁移：旧库补 project_id 列（默认归到 default 项目）
    if (!cols.some((c) => c.name === "project_id")) {
      db.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default'");
    }
    // 迁移：旧库补模型/思考级别列
    if (!cols.some((c) => c.name === "model_provider")) {
      db.exec("ALTER TABLE sessions ADD COLUMN model_provider TEXT");
    }
    if (!cols.some((c) => c.name === "model_id")) {
      db.exec("ALTER TABLE sessions ADD COLUMN model_id TEXT");
    }
    if (!cols.some((c) => c.name === "thinking_level")) {
      db.exec("ALTER TABLE sessions ADD COLUMN thinking_level TEXT");
    }
    // 迁移：旧库补系统提示词列
    if (!cols.some((c) => c.name === "system_prompt")) {
      db.exec("ALTER TABLE sessions ADD COLUMN system_prompt TEXT");
    }
    // 迁移：旧库补能力版本快照列
    if (!cols.some((c) => c.name === "capability_versions")) {
      db.exec("ALTER TABLE sessions ADD COLUMN capability_versions TEXT");
    }

    // 半迁移残留检测：旧版本的非事务迁移失败可能留下 sessions_old；此时新 sessions 表已存在，
    // 若静默继续会丢失历史会话数据。fail-fast，要求人工处理。
    const orphanOld = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions_old'",
    ).get();
    if (orphanOld) {
      throw new Error("检测到残留的 sessions_old 表（历史迁移失败所致），请人工合并/删除后重启");
    }

    // 迁移：旧库 sessions 表无「project_id → projects(id) ON DELETE CASCADE」外键 → 重建。
    // 外键引用 projects 表，故由 composition root 保证 projects 先于 sessions 初始化。
    const fkList = db.prepare("PRAGMA foreign_key_list(sessions)").all() as {
      table?: string;
      from?: string;
      to?: string;
      on_delete?: string;
    }[];
    const hasCascadeFk = fkList.some(
      (fk) =>
        (fk.table ?? "").toLowerCase() === "projects" &&
        (fk.from ?? "").toLowerCase() === "project_id" &&
        (fk.to ?? "").toLowerCase() === "id" &&
        (fk.on_delete ?? "").toUpperCase() === "CASCADE",
    );
    if (hasCascadeFk) {
      // 新库已有正确外键：只需补依赖 project_id 的索引（上面只建了 updated 索引）
      db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_owner_project ON sessions (owner_key, project_id);");
    } else {
      // 重建表（事务包裹，原子：要么完整迁移，要么回滚，避免留下 sessions_old 半迁移状态）
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          ALTER TABLE sessions RENAME TO sessions_old;
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            owner_key TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT 'default',
            title TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            pi_session_file TEXT,
            model_provider TEXT,
            model_id TEXT,
            thinking_level TEXT,
            system_prompt TEXT,
            capability_versions TEXT,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
          );
          DELETE FROM main.sessions_old WHERE project_id NOT IN (SELECT id FROM projects);
          INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, model_provider, model_id, thinking_level, system_prompt, capability_versions)
            SELECT id, owner_key, project_id, title, created_at, updated_at, pi_session_file, model_provider, model_id, thinking_level, system_prompt, capability_versions
            FROM main.sessions_old;
          DROP TABLE main.sessions_old;
          CREATE INDEX idx_sessions_owner_updated ON sessions (owner_key, updated_at DESC);
          CREATE INDEX idx_sessions_owner_project ON sessions (owner_key, project_id);
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    this.insertStmt = db.prepare(
      "INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, model_provider, model_id, thinking_level, system_prompt, capability_versions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.getStmt = db.prepare(
      "SELECT id, owner_key, project_id, title, created_at, updated_at, pi_session_file, model_provider, model_id, thinking_level, system_prompt, capability_versions FROM sessions WHERE id = ?",
    );
    this.listStmt = db.prepare(
      "SELECT id, owner_key, project_id, title, created_at, updated_at, pi_session_file, model_provider, model_id, thinking_level, system_prompt, capability_versions FROM sessions WHERE owner_key = ? ORDER BY updated_at DESC, id DESC",
    );
    this.listByProjectStmt = db.prepare(
      "SELECT id, owner_key, project_id, title, created_at, updated_at, pi_session_file, model_provider, model_id, thinking_level, system_prompt, capability_versions FROM sessions WHERE owner_key = ? AND project_id = ? ORDER BY updated_at DESC, id DESC",
    );
    this.backfillSystemPromptStmt = db.prepare(
      "UPDATE sessions SET system_prompt = ? WHERE system_prompt IS NULL",
    );
    this.updateStmt = db.prepare(
      "UPDATE sessions SET title = COALESCE(?, title), updated_at = COALESCE(?, updated_at), pi_session_file = COALESCE(?, pi_session_file), model_provider = COALESCE(?, model_provider), model_id = COALESCE(?, model_id), thinking_level = COALESCE(?, thinking_level), system_prompt = COALESCE(?, system_prompt) WHERE id = ?",
    );
    this.deleteStmt = db.prepare("DELETE FROM sessions WHERE id = ?");
  }

  async create(record: SessionRecord): Promise<void> {
    this.insertStmt.run(
      record.id,
      record.ownerKey,
      record.projectId,
      record.title,
      record.createdAt,
      record.updatedAt,
      record.piSessionFile,
      record.modelProvider,
      record.modelId,
      record.thinkingLevel,
      record.systemPrompt,
      record.capabilityVersions,
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

  async listByProject(ownerKey: string, projectId: string): Promise<SessionRecord[]> {
    const rows = this.listByProjectStmt.all(ownerKey, projectId) as SessionRow[];
    return rows.map(toRecord);
  }

  async backfillSystemPrompt(systemPrompt: string): Promise<number> {
    const result = this.backfillSystemPromptStmt.run(systemPrompt);
    return Number(result.changes);
  }

  async update(id: string, patch: SessionRecordPatch): Promise<boolean> {
    const result = this.updateStmt.run(
      patch.title ?? null,
      patch.updatedAt ?? null,
      patch.piSessionFile ?? null,
      patch.modelProvider ?? null,
      patch.modelId ?? null,
      patch.thinkingLevel ?? null,
      patch.systemPrompt ?? null,
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
