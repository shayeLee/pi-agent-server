// 幂等记录的中立 Kysely 实现（needs.md §4.2 requestId 去重跨重启，方言无关：SQLite/PG 共用）。
// 与项目/会话 repository 共用同一个 Kysely/数据库实例；建表由各方言 bootstrap 消费同一
// Manifest 负责。put 使用 ON CONFLICT（Kysely 方言无关抽象，SQLite/PG 均可编译执行），
// 正常路径不产生约束错误，故无需注入约束错误 mapper。

import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./db-schema.js";
import type { IdempotencyStorePort } from "../application/ports/idempotency-store-port.js";

type IdempotencyRow = { result: string };

export class KyselyIdempotencyRepository implements IdempotencyStorePort {
  private readonly db: Kysely<DatabaseSchema>;

  constructor(db: Kysely<DatabaseSchema>) {
    this.db = db;
  }

  async get(sessionId: string, requestId: string): Promise<unknown | null> {
    const row = await this.db
      .selectFrom("idempotency")
      .select("result")
      .where("session_id", "=", sessionId)
      .where("request_id", "=", requestId)
      .executeTakeFirst() as IdempotencyRow | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.result) as unknown;
    } catch {
      return null;
    }
  }

  async put(sessionId: string, requestId: string, result: unknown): Promise<void> {
    const resultJson = JSON.stringify(result);
    const createdAt = Date.now();
    await this.db
      .insertInto("idempotency")
      .values({
        session_id: sessionId,
        request_id: requestId,
        result: resultJson,
        created_at: createdAt,
      })
      .onConflict((oc) =>
        oc
          .columns(["session_id", "request_id"])
          .doUpdateSet({ result: resultJson, created_at: createdAt }),
      )
      .execute();
  }

  /** 清理 before 之前的记录（TTL），返回清理条数。 */
  async prune(before: number): Promise<number> {
    const result = await this.db
      .deleteFrom("idempotency")
      .where("created_at", "<", before)
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }
}