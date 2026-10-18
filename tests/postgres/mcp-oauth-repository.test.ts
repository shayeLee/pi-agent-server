// 按用户 MCP OAuth 仓储契约 —— PostgreSQL 方言注册（PI_TEST_PG_URL 门控）。每个用例一个独立 schema。
import { describe } from "vitest";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";
import { initializePostgresDatabase } from "../../src/storage/postgres-bootstrap.js";
import { createPgInt8SafeTypes } from "../../src/storage/pg-int8.js";
import { KyselyMcpOAuthRepository } from "../../src/storage/kysely-mcp-oauth-repository.js";
import { McpTokenCipher } from "../../src/mcp/token-cipher.js";
import { defineMcpOAuthRepositoryContract } from "../storage/mcp-oauth-repository-contract.js";

const pgUrl = process.env.PI_TEST_PG_URL?.trim() || undefined;
assertRequiredPgTestEnvironment("tests/postgres/mcp-oauth-repository", pgUrl, false);

function schemaName(): string {
  return `pi_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

(pgUrl ? describe : describe.skip)("MCP OAuth 仓储（PostgreSQL，PI_TEST_PG_URL 门控）", () => {
  defineMcpOAuthRepositoryContract("KyselyMcpOAuthRepository（PostgreSQL）", async () => {
    const schema = schemaName();
    const url = new URL(pgUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const pool = new Pool({ connectionString: url.toString(), types: createPgInt8SafeTypes() });
    await pool.query(`CREATE SCHEMA ${schema}`);
    const kysely = await initializePostgresDatabase(pool);
    return {
      store: new KyselyMcpOAuthRepository(kysely, new McpTokenCipher(randomBytes(32))),
      otherKeyStore: new KyselyMcpOAuthRepository(kysely, new McpTokenCipher(randomBytes(32))),
      rawRows: async () => [(await pool.query("SELECT * FROM user_mcp_credentials")).rows, (await pool.query("SELECT * FROM mcp_oauth_clients")).rows],
      copyTokensCiphertext: async (from, to, serverName) => {
        await pool.query(
          "UPDATE user_mcp_credentials SET tokens = (SELECT tokens FROM user_mcp_credentials WHERE owner_key = $1 AND server_name = $3) WHERE owner_key = $2 AND server_name = $3",
          [from, to, serverName],
        );
      },
      close: async () => {
        await kysely.destroy();
        const cleanup = new Pool({ connectionString: pgUrl! });
        try { await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await cleanup.end(); }
      },
    };
  });
});
