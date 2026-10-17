// The companion persona's neutral Kysely implementation (SQLite and PostgreSQL alike).
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./db-schema.js";
import type { CompanionPersonaStorePort } from "../application/ports/companion-persona-store-port.js";
import type { CompanionPersonaRecord } from "../shared/companion.js";

const STYLES = new Set<string>(["concise", "lively", "formal"]);

export class KyselyCompanionPersonaRepository implements CompanionPersonaStorePort {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async get(ownerKey: string): Promise<CompanionPersonaRecord | null> {
    const row = await this.db.selectFrom("companion_personas").select(["name", "style", "docked"])
      .where("owner_key", "=", ownerKey).executeTakeFirst();
    // A row written by a newer server with a voice this one does not know reads as unset.
    if (!row || !STYLES.has(row.style)) return null;
    return { name: row.name, style: row.style as CompanionPersonaRecord["style"], docked: Number(row.docked) !== 0 };
  }

  async put(ownerKey: string, persona: CompanionPersonaRecord, updatedAt: number): Promise<void> {
    const values = { name: persona.name, style: persona.style, docked: persona.docked ? 1 : 0, updated_at: updatedAt };
    await this.db.insertInto("companion_personas").values({ owner_key: ownerKey, ...values })
      .onConflict(conflict => conflict.column("owner_key").doUpdateSet(values)).execute();
  }
}
