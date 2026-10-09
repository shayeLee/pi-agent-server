// 幂等记录的中立 Kysely 实现（needs.md §4.2 requestId 去重跨重启，方言无关：SQLite/PG 共用）。
// reserve 以唯一键 INSERT ... ON CONFLICT DO NOTHING 选出唯一执行者；预约值保存在现有
// result 列中，终态只能由持有唯一 token 的执行者 CAS 替换。无需 schema 迁移。

import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./db-schema.js";
import type { IdempotencyReservationResult, IdempotencyStorePort } from "../application/ports/idempotency-store-port.js";

type IdempotencyRow = { result: string; fingerprint: string | null };
const RESERVATION_PREFIX = "PI-IDEMPOTENCY-RESERVATION-V1:";

/** The only non-JSON idempotency value allowed in a v1 backup/restore. */
export function isDurableIdempotencyReservation(value: unknown, fingerprint: unknown): boolean {
  return typeof value === "string" && typeof fingerprint === "string" &&
    /^PI-IDEMPOTENCY-RESERVATION-V1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) &&
    /^(?:file-)?[a-f0-9]{64}$/.test(fingerprint);
}

function reservationValue(token: string): string {
  return `${RESERVATION_PREFIX}${token}`;
}

function parseResult(value: string): unknown {
  if (value.startsWith(RESERVATION_PREFIX)) {
    throw new Error("幂等请求仍处于未确认预约状态");
  }
  // 非法 JSON 是持久化损坏，不可伪装成缓存 miss 后再次执行 Agent。
  return JSON.parse(value) as unknown;
}

function stringifyResult(result: unknown): string {
  const json = JSON.stringify(result);
  if (json === undefined) throw new TypeError("幂等终态必须可序列化为 JSON");
  return json;
}

function parseReservationRow(row: IdempotencyRow): IdempotencyReservationResult {
  if (row.result.startsWith(RESERVATION_PREFIX)) {
    return { kind: "reserved", fingerprint: row.fingerprint };
  }
  return { kind: "done", result: JSON.parse(row.result) as unknown, fingerprint: row.fingerprint };
}

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
      .executeTakeFirst() as { result: string } | undefined;
    if (!row) return null;
    return parseResult(row.result);
  }

  async getWithFingerprint(sessionId: string, requestId: string): Promise<{ result: unknown; fingerprint: string | null } | null> {
    const row = await this.db.selectFrom("idempotency")
      .select(["result", "fingerprint"])
      .where("session_id", "=", sessionId)
      .where("request_id", "=", requestId)
      .executeTakeFirst() as IdempotencyRow | undefined;
    if (!row) return null;
    return { result: parseResult(row.result), fingerprint: row.fingerprint };
  }

  async reserve(sessionId: string, requestId: string, fingerprint: string): Promise<IdempotencyReservationResult> {
    const token = randomUUID();
    const inserted = await this.db
      .insertInto("idempotency")
      .values({
        session_id: sessionId,
        request_id: requestId,
        result: reservationValue(token),
        fingerprint,
        created_at: Date.now(),
      })
      .onConflict((oc) => oc.columns(["session_id", "request_id"]).doNothing())
      .returning("request_id")
      .executeTakeFirst();
    if (inserted) return { kind: "owner", token };

    const row = await this.db.selectFrom("idempotency")
      .select(["result", "fingerprint"])
      .where("session_id", "=", sessionId)
      .where("request_id", "=", requestId)
      .executeTakeFirst() as IdempotencyRow | undefined;
    // A concurrent prune/release may remove the row between the failed insert and readback;
    // retrying reserve is safe because INSERT still arbitrates the unique key.
    if (!row) return this.reserve(sessionId, requestId, fingerprint);
    return parseReservationRow(row);
  }

  async completeReservation(
    sessionId: string,
    requestId: string,
    token: string,
    result: unknown,
    fingerprint: string,
  ): Promise<boolean> {
    const updated = await this.db.updateTable("idempotency")
      .set({ result: stringifyResult(result), fingerprint, created_at: Date.now() })
      .where("session_id", "=", sessionId)
      .where("request_id", "=", requestId)
      .where("result", "=", reservationValue(token))
      .where("fingerprint", "=", fingerprint)
      .executeTakeFirst();
    return Number(updated.numUpdatedRows ?? 0) > 0;
  }

  async releaseReservation(sessionId: string, requestId: string, token: string): Promise<boolean> {
    const deleted = await this.db.deleteFrom("idempotency")
      .where("session_id", "=", sessionId)
      .where("request_id", "=", requestId)
      .where("result", "=", reservationValue(token))
      .executeTakeFirst();
    return Number(deleted.numDeletedRows ?? 0) > 0;
  }

  async put(sessionId: string, requestId: string, result: unknown, fingerprint?: string): Promise<void> {
    const resultJson = stringifyResult(result);
    const createdAt = Date.now();
    await this.db
      .insertInto("idempotency")
      .values({
        session_id: sessionId,
        request_id: requestId,
        result: resultJson,
        fingerprint: fingerprint ?? null,
        created_at: createdAt,
      })
      .onConflict((oc) =>
        oc
          .columns(["session_id", "request_id"])
          .doUpdateSet({ result: resultJson, fingerprint: fingerprint ?? null, created_at: createdAt }),
      )
      .execute();
  }

  /** 清理 before 之前的终态记录；尚未确认的预约永远不因 TTL 丢失去重屏障。 */
  async prune(before: number): Promise<number> {
    const result = await this.db
      .deleteFrom("idempotency")
      .where("created_at", "<", before)
      .where("result", "not like", `${RESERVATION_PREFIX}%`)
      // A file reference and its original bytes are retained indefinitely in v1; never drop
      // their request-ID barrier while a repeated message could invoke Pi a second time.
      .where((eb) => eb.or([eb("fingerprint", "is", null), eb("fingerprint", "not like", "file-%")]))
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }
}
