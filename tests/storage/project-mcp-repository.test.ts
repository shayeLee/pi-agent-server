import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { KyselyProjectMcpRepository } from "../../src/storage/kysely-project-mcp-repository.js";

async function withStore(run: (store: KyselyProjectMcpRepository, db: DatabaseSync) => Promise<void>): Promise<void> {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const kysely = await initializeDatabase(db);
  db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)").run("11111111-1111-4111-8111-111111111111", "p", "/p", "ip:1", 0);
  try { await run(new KyselyProjectMcpRepository(kysely), db); } finally { await kysely.destroy(); }
}
const PROJECT = "11111111-1111-4111-8111-111111111111";

describe("KyselyProjectMcpRepository", () => {
  it("keeps one row per server and replaces it on save", () => withStore(async store => {
    expect(await store.list(PROJECT)).toEqual([]);
    expect(await store.put(PROJECT, { serverName: "docs", enabled: true, exposure: "deferred", hiddenTools: ["a"], updatedAt: 1, updatedBy: "ip:1", serverIdentity: null })).toBe(true);
    expect(await store.put(PROJECT, { serverName: "docs", enabled: false, exposure: null, hiddenTools: [], updatedAt: 2, updatedBy: "ip:2", serverIdentity: "abc" })).toBe(true);
    expect(await store.list(PROJECT)).toEqual([{ serverName: "docs", enabled: false, exposure: null, hiddenTools: [], updatedAt: 2, updatedBy: "ip:2", serverIdentity: "abc" }]);
  }));

  it("refuses unknown projects and follows project deletion", () => withStore(async (store, db) => {
    expect(await store.put("22222222-2222-4222-8222-222222222222", { serverName: "docs", enabled: true, exposure: null, hiddenTools: [], updatedAt: 1, updatedBy: "ip:1", serverIdentity: null })).toBe(false);
    await store.put(PROJECT, { serverName: "docs", enabled: true, exposure: null, hiddenTools: [], updatedAt: 1, updatedBy: "ip:1", serverIdentity: null });
    db.prepare("DELETE FROM projects WHERE id = ?").run(PROJECT);
    expect(await store.list(PROJECT)).toEqual([]);
  }));

  it("reads an exposure it does not know as unset", () => withStore(async (store, db) => {
    db.prepare("INSERT INTO project_mcp_servers (project_id, server_name, enabled, exposure, hidden_tools, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(PROJECT, "docs", 1, "future", "[]", 1, "ip:1");
    expect((await store.list(PROJECT))[0]).toMatchObject({ exposure: null, serverIdentity: null });
  }));
});
