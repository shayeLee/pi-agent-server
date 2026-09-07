// reconcile 唯一允许接触的 DB-only 引用读取器（SQLite/PG 共用）。
// 只读取 session id/project id 与通用 conversation descriptor，不读取内容字段。

import type { Kysely } from "kysely";
import type {
  ReconcileReferenceRecord,
  ReconcileReferenceStorePort,
} from "../application/ports/reconcile-reference-port.js";
import type { DatabaseSchema } from "./db-schema.js";

type ReconcileReferenceRow = Pick<
  DatabaseSchema["sessions"],
  "id" | "project_id" | "agent_kind" | "conversation_format" | "conversation_ref"
>;

function toRecord(row: ReconcileReferenceRow): ReconcileReferenceRecord {
  return {
    sessionId: row.id,
    projectId: row.project_id,
    agentKind: row.agent_kind,
    conversationFormat: row.conversation_format,
    conversationRef: row.conversation_ref,
  };
}

export class KyselyReconcileReferenceRepository implements ReconcileReferenceStorePort {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async listReconcileReferences(): Promise<readonly ReconcileReferenceRecord[]> {
    const rows = await this.db
      .selectFrom("sessions")
      .select(["id", "project_id", "agent_kind", "conversation_format", "conversation_ref"])
      .orderBy("id", "asc")
      .execute();
    return rows.map((row) => toRecord(row));
  }
}
