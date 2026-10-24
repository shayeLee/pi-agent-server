import { DatabaseSync } from "node:sqlite";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { defineAccountRepositoryContract } from "./account-repository-contract.js";

defineAccountRepositoryContract("KyselyAccountRepository（SQLite）", async () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const kysely = await initializeDatabase(db);
  return {
    kysely,
    dialect: "sqlite",
    rawRows: async () => ["accounts", "login_methods", "auth_sessions", "api_tokens"].map(table => db.prepare(`SELECT * FROM ${table}`).all()),
    close: () => kysely.destroy(),
  };
});
