import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { KyselyMcpOAuthRepository } from "../../src/storage/kysely-mcp-oauth-repository.js";
import { McpTokenCipher } from "../../src/mcp/token-cipher.js";
import { defineMcpOAuthRepositoryContract } from "./mcp-oauth-repository-contract.js";

defineMcpOAuthRepositoryContract("KyselyMcpOAuthRepository（SQLite）", async () => {
  const db = new DatabaseSync(":memory:");
  const kysely = await initializeDatabase(db);
  return {
    store: new KyselyMcpOAuthRepository(kysely, new McpTokenCipher(randomBytes(32))),
    otherKeyStore: new KyselyMcpOAuthRepository(kysely, new McpTokenCipher(randomBytes(32))),
    rawRows: async () => [db.prepare("SELECT * FROM user_mcp_credentials").all(), db.prepare("SELECT * FROM mcp_oauth_clients").all()],
    copyTokensCiphertext: async (from, to, serverName) => {
      db.prepare("UPDATE user_mcp_credentials SET tokens = (SELECT tokens FROM user_mcp_credentials WHERE owner_key = ? AND server_name = ?) WHERE owner_key = ? AND server_name = ?")
        .run(from, serverName, to, serverName);
    },
    close: () => kysely.destroy(),
  };
});
