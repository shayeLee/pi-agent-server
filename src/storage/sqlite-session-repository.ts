// 会话索引的 Kysely 实现（needs.md §4.1）。与 SqliteProjectRepository 共用同一个 Kysely/数据库实例。
// 建表统一由 bootstrap.ts 的 initializeDatabase 负责，本类仅负责查询与行映射。

import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./db-schema.js";
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

export class SqliteSessionRepository implements SessionStorePort {
  private readonly db: Kysely<DatabaseSchema>;

  constructor(db: Kysely<DatabaseSchema>) {
    this.db = db;
  }

  async create(record: SessionRecord): Promise<void> {
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
    const result = await this.db
      .updateTable("sessions")
      .set({ system_prompt: systemPrompt })
      .where("system_prompt", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async update(id: string, patch: SessionRecordPatch): Promise<boolean> {
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
    // SQLite 相同值更新时 changes=0，行仍存在 → 按存在性判定
    return (await this.get(id)) !== null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom("sessions").where("id", "=", id).executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0) > 0;
  }
}
