import { describe, expect, it } from "vitest";
import { KyselyButlerRepository } from "../../src/storage/kysely-butler-repository.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";

describe("KyselyButlerRepository", () => {
  it("keeps one butler per owner, a reset repoints it, and the old session stays a butler", async () => {
    const { kysely, sessions, close } = await makeInitializedMemoryDb();
    try {
      for (const id of ["b1", "b2"]) await sessions.create({ id, kind: "butler", ownerKey: "a", projectId: DEFAULT_PROJECT_ID, title: "", createdAt: 1, updatedAt: 1,
        agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: null, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null });
      const butlers = new KyselyButlerRepository(kysely);
      expect(await butlers.get("a")).toBeNull();
      await butlers.set("a", "b1", 1);
      await butlers.set("a", "b2", 2);
      expect(await butlers.get("a")).toBe("b2");
      expect(await sessions.get("b1")).toMatchObject({ kind: "butler" });
      // Deleting the session drops the pointer with it.
      await kysely.deleteFrom("sessions").where("id", "=", "b2").execute();
      expect(await butlers.get("a")).toBeNull();
    } finally { await close(); }
  });
});
