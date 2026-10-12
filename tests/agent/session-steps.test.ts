import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStepsProjector, projectColdSessionSteps } from "../../src/agent/session-steps-projector.js";
import { readPiJsonlSteps } from "../../src/agent/pi-jsonl-conversation-storage.js";
import { steeringSdkFixture } from "./steering-sdk-fixture.js";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const entry = (id: string, message: any, parentId: string | null = null) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message });
const assistant = (content: any[]) => ({ role: "assistant", content, stopReason: "stop" });
const text = (value: string) => ({ type: "text", text: value });
describe("independent session steps", () => {
  it("copies active unsaved blocks, tracks ordinal not object identity, retains >1000 deltas and exact final ref", async () => {
    const branch: any[] = [];
    const p = new SessionStepsProjector(() => branch);
    p.observe({ type: "message_start", message: assistant([]) });
    const before = p.snapshot("s");
    for (let i = 1; i <= 1100; i++) p.observe({ type: "message_update", message: assistant([{ type: "thinking", thinking: "reason", thinkingSignature: "encrypted" }, text("x".repeat(i)), text("")]) });
    const active = p.snapshot("s");
    expect(active.steps.map(s => s.kind)).toEqual(["thinking", "assistant_text", "assistant_text"]);
    expect(active.steps[1]!.content).toHaveLength(1100);
    expect(active.revision).toBeGreaterThan(before.revision);
    const final = assistant([{ type: "thinking", thinking: "reason" }, text("x".repeat(1100)), text("")]);
    p.observe({ type: "message_end", message: final });
    const ended = p.snapshot("s");
    expect(ended.steps[1]!.sourceEntryId).toBeUndefined();
    branch.push(entry("a", final));
    await Promise.resolve();
    const recorded = p.snapshot("s");
    expect(recorded.steps.map(s => s.id)).toEqual(ended.steps.map(s => s.id));
    expect(recorded.steps.every(s => s.sourceEntryId === "a" && s.source === "observed")).toBe(true);
    final.content[1].text = "mutated";
    expect(active.steps[1]!.content).toHaveLength(1100);
    expect(JSON.stringify(active)).not.toContain("encrypted");
    p.observe({ type: "message_start", message: assistant([text("same")]) });
    const equalFinal = assistant([text("same")]);
    p.observe({ type: "message_end", message: equalFinal });
    branch.push(entry("b", equalFinal, "a"));
    p.observe({ type: "message_start", message: assistant([text("same")]) });
    expect(p.snapshot("s").steps.filter(s => s.content === "same")).toHaveLength(2);
  });
  it("compares only changed steps across large history during continuous deltas", () => {
    const branch = [entry("history", { role: "toolResult", toolCallId: "old", toolName: "large", content: [text("h".repeat(200000))], isError: false })];
    const p = new SessionStepsProjector(() => branch);
    const historicalStep = p.snapshot("s").steps[0]!;
    p.observe({ type: "message_start", message: assistant([]) });
    const before = p.snapshot("s");
    const stringify = vi.spyOn(JSON, "stringify");
    for (let i = 1; i <= 5; i++) p.observe({ type: "message_update", message: assistant([text("x".repeat(i))]) });
    const calls = stringify.mock.calls;
    stringify.mockRestore();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([value]) => !Array.isArray(value) && value !== historicalStep)).toBe(true);
    const delta = p.snapshot("s");
    expect(delta.revision).toBeGreaterThan(before.revision);
    expect(p.snapshot("s").revision).toBe(delta.revision);
  });
  it("keeps parallel completion B→A when recorded results arrive A→B, scopes reused call ids and retains parent", async () => {
    const branch: any[] = [];
    const p = new SessionStepsProjector(() => branch);
    const a = assistant([{ type: "toolCall", id: "A", name: "alpha", arguments: { password: "secret", x: false } }, { type: "toolCall", id: "B", name: "beta", arguments: { n: 0 } }]);
    p.observe({ type: "message_start", message: structuredClone(a) });
    p.observe({ type: "message_end", message: a }); branch.push(entry("calls", a));
    for (const id of ["B", "A"]) p.observe({ type: "tool_execution_end", toolCallId: id, toolName: id, parentToolCallId: "parent", result: { content: [text(id)], details: { nil: null, bool: false, zero: 0, token: "secret" } }, isError: false });
    const before = p.snapshot("s");
    for (const id of ["A", "B"]) {
      const message = { role: "toolResult", toolCallId: id, toolName: id, content: [text(id)], isError: false };
      p.observe({ type: "message_start", message }); p.observe({ type: "message_end", message }); branch.push(entry(`result-${id}`, message));
    }
    await Promise.resolve();
    const snapshot = p.snapshot("s");
    const results = snapshot.steps.filter(s => s.kind === "tool_result");
    expect(results.map(s => s.toolCallId)).toEqual(["B", "A"]);
    expect(results.map(s => s.sourceEntryId)).toEqual(["result-B", "result-A"]);
    expect(results.map(s => s.id)).toEqual(before.steps.filter(s => s.kind === "tool_result").map(s => s.id));
    expect(results.every(s => s.parentToolCallId === "parent")).toBe(true);
    expect((before.steps.find(s => s.kind === "tool_result")!.content as any).details).toEqual({ nil: null, bool: false, zero: 0, token: "[REDACTED]" });
    // The final SDK message is authoritative, including removal of earlier metadata.
    expect((results[0]!.content as any).details).toBeUndefined();
    p.observe({ type: "message_start", message: assistant([{ type: "toolCall", id: "A", name: "again", arguments: {} }]) });
    p.observe({ type: "tool_execution_end", toolCallId: "A", result: { content: [text("again")] }, isError: true });
    expect(p.snapshot("s").steps.filter(s => s.kind === "tool_result")).toHaveLength(3);
  });
  it("does not guess source ids by text and changes projection on branch navigation", () => {
    let branch: any[] = [];
    const p = new SessionStepsProjector(() => branch);
    p.observe({ type: "message_end", message: assistant([text("same")]) });
    branch.push(entry("unrelated", assistant([text("same")])));
    const first = p.snapshot("s");
    expect(first.steps[0]!.sourceEntryId).toBeUndefined();
    expect(first.steps).toHaveLength(2);
    branch = [entry("other", { role: "user", content: "other" })];
    const next = p.snapshot("s");
    expect(next.projectionId).not.toBe(first.projectionId);
    expect(next.steps).toHaveLength(1);
  });
  it("preserves safe historical visible/custom/summary/bash/error/empty/unknown content without exposing internal state", () => {
    const branch = [entry("u", { role: "user", content: "" }), entry("a", assistant([{ type: "thinking", redacted: true, thinkingSignature: "hidden" }, text("a".repeat(200000)), { type: "unknown", text: "visible", secret: "hidden" }])),
      { type: "custom", id: "state", customType: "internal", data: { secret: "hidden" } }, { type: "custom_message", id: "visible", display: true, customType: "public", content: "public" }, { type: "custom_message", id: "hidden", display: false, content: "hidden" },
      { type: "branch_summary", id: "summary", summary: "branch" }, { type: "compaction", id: "compact", summary: "compact" }, entry("bash", { role: "bashExecution", command: "echo", output: "output", exitCode: 0, cancelled: false, truncated: true }), entry("error", { ...assistant([]), stopReason: "error", errorMessage: "failure" })];
    const snapshot = projectColdSessionSteps("s", branch);
    expect(snapshot.steps.map(s => s.kind)).toEqual(["user", "thinking", "assistant_text", "custom", "custom", "system_event", "compaction", "system_event", "error"]);
    expect(snapshot.steps[2]!.content).toHaveLength(200000);
    expect(snapshot.steps[1]!.omission).toContain("redacted");
    expect(snapshot.steps[3]!.omission).toContain("Unknown");
    expect(JSON.stringify(snapshot)).not.toContain("hidden");
    expect(snapshot.steps.every(s => s.source === "recorded")).toBe(true);
    expect(snapshot.steps.find(s => s.sourceEntryId === "visible")!.timestamp).toBeUndefined();
  });
  it("filters unsafe images, hides custom state, and projects recorded custom once after SDK conversion", async () => {
    const branch: any[] = [];
    const p = new SessionStepsProjector(() => branch);
    const custom = { role: "custom", customType: "public", display: true, content: "visible" };
    p.observe({ type: "message_start", message: custom });
    p.observe({ type: "message_end", message: custom });
    branch.push({ type: "custom_message", id: "custom", customType: "public", display: true, content: "visible" });
    await Promise.resolve();
    expect(p.snapshot("s").steps).toHaveLength(1);
    expect(p.snapshot("s").steps[0]).toMatchObject({ source: "recorded", sourceEntryId: "custom", content: "visible" });
    const images = projectColdSessionSteps("s", [entry("image", { role: "user", content: [{ type: "image", mimeType: "image/svg+xml", data: "bad", url: "https://never-fetch.invalid/image" }, text("complete")] })]);
    expect(images.steps[0]!.images).toBeUndefined();
    expect(images.steps[0]!.omission).toContain("validated");
    expect(JSON.stringify(images)).toContain("complete");
    expect(JSON.stringify(images)).not.toContain('"data":"bad"');
    p.observe({ type: "tool_execution_start", toolCallId: "nested", parentToolCallId: "parent", toolName: "child", args: { token: "secret", value: 0 } });
    p.observe({ type: "tool_execution_end", toolCallId: "nested", parentToolCallId: "parent", toolName: "child", result: false, isError: false });
    const nested = p.snapshot("s").steps.filter(s => s.toolCallId === "nested");
    expect(nested.map(s => s.kind)).toEqual(["tool_call", "tool_result"]);
    expect(nested[0]!.content).toEqual({ token: "[REDACTED]", value: 0 });
    expect(nested[1]!.content).toBe(false);
    expect(nested.every(s => s.parentToolCallId === "parent")).toBe(true);
  });
  it("reads selected branch from temporary JSONL without rewriting", async () => {
    const root = await mkdtemp(join(tmpdir(), "steps-cold-"));
    try {
      const file = join(root, "fixture.jsonl");
      const records = [{ type: "session", version: 3, id: "s", cwd: root }, entry("root", { role: "user", content: "root" }), entry("left", assistant([text("left")]), "root"), entry("right", assistant([text("right")]), "root")];
      const content = records.map(r => JSON.stringify(r)).join("\n") + "\n";
      await writeFile(file, content);
      const snapshot = await readPiJsonlSteps(file, "s");
      expect(snapshot.steps.map(s => s.content)).toEqual(["root", "right"]);
      expect(await readFile(file, "utf8")).toBe(content);
      expect(await readPiJsonlSteps(file, "s")).toEqual(snapshot);
      const append = entry("append", assistant([text("append")]), "right");
      await writeFile(file, content + JSON.stringify(append) + "\n");
      const appended = await readPiJsonlSteps(file, "s");
      expect(appended.projectionId).toBe(snapshot.projectionId);
      expect(appended.revision).toBeGreaterThan(snapshot.revision);
      expect(await readPiJsonlSteps(file, "s")).toEqual(appended);
      await writeFile(file, records.map(r => JSON.stringify(r)).join("\n") + "\n" + JSON.stringify(entry("new-branch", assistant([text("new")]), "root")) + "\n");
      const branched = await readPiJsonlSteps(file, "s");
      expect(branched.projectionId).not.toBe(appended.projectionId);
      expect(await readPiJsonlSteps(file, "s")).toEqual(branched);
      expect(await readPiJsonlSteps(null, "empty")).toMatchObject({ sessionId: "empty", steps: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("uses real SDK synthetic streaming and binds final reference after its callback append", async () => {
    const root = await mkdtemp(join(tmpdir(), "steps-sdk-"));
    let stream: ReturnType<typeof createAssistantMessageEventStream> | undefined;
    let model: any;
    const f = await steeringSdkFixture(root, session => { session.agent.streamFunction = m => { model = m; stream = createAssistantMessageEventStream(); return stream; }; });
    try {
      const userSnapshots: { event: string; steps: ReturnType<typeof f.adapter.getSessionSteps>["steps"] }[] = [];
      f.session.subscribe(event => {
        if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "user") {
          userSnapshots.push({ event: event.type, steps: f.adapter.getSessionSteps("s").steps.filter(s => s.kind === "user") });
        }
      });
      const running = f.adapter.prompt("offline");
      await expect.poll(() => Boolean(stream)).toBe(true);
      expect(userSnapshots.map(snapshot => snapshot.event)).toEqual(["message_start", "message_end"]);
      expect(userSnapshots.map(snapshot => snapshot.steps.length)).toEqual([1, 1]);
      expect(userSnapshots[1]!.steps[0]).toMatchObject({ id: userSnapshots[0]!.steps[0]!.id, status: "completed" });
      const message: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "pending", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream!.push({ type: "start", partial: { ...message } });
      message.content = [{ type: "thinking", thinking: "reason" }, text("live")];
      stream!.push({ type: "text_delta", contentIndex: 1, delta: "live", partial: structuredClone(message) });
      await expect.poll(() => f.adapter.getSessionSteps("s").steps.some(s => s.content === "live" && s.status === "streaming")).toBe(true);
      let callbackSnapshot: any;
      f.session.subscribe(event => { if (event.type === "message_end" && event.message.role === "assistant") callbackSnapshot = f.adapter.getSessionSteps("s"); });
      message.stopReason = "stop";
      stream!.push({ type: "done", reason: "stop", message }); stream!.end(message);
      await running;
      const final = f.adapter.getSessionSteps("s");
      const observed = final.steps.filter(s => s.kind === "thinking" || s.kind === "assistant_text");
      expect(observed).toHaveLength(2);
      expect(observed.every(s => s.sourceEntryId && s.status === "completed")).toBe(true);
      expect(callbackSnapshot.steps.filter((s: any) => s.kind === "thinking" || s.kind === "assistant_text").map((s: any) => s.id)).toEqual(observed.map(s => s.id));
      expect(callbackSnapshot.steps.find((s: any) => s.content === "live").sourceEntryId).toBeUndefined();
    } finally { f.adapter.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
