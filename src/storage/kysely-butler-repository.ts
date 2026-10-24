// The butler pointer's neutral Kysely implementation (SQLite and PostgreSQL alike).
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./db-schema.js";
import type { ButlerStorePort } from "../application/ports/butler-store-port.js";

export class KyselyButlerRepository implements ButlerStorePort {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async get(ownerKey: string): Promise<string | null> {
    const row = await this.db.selectFrom("butlers").select(["session_id"]).where("owner_key", "=", ownerKey).executeTakeFirst();
    return row?.session_id ?? null;
  }

  async set(ownerKey: string, sessionId: string, createdAt: number): Promise<void> {
    const values = { session_id: sessionId, created_at: createdAt };
    await this.db.insertInto("butlers").values({ owner_key: ownerKey, ...values })
      .onConflict(conflict => conflict.column("owner_key").doUpdateSet(values)).execute();
  }
}
