import { DatabaseSync } from "node:sqlite";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { defineClaimContract } from "./claim-contract.js";

defineClaimContract("accounts claim（SQLite）", async () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const kysely = await initializeDatabase(db);
  return { kysely, dialect: "sqlite", close: () => kysely.destroy() };
});
