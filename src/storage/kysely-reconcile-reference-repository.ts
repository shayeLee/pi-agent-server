// WP4C（方案 A 收敛）受控只读引用仓库：只读列取 sessions 的 session id /
// project id / pi_session_file（纯 SELECT，方言无关：SQLite/PG 共用同一实现）。
//
// 边界：
// - 唯一的查询是单条 SELECT，不做任何 UPDATE/INSERT/DELETE/DDL；
// - 列集合固定为三个标识字段，不选取任何内容字段（title/system_prompt/cwd/
//   owner_key 等绝不进入 analyzer 的内存与报告）；
// - pi_session_file 为 null 时原样保留（懒会话尚未创建 = normal
//   unmaterialized，由 analyzer 计数、不判为 issue）；
// - 排序按 session id 升序，跨运行稳定，便于确定性去重与报告。

import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./db-schema.js";
import type {
  ReconcileReferenceRecord,
  ReconcileReferenceStorePort,
} from "../application/ports/reconcile-reference-port.js";

type ReconcileReferenceRow = Pick<DatabaseSchema["sessions"], "id" | "project_id" | "pi_session_file">;

function toRecord(row: ReconcileReferenceRow): ReconcileReferenceRecord {
  return {
    sessionId: row.id,
    projectId: row.project_id,
    piSessionFile: row.pi_session_file,
  };
}

export class KyselyReconcileReferenceRepository implements ReconcileReferenceStorePort {
  private readonly db: Kysely<DatabaseSchema>;

  constructor(db: Kysely<DatabaseSchema>) {
    this.db = db;
  }

  async listReconcileReferences(): Promise<readonly ReconcileReferenceRecord[]> {
    const rows = await this.db
      .selectFrom("sessions")
      .select(["id", "project_id", "pi_session_file"])
      .orderBy("id", "asc")
      .execute();
    return rows.map(toRecord);
  }
}