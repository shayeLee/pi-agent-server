import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { KyselyCompanionPersonaRepository } from "../../src/storage/kysely-companion-persona-repository.js";

async function withStore(run: (store: KyselyCompanionPersonaRepository, db: DatabaseSync) => Promise<void>): Promise<void> {
  const db = new DatabaseSync(":memory:");
  const kysely = await initializeDatabase(db);
  try { await run(new KyselyCompanionPersonaRepository(kysely), db); } finally { await kysely.destroy(); }
}

describe("KyselyCompanionPersonaRepository", () => {
  it("keeps one persona per caller and replaces it on save", () => withStore(async store => {
    expect(await store.get("a")).toBeNull();
    await store.put("a", { name: "小派", style: "lively", docked: true }, 1);
    await store.put("b", { name: "阿布", style: "formal", docked: true }, 1);
    await store.put("a", { name: "派派", style: "concise", docked: false }, 2);
    expect(await store.get("a")).toEqual({ name: "派派", style: "concise", docked: false });
    expect(await store.get("b")).toEqual({ name: "阿布", style: "formal", docked: true });
  }));

  it("reads a voice it does not know as unset", () => withStore(async (store, db) => {
    db.prepare("INSERT INTO companion_personas (owner_key, name, style, docked, updated_at) VALUES (?, ?, ?, ?, ?)").run("a", "小派", "grumpy", 1, 1);
    expect(await store.get("a")).toBeNull();
  }));
});
