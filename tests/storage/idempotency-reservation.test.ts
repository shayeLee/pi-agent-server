import { afterEach, describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { initStorage } from "../helpers/sqlite.js";

const openStorages: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (openStorages.length) await openStorages.pop()!.close();
});

async function makeStorage() {
  const storage = await initStorage(new DatabaseSync(":memory:"));
  openStorages.push(storage);
  return storage;
}

describe("KyselyIdempotencyRepository durable reservations", () => {
  it("unique key race elects one owner; only its token may complete, and retries read the terminal value", async () => {
    const repo = (await makeStorage()).idempotency;
    const sessionId = randomUUID();
    const results = await Promise.all([
      repo.reserve(sessionId, "request-1", "fingerprint-1"),
      repo.reserve(sessionId, "request-1", "fingerprint-1"),
    ]);
    const owner = results.find((entry) => entry.kind === "owner");
    const other = results.find((entry) => entry.kind !== "owner");
    expect(owner?.kind).toBe("owner");
    expect(other).toEqual({ kind: "reserved", fingerprint: "fingerprint-1" });

    if (owner?.kind !== "owner") throw new Error("expected reservation owner");
    expect(await repo.completeReservation(sessionId, "request-1", "wrong-token", { status: "completed" }, "fingerprint-1")).toBe(false);
    expect(await repo.completeReservation(sessionId, "request-1", owner.token, { status: "completed" }, "fingerprint-1")).toBe(true);
    expect(await repo.reserve(sessionId, "request-1", "fingerprint-1")).toEqual({
      kind: "done", result: { status: "completed" }, fingerprint: "fingerprint-1",
    });
  });

  it("release is token-CAS and prune never removes an unconfirmed reservation", async () => {
    const storage = await makeStorage();
    const repo = storage.idempotency;
    const sessionId = randomUUID();
    const reservation = await repo.reserve(sessionId, "held", "fp");
    expect(reservation.kind).toBe("owner");
    if (reservation.kind !== "owner") throw new Error("expected reservation owner");

    await storage.kysely.updateTable("idempotency").set({ created_at: 1 })
      .where("session_id", "=", sessionId).where("request_id", "=", "held").execute();
    expect(await repo.prune(2)).toBe(0);
    expect(await repo.reserve(sessionId, "held", "fp")).toEqual({ kind: "reserved", fingerprint: "fp" });
    expect(await repo.releaseReservation(sessionId, "held", "wrong-token")).toBe(false);
    expect(await repo.releaseReservation(sessionId, "held", reservation.token)).toBe(true);
    expect(await repo.reserve(sessionId, "held", "fp")).toMatchObject({ kind: "owner" });
  });

  it("keeps completed file-bearing request IDs even after the ordinary terminal TTL", async () => {
    const storage = await makeStorage();
    const repo = storage.idempotency;
    const sessionId = randomUUID();
    const fingerprint = `file-${"a".repeat(64)}`;
    const reserved = await repo.reserve(sessionId, "with-file", fingerprint);
    expect(reserved.kind).toBe("owner");
    if (reserved.kind !== "owner") return;
    expect(await repo.completeReservation(sessionId, "with-file", reserved.token, { status: "completed" }, fingerprint)).toBe(true);
    await storage.kysely.updateTable("idempotency").set({ created_at: 1 })
      .where("session_id", "=", sessionId).where("request_id", "=", "with-file").execute();
    expect(await repo.prune(2)).toBe(0);
    expect(await repo.reserve(sessionId, "with-file", fingerprint)).toMatchObject({ kind: "done", fingerprint });
  });

  it("corrupt JSON is an error rather than a cache miss", async () => {
    const storage = await makeStorage();
    const sessionId = randomUUID();
    await storage.kysely.insertInto("idempotency").values({
      session_id: sessionId, request_id: "corrupt", result: "{not-json", fingerprint: null, created_at: 1,
    }).execute();
    await expect(storage.idempotency.get(sessionId, "corrupt")).rejects.toThrow();
    await expect(storage.idempotency.reserve(sessionId, "corrupt", "fp")).rejects.toThrow();
  });
});
