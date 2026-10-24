import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { ConversationStorageRegistry, DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import type { UsageLedgerEvent } from "../../src/agent/usage-ledger.js";
import { identityKey } from "../../src/core/user-identity.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makeTestIpAccess } from "../helpers/ip-access.js";

const MINE = "10.0.0.1";
const THEIRS = "10.0.0.2";
const call = (ts: string, model: string, input: number): UsageLedgerEvent =>
  ({ ts: Date.parse(ts), provider: "p", model, input, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.25, subagent: false });

async function makeApp(withButler = false) {
  const { projects, sessions } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
  const ledgers: Record<string, UsageLedgerEvent[] | "broken"> = {
    "/data/mine.jsonl": [call("2026-10-20T08:00:00Z", "a", 100), call("2026-10-21T08:00:00Z", "b", 10)],
    "/data/mine-broken.jsonl": "broken",
    "/data/theirs.jsonl": [call("2026-10-20T08:00:00Z", "a", 5000)],
    "/data/butler.jsonl": [call("2026-10-21T09:00:00Z", "a", 40)],
  };
  const storage = new ConversationStorageRegistry();
  storage.register({
    agentKind: "pi", conversationFormat: "pi-jsonl-v3",
    readExport: async () => [], planCleanup: () => null,
    async readUsageLedger(conversation) {
      const ledger = ledgers[conversation.conversationRef!];
      if (ledger === "broken" || !ledger) throw new Error("unreadable");
      return ledger;
    },
  });
  const record = (id: string, ip: string, conversationRef: string | null, kind?: "butler") => sessions.create({ ...(kind ? { kind } : {}),
    id, ownerKey: identityKey({ kind: "ip", ip }), projectId: DEFAULT_PROJECT_ID, title: id, createdAt: 1, updatedAt: 1,
    agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef,
    modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null,
  });
  await record("mine", MINE, "/data/mine.jsonl");
  await record("mine-broken", MINE, "/data/mine-broken.jsonl");
  await record("mine-empty", MINE, null);
  await record("theirs", THEIRS, "/data/theirs.jsonl");
  if (withButler) await record("butler", MINE, "/data/butler.jsonl", "butler");
  return buildApp({ sessions, projects, defaultProjectCwd: "/tmp/default-project", ipAccess: makeTestIpAccess(),
    conversationStorage: storage, createAdapter: async () => new MockAgentAdapter() });
}

describe("GET /v1/usage", () => {
  it("sums only the caller's sessions, per model and day, and counts files it could not read", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/v1/usage?period=day&timeZone=UTC&from=2026-10-20&to=2026-10-21", remoteAddress: MINE });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const body = res.json();
    expect(body).toMatchObject({ period: "day", timeZone: "UTC", from: "2026-10-20", to: "2026-10-21", sessions: 2, unreadSessions: 1 });
    expect(body.buckets.map((b: { start: string; totals: { totalTokens: number } }) => [b.start, b.totals.totalTokens])).toEqual([["2026-10-20", 101], ["2026-10-21", 11]]);
    expect(body.models.map((m: { model: string; calls: number }) => [m.model, m.calls])).toEqual([["a", 1], ["b", 1]]);
    expect(body.totals.costUsdEstimate).toBeCloseTo(0.5);
  });

  it("counts the butler's spend in the totals and also gives it on its own", async () => {
    const plain = (await (await makeApp()).inject({ method: "GET", url: "/v1/usage?period=day&timeZone=UTC&from=2026-10-20&to=2026-10-21", remoteAddress: MINE })).json();
    expect(plain).not.toHaveProperty("butler");
    const body = (await (await makeApp(true)).inject({ method: "GET", url: "/v1/usage?period=day&timeZone=UTC&from=2026-10-20&to=2026-10-21", remoteAddress: MINE })).json();
    expect(body.totals.totalTokens).toBe(plain.totals.totalTokens + 41);
    expect(body.sessions).toBe(3);
    expect(body.butler).toMatchObject({ totalTokens: 41, calls: 1 });
  });

  it("rejects an unknown zone and a range of too many periods", async () => {
    const app = await makeApp();
    const zone = await app.inject({ method: "GET", url: "/v1/usage?timeZone=Mars/Olympus", remoteAddress: MINE });
    expect(zone.statusCode).toBe(400);
    const long = await app.inject({ method: "GET", url: "/v1/usage?period=day&from=2020-01-01&to=2026-01-01", remoteAddress: MINE });
    expect(long.statusCode).toBe(400);
    const backwards = await app.inject({ method: "GET", url: "/v1/usage?from=2026-10-02&to=2026-10-01", remoteAddress: MINE });
    expect(backwards.statusCode).toBe(400);
    const badDay = await app.inject({ method: "GET", url: "/v1/usage?from=2026-13-01", remoteAddress: MINE });
    expect(badDay.statusCode).toBe(400);
  });
});
