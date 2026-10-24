// accounts claim on PostgreSQL (gated by PI_TEST_PG_URL). One schema per test.
import { describe } from "vitest";
import { Pool } from "pg";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";
import { initializePostgresDatabase } from "../../src/storage/postgres-bootstrap.js";
import { createPgInt8SafeTypes } from "../../src/storage/pg-int8.js";
import { defineClaimContract } from "../storage/claim-contract.js";

const pgUrl = process.env.PI_TEST_PG_URL?.trim() || undefined;
assertRequiredPgTestEnvironment("tests/postgres/claim", pgUrl, false);

function schemaName(): string {
  return `pi_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

(pgUrl ? describe : describe.skip)("accounts claim（PostgreSQL，PI_TEST_PG_URL 门控）", () => {
  defineClaimContract("accounts claim（PostgreSQL）", async () => {
    const schema = schemaName();
    const url = new URL(pgUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const pool = new Pool({ connectionString: url.toString(), types: createPgInt8SafeTypes() });
    await pool.query(`CREATE SCHEMA ${schema}`);
    const kysely = await initializePostgresDatabase(pool);
    return {
      kysely,
      dialect: "postgres",
      close: async () => {
        await kysely.destroy();
        const cleanup = new Pool({ connectionString: pgUrl! });
        try { await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await cleanup.end(); }
      },
    };
  });
});
