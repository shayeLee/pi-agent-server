import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { bucketStarts, defaultUsageRange, summarizeUsage, usageLedger, usageLedgerFromJsonl, type UsageLedgerEvent } from "../../src/agent/usage-ledger.js";
import { PiJsonlConversationStorage } from "../../src/agent/pi-jsonl-conversation-storage.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";

const usage = (input: number, output: number, cost = 0) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const assistant = (model: string, used: ReturnType<typeof usage>, timestamp: number) =>
  ({ type: "message", timestamp: new Date(timestamp).toISOString(), message: { role: "assistant", provider: "p", model, usage: used, timestamp } });
const child = (id: string, key: string, complete: boolean, model: string, used: ReturnType<typeof usage>, timestamp: number) =>
  ({ type: "custom", customType: "agent-team:transcript", data: { version: 1, id, seq: 1, kind: "message", timestamp,
    payload: { key, complete, message: { role: "assistant", provider: "p", model, usage: used, timestamp } } } });
const call = (ts: string, model: string, input: number, subagent = false): UsageLedgerEvent =>
  ({ ts: Date.parse(ts), provider: "p", model, input, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, subagent });

describe("billed calls of a session file", () => {
  it("names each call's model; compaction usage goes to the model in use, child agents to their own", () => {
    const ledger = usageLedger([
      { type: "model_change", provider: "p", modelId: "a", timestamp: "2026-10-01T00:00:00Z" },
      assistant("a", usage(100, 10, 0.5), Date.parse("2026-10-01T01:00:00Z")),
      { type: "compaction", timestamp: "2026-10-01T02:00:00Z", usage: usage(40, 4) },
      child("run", "m1", false, "c", usage(999, 0), 1),
      child("run", "m1", true, "c", usage(70, 7), Date.parse("2026-10-01T03:00:00Z")),
      child("run", "m2", true, "c", usage(5, 0), 2),
      child("run", "m2", false, "c", usage(5, 0), 3),
      { type: "usage", kind: "cache_warm", provider: "q", model: "w", usage: usage(3, 0), timestamp: "2026-10-01T04:00:00Z" },
    ]);
    expect(ledger.map(e => [e.provider, e.model, e.input, e.subagent])).toEqual([
      ["p", "a", 100, false], ["p", "a", 40, false], ["q", "w", 3, false], ["p", "c", 70, true],
    ]);
    expect(ledger[0]!.cost).toBe(0.5);
  });

  it("keeps calls from every branch and skips lines it cannot read", () => {
    const lines = [
      JSON.stringify(assistant("a", usage(1, 0), 1000)),
      "{\"usage\": torn",
      JSON.stringify(assistant("a", usage(2, 0), 2000)),
      JSON.stringify({ type: "message", message: { role: "user", content: "no usage here" } }),
    ];
    expect(usageLedgerFromJsonl(lines.join("\n")).map(e => e.input)).toEqual([1, 2]);
  });
});

describe("usage per period", () => {
  it("puts a call on the calendar day of the requested zone", () => {
    const calls = [call("2026-10-21T16:30:00Z", "a", 1), call("2026-10-21T15:30:00Z", "a", 2)];
    const shanghai = summarizeUsage([calls], { period: "day", timeZone: "Asia/Shanghai", from: "2026-10-21", to: "2026-10-22", sessions: 1, unreadSessions: 0 });
    expect(shanghai.buckets.map(b => [b.start, b.totals.input])).toEqual([["2026-10-21", 2], ["2026-10-22", 1]]);
    const utc = summarizeUsage([calls], { period: "day", timeZone: "UTC", from: "2026-10-21", to: "2026-10-22", sessions: 1, unreadSessions: 0 });
    expect(utc.buckets.map(b => b.totals.input)).toEqual([3, 0]);
  });

  it("sums weeks from Monday and months from the 1st, per model, most tokens first", () => {
    const calls = [call("2026-10-18T12:00:00Z", "small", 1), call("2026-10-19T12:00:00Z", "big", 50), call("2026-10-25T12:00:00Z", "small", 2, true)];
    const weeks = summarizeUsage([calls], { period: "week", timeZone: "UTC", from: "2026-10-12", to: "2026-10-25", sessions: 1, unreadSessions: 0 });
    expect(weeks.buckets.map(b => [b.start, b.totals.input])).toEqual([["2026-10-12", 1], ["2026-10-19", 52]]);
    expect(weeks.buckets[1]!.models.map(m => m.model)).toEqual(["big", "small"]);
    expect(weeks.models.find(m => m.model === "small")).toMatchObject({ calls: 2, totalTokens: 3, subagentTokens: 2 });
    const months = summarizeUsage([calls], { period: "month", timeZone: "UTC", from: "2026-09-01", to: "2026-10-31", sessions: 1, unreadSessions: 0 });
    expect(months.buckets.map(b => [b.start, b.totals.totalTokens])).toEqual([["2026-09-01", 0], ["2026-10-01", 53]]);
  });

  it("leaves out calls outside the range", () => {
    const report = summarizeUsage([[call("2026-10-01T00:00:00Z", "a", 9), call("2026-10-10T00:00:00Z", "a", 1)]],
      { period: "month", timeZone: "UTC", from: "2026-10-05", to: "2026-10-31", sessions: 1, unreadSessions: 0 });
    expect(report.totals.input).toBe(1);
  });

  it("defaults to 30 days, 12 weeks or 12 months ending today", () => {
    expect(defaultUsageRange("day", "2026-10-22")).toEqual({ from: "2026-09-23", to: "2026-10-22" });
    expect(bucketStarts(...Object.values(defaultUsageRange("week", "2026-10-22")) as [string, string], "week")).toHaveLength(12);
    expect(defaultUsageRange("month", "2026-10-22")).toEqual({ from: "2025-11-01", to: "2026-10-22" });
  });
});

describe("reading a managed session file's ledger", () => {
  it("reads once and again only after the file changes", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "pi-usage-ledger-"));
    const dir = path.join(dataDir, "sessions", "s1");
    mkdirSync(dir, { recursive: true });
    const manager = SessionManager.create("/tmp/project", dir);
    manager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "yo" }], api: "x", provider: "p", model: "a", usage: usage(10, 1), stopReason: "stop", timestamp: 2 } as never);
    const file = manager.getSessionFile()!;
    const storage = new PiJsonlConversationStorage(dataDir);
    const conversation = { agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: file };
    const context = { sessionId: "s1", projectId: DEFAULT_PROJECT_ID };
    const first = await storage.readUsageLedger(conversation, context);
    expect(first.map(e => e.input)).toEqual([10]);
    expect(await storage.readUsageLedger(conversation, context)).toBe(first);
    appendFileSync(file, JSON.stringify({ type: "usage", id: "u1", parentId: null, kind: "cache_warm", provider: "p", model: "a", usage: usage(4, 0), timestamp: new Date(3).toISOString() }) + "\n");
    expect((await storage.readUsageLedger(conversation, context)).map(e => e.input)).toEqual([10, 4]);
    writeFileSync(path.join(dataDir, "outside.jsonl"), "");
    await expect(storage.readUsageLedger({ ...conversation, conversationRef: path.join(dataDir, "outside.jsonl") }, context)).rejects.toThrow();
  });
});
