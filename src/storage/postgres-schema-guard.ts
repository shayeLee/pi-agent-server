import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./db-schema.js";

/**
 * Validate the effective PostgreSQL namespace before any application ledger
 * lookup or application DDL. `public` is never a business schema; neither are
 * PostgreSQL's system namespaces.
 */
export async function assertPostgresApplicationSchema(kysely: Kysely<DatabaseSchema>): Promise<string> {
  const result = await sql<{ schema: unknown }>`SELECT current_schema() AS schema`.execute(kysely);
  const schema = result.rows[0]?.schema;
  if (typeof schema !== "string" || schema.length === 0 || isPostgresSystemSchema(schema)) {
    throw new Error("PostgreSQL effective current_schema is not an allowed non-public application schema");
  }
  return schema;
}

export function isPostgresSystemSchema(schema: string): boolean {
  return schema === "public" || schema === "information_schema" || schema.startsWith("pg_");
}
