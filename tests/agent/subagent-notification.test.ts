import { describe, it, expect } from "vitest";
import { readExtensionFixture } from "./subagent-extension-fixture.js";
import { randomUUID } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { notificationFromEntry } from "../../src/agent/subagent-notification.js";
import { projectExportSnapshot } from "../../src/agent/session-export.js";
import { createChatState, applySseEvent } from "../../src/client/chat-state.js";
import { firstUserPrompt } from "../../src/client/session-title.js";

const payload = { version: 1 as const, notificationId: randomUUID(), runIds: ["run-a"], text: "### worker — stopped\n\n结果" };
const marker = { type: "custom", customType: "agent-team:notification", id: "marker", parentId: null, timestamp: "2026-01-01T00:00:00Z", data: payload };

describe("dedicated subagent notification boundary", () => {
  it("validates only versioned dedicated entries", () => {
    expect(notificationFromEntry(marker)).toMatchObject({ type: "notification", entryId: "marker", ...payload });
    for (const bad of [{ ...marker, customType: "unknown" }, { ...marker, type: "custom_message" }, { ...marker, data: { ...payload, version: 2 } }, { ...marker, data: { ...payload, notificationId: "bad" } }, { ...marker, data: { ...payload, runIds: [3] } }]) expect(notificationFromEntry(bad)).toBeNull();
  });
  it("history/live/replay dedup is id-based; same-text users and unknown custom remain unchanged", () => {
    const user = { type: "message", id: "user", parentId: "marker", timestamp: marker.timestamp, message: { role: "user", content: payload.text, timestamp: 1 } };
    const branch = [marker, { ...marker, id: "duplicate" }, { type: "custom_message", id: "companion", customType: "agent-team:results-ready", content: payload.text, details: { notificationId: payload.notificationId }, display: false }, user, { ...marker, id: "other", customType: "unknown" }];
    const exported = projectExportSnapshot([], branch as any);
    expect(exported.timeline.map(row => row.type)).toEqual(["notification", "message"]);
    expect(firstUserPrompt(projectExportSnapshot([], [marker] as any).messages)).toBeNull();
    expect(exported.messages).toHaveLength(1);
    expect(exported.messages[0]).toMatchObject({ role: "user", text: payload.text });
    const live = notificationFromEntry(marker)!;
    let state = { ...createChatState(), phase: "aborted" as const };
    const next = applySseEvent(state, live);
    const replay = applySseEvent(next, live);
    expect(replay.timeline).toHaveLength(1);
    expect(replay.phase).toBe("aborted"); expect(replay.stats).toBeNull();
    expect(replay.timeline.filter(row => row.kind === "message" && row.role === "user")).toHaveLength(0);
    expect(replay.timeline[0]?.id).toBe(exported.timeline[0]?.id);
  });
  it.each([true, false, "throw"] as const)("global host transport admission %s never falls back and holds synchronous inflight", async (accepted) => {
    const source = readExtensionFixture();
    const block = source.slice(source.indexOf("\tconst notifications ="), source.indexOf('\n\tpi.registerCommand("subagents"'));
    const js = stripTypeScriptTypes(block);
    let report = () => {}; let notified = false; let posts = 0; let resolve!: (ack: unknown) => void;
    const pending = [{ runId: "run-a", agent: "worker", status: "stopped", result: {} }];
    const entries: any[] = []; const direct: any[] = [];
    const pi = { on: (_: string, handler: () => void) => { report = handler; },
      appendEntry: (type: string, data: any) => { entries.push({ type, data }); report(); }, sendMessage: (message: unknown) => { direct.push(message); } };
    const host = { post: (data: any) => {
      posts++; report(); expect(data.notificationId).toBe(entries[0].data.notificationId);
      if (accepted === "throw") return Promise.reject(new Error("failed"));
      return new Promise(r => { resolve = r; });
    } };
    new Function("pi", "backgroundRuns", "randomUUID", "getResultOutput", "shuttingDown", "hostTransport", "hostMode", js)(pi,
      { needsReminder: () => notified ? [] : pending, markNotified: () => { notified = true; } }, randomUUID, () => "original output", false, host, true);
    report(); report(); expect(posts).toBe(1); expect(entries).toHaveLength(1); expect(notified).toBe(false);
    if (accepted !== "throw") resolve({ accepted });
    await new Promise(r => setTimeout(r, 0)); expect(notified).toBe(accepted === true); expect(direct).toHaveLength(0);
  });
  it("host identity without transport appends display but never sends SDK direct", () => {
    const source = readExtensionFixture();
    const block = source.slice(source.indexOf("\tconst notifications ="), source.indexOf('\n\tpi.registerCommand("subagents"'));
    let report = () => {}; let marked = false;
    const entries: unknown[] = []; const sends: unknown[] = [];
    const pi = { on: (_: string, handler: () => void) => { report = handler; },
      appendEntry: (...args: unknown[]) => entries.push(args), sendMessage: (...args: unknown[]) => sends.push(args) };
    new Function("pi", "backgroundRuns", "randomUUID", "getResultOutput", "shuttingDown", "hostTransport", "hostMode", stripTypeScriptTypes(block))(pi,
      { needsReminder: () => [{ runId: "run", agent: "worker", status: "stopped" }], markNotified: () => { marked = true; } }, randomUUID, () => "output", false, undefined, true);
    report(); report(); expect(entries).toHaveLength(1); expect(sends).toHaveLength(0); expect(marked).toBe(false);
  });
  it("fixture extension append/send preserves follow-up text and options, guards reentrant double callbacks, reuses failed id", () => {
    const source = readExtensionFixture();
    const block = source.slice(source.indexOf("\tconst notifications ="), source.indexOf('\n\tpi.registerCommand("subagents"'));
    const js = stripTypeScriptTypes(block);
    const pending = [{ runId: "run-a", agent: "worker", status: "stopped", result: {} }];
    let notified = false; let report: () => void = () => {}; let appendFails = true; let sendFails = true;
    const entries: any[] = []; const sends: any[] = [];
    const pi = {
      on: (_: string, handler: () => void) => { report = handler; },
      appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); report(); if (appendFails) throw new Error("append"); },
      sendMessage: (message: unknown, options: unknown) => { sends.push({ message, options }); report(); if (sendFails) throw new Error("send"); },
    };
    new Function("pi", "backgroundRuns", "randomUUID", "getResultOutput", "shuttingDown", "hostTransport", "hostMode", js)(pi, { needsReminder: () => notified ? [] : pending, markNotified: () => { notified = true; } }, randomUUID, () => "original output", false, undefined, false);
    report(); expect(sends).toHaveLength(0); appendFails = false;
    report(); expect(sends).toHaveLength(1); expect(notified).toBe(false); sendFails = false;
    report(); report(); expect(entries).toHaveLength(2); expect(sends).toHaveLength(2);
    expect(entries[0].data.notificationId).toBe(entries[1].data.notificationId);
    expect(sends[1]).toEqual({ message: { customType: "agent-team:results-ready", display: false, details: { version: 1, notificationId: entries[0].data.notificationId }, content: "1 background subagent result(s) are waiting to be collected. Call subagent_wait to read the full result.\n\n### [worker] run run-a — stopped\n\noriginal output" }, options: { deliverAs: "followUp", triggerTurn: true } });
  });
});
