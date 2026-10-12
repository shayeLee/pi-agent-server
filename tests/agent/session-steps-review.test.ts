import { describe, expect, it } from "vitest";
import { projectColdSessionSteps, SessionStepsProjector } from "../../src/agent/session-steps-projector.js";
const text = (text: string) => ({ type: "text", text });
const assistant = (content: unknown[]) => ({ role: "assistant", content, stopReason: "stop" });
const entry = (id: string, message: unknown) => ({ type: "message", id, message });
describe("steps review regressions", () => {
  it("reports thinking omission only for actual signatures or source redaction", () => {
    const message = assistant([
      { type: "thinking", thinking: "visible" },
      { type: "thinking", thinking: "signed", thinkingSignature: "encrypted" },
      { type: "thinking", thinking: "redacted", redacted: true },
    ]);
    const hot = new SessionStepsProjector(() => []);
    hot.observe({ type: "message_end", message });
    for (const snapshot of [hot.snapshot("s"), projectColdSessionSteps("thinking-omission", [entry("thinking", message)])]) {
      expect(snapshot.steps[0]).not.toHaveProperty("omission");
      expect(snapshot.steps[1]?.omission).toBe("Provider signature omitted");
      expect(snapshot.steps[2]?.omission).toContain("Thinking redacted by source");
    }
  });
  it("preserves ordinary tool signatures while omitting SDK and unknown-block provider signatures", () => {
    const ordinary = { signature: "ordinary-signature", functionSignature: "function declaration", nested: { signature: "nested-signature" } };
    const message = assistant([{ type: "toolCall", id: "A", name: "tool", arguments: ordinary }]);
    const final = { role: "toolResult", toolCallId: "A", content: [text("result")], details: ordinary,
      nestedCalls: [{ args: ordinary, content: [{ type: "thinking", thinking: "safe", thinkingSignature: "encrypted-thinking" },
        { type: "text", text: "safe", textSignature: "encrypted-text" },
        { type: "unknown", text: "safe", signature: "encrypted-unknown", thoughtSignature: "encrypted-thought" }] }] };
    const branch = [entry("call", message), entry("result", final)];
    const hot = new SessionStepsProjector(() => []);
    hot.observe({ type: "message_end", message });
    hot.observe({ type: "tool_execution_end", toolCallId: "A", result: { content: [text("result")], details: ordinary } });
    expect((hot.snapshot("s").steps.find(s => s.kind === "tool_result")!.content as any).details).toEqual(ordinary);
    hot.observe({ type: "message_end", message: final });
    for (const snapshot of [hot.snapshot("s"), projectColdSessionSteps("signature-cold", branch)]) {
      expect(snapshot.steps.find(s => s.kind === "tool_call")?.content).toEqual(ordinary);
      const output = snapshot.steps.find(s => s.kind === "tool_result")!.content as any;
      expect(output.details).toEqual(ordinary);
      expect(output.nestedCalls[0].args).toEqual(ordinary);
      expect(JSON.stringify(snapshot)).not.toContain("encrypted-");
    }
  });
  it("projects context edits using target visibility and safe blocks, hot and cold", () => {
    const branch: any[] = [entry("visible", assistant([text("original")])),
      { type: "custom_message", id: "hidden", display: false, content: "private" },
      { type: "custom", id: "internal", customType: "state", data: {} },
      { type: "custom_message", id: "public", display: true, content: "public" }];
    const p = new SessionStepsProjector(() => branch);
    for (const targetId of ["visible", "hidden", "internal", "unknown", "public"]) branch.push({
      type: "context_edit", id: `edit-${targetId}`, targetId, replacement: { display: true, content: [
        { type: "thinking", thinking: targetId === "visible" ? "safe reasoning" : `${targetId}-replacement-secret`, thinkingSignature: "signature-secret" },
        text(targetId === "visible" || targetId === "public" ? "complete safe text" : `${targetId}-replacement-secret`),
        { type: "unknown", signature: "unknown-signature-secret", text: "safe unknown" },
      ] },
    });
    branch.push({ type: "context_edit", id: "omit", targetId: "visible", replacement: null });
    for (const snapshot of [p.snapshot("hot"), projectColdSessionSteps("cold", branch)]) {
      const json = JSON.stringify(snapshot);
      for (const secret of ["signature-secret", "hidden-replacement-secret", "internal-replacement-secret", "unknown-replacement-secret"]) expect(json).not.toContain(secret);
      const edits = snapshot.steps.filter(s => s.label === "context_edit");
      expect(edits.find(s => s.sourceEntryId === "edit-visible")?.content).toMatchObject({ targetId: "visible", replacement: { content: [{ type: "thinking", thinking: "safe reasoning" }, text("complete safe text"), { type: "unknown", text: "safe unknown" }] } });
      expect(edits.find(s => s.sourceEntryId === "edit-public")).toBeDefined();
      expect(edits.find(s => s.sourceEntryId === "omit")?.content).toEqual({ targetId: "visible", replacement: null });
    }
  });
  it("scopes repeated nested ids by parent occurrence and separates parallel parents", () => {
    const p = new SessionStepsProjector(() => []);
    for (let round = 0; round < 2; round++) {
      const message = assistant(["A", "B"].map(id => ({ type: "toolCall", id, name: id, arguments: {} })));
      p.observe({ type: "message_start", message }); p.observe({ type: "message_end", message });
      for (const parent of ["A", "B"]) p.observe({ type: "tool_execution_start", toolCallId: "shared/1", parentToolCallId: parent, toolName: "child", args: { round, parent } });
      for (const parent of ["B", "A"]) p.observe({ type: "tool_execution_end", toolCallId: "shared/1", parentToolCallId: parent, result: { content: [text(`${round}-${parent}`)] } });
      p.observe({ type: "tool_execution_start", toolCallId: "A/1", parentToolCallId: "A", args: { round } });
      p.observe({ type: "tool_execution_end", toolCallId: "A/1", parentToolCallId: "A", result: false });
    }
    const steps = p.snapshot("s").steps;
    expect(steps.filter(s => s.toolCallId === "A/1").map(s => s.kind)).toEqual(["tool_call", "tool_result", "tool_call", "tool_result"]);
    const nested = steps.filter(s => s.toolCallId === "shared/1");
    expect(nested).toHaveLength(8);
    expect(new Set(nested.map(s => s.id)).size).toBe(8);
    expect(nested.filter(s => s.kind === "tool_result").map(s => [s.parentToolCallId, s.content])).toEqual([0, 1].flatMap(round => ["B", "A"].map(parent => [parent, { content: [text(`${round}-${parent}`)] }])));
  });
  it("keeps two rounds of three-level SDK-shaped trees and sibling parents independent", () => {
    const p = new SessionStepsProjector(() => []);
    for (let round = 0; round < 2; round++) {
      p.observe({ type: "message_end", message: assistant(["A", "B"].map(id => ({ type: "toolCall", id, name: id, arguments: {} }))) });
      for (const parent of ["A", "B"]) {
        p.observe({ type: "tool_execution_start", toolCallId: parent, args: {} });
        p.observe({ type: "tool_execution_start", toolCallId: `${parent}/1`, parentToolCallId: parent, args: { round, parent } });
        p.observe({ type: "tool_execution_start", toolCallId: `${parent}/1/1`, parentToolCallId: `${parent}/1`, args: { round, parent } });
      }
      for (const parent of ["B", "A"]) {
        for (const id of [`${parent}/1/1`, `${parent}/1`, parent]) {
          p.observe({ type: "tool_execution_end", toolCallId: id, ...(id.includes("/") ? { parentToolCallId: id.slice(0, id.lastIndexOf("/")) } : {}), result: { content: [text(`${round}-${id}`)] } });
        }
      }
    }
    const steps = p.snapshot("s").steps;
    expect(steps).toHaveLength(24);
    expect(new Set(steps.map(s => s.id)).size).toBe(24);
    expect(steps.filter(s => s.kind === "tool_result").map(s => s.content)).toEqual([0, 1].flatMap(round => ["B/1/1", "B/1", "B", "A/1/1", "A/1", "A"].map(id => ({ content: [text(`${round}-${id}`)] }))));
  });
  it("does not reuse completed parent invocations for unknown-parent executions", () => {
    const p = new SessionStepsProjector(() => []);
    p.observe({ type: "tool_execution_start", toolCallId: "A", args: {} });
    p.observe({ type: "tool_execution_end", toolCallId: "A", result: false });
    for (let round = 0; round < 2; round++) {
      for (const parent of ["A", "missing"]) {
        p.observe({ type: "tool_execution_start", toolCallId: `${parent}/1`, parentToolCallId: parent, args: { round } });
        p.observe({ type: "tool_execution_end", toolCallId: `${parent}/1`, parentToolCallId: parent, result: round });
      }
    }
    const steps = p.snapshot("s").steps;
    expect(steps).toHaveLength(10);
    expect(new Set(steps.map(s => s.id)).size).toBe(10);
    expect(steps.filter(s => s.kind === "tool_result").map(s => s.content)).toEqual([false, 0, 0, 1, 1]);
  });
  it.each([
    { label: "text", content: [text("same text")] },
    { label: "image-only", content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==" }] },
    { label: "empty", content: [] },
  ])("upserts user start/end immediately without merging repeated $label entries", ({ content }) => {
    const branch: any[] = [];
    const p = new SessionStepsProjector(() => branch);
    for (let round = 0; round < 2; round++) {
      p.observe({ type: "message_start", message: { role: "user", content: structuredClone(content) } });
      const before = p.snapshot("s").steps;
      expect(before).toHaveLength(round + 1);
      const started = before.at(-1)!;
      expect(started.status).toBe("streaming");
      const message = { role: "user", content: structuredClone(content) };
      p.observe({ type: "message_end", message });
      const immediate = p.snapshot("s").steps;
      expect(immediate).toHaveLength(round + 1);
      expect(immediate.at(-1)).toMatchObject({ id: started.id, timestamp: started.timestamp, status: "completed" });
      expect(immediate.every(s => s.status === "completed")).toBe(true);
      branch.push(entry(`user-${round}`, message));
      expect(p.snapshot("s").steps.at(-1)?.sourceEntryId).toBe(`user-${round}`);
    }
    expect(new Set(p.snapshot("s").steps.map(s => s.id)).size).toBe(2);
  });
  it.each([{ final: [] }, { final: [text("final")] }])("uses authoritative final assistant block set $final", ({ final }) => {
    const branch: any[] = [];
    const p = new SessionStepsProjector(() => branch);
    p.observe({ type: "message_end", message: assistant([text("previous")]) });
    p.observe({ type: "message_start", message: assistant([]) });
    p.observe({ type: "message_update", message: assistant([text("old one"), text("old two")]) });
    const id = p.snapshot("s").steps.find(s => s.content === "old one")!.id;
    p.observe({ type: "tool_execution_end", toolCallId: "unrelated", result: false });
    const message = assistant(final);
    p.observe({ type: "message_end", message }); branch.push(entry("final", message));
    const snapshot = p.snapshot("s");
    expect(JSON.stringify(snapshot)).not.toContain("old one"); expect(JSON.stringify(snapshot)).not.toContain("old two");
    expect(snapshot.steps.some(s => s.content === "previous")).toBe(true);
    expect(snapshot.steps.filter(s => s.kind === "tool_result")).toHaveLength(1);
    expect(snapshot.steps.some(s => s.status === "streaming")).toBe(false);
    if (final.length) expect(snapshot.steps.find(s => s.content === "final")?.id).toBe(id);
    else expect(snapshot.steps.find(s => s.sourceEntryId === "final")).toMatchObject({ content: "", omission: "Source has no visible content blocks" });
  });
  it.each([{ content: [] }, { content: false }, { content: null }])("refreshes existing result from authoritative final message $content without moving it", ({ content }) => {
    const branch: any[] = [];
    const p = new SessionStepsProjector(() => branch);
    p.observe({ type: "message_end", message: assistant(["A", "B"].map(id => ({ type: "toolCall", id, name: id, arguments: {} }))) });
    for (const id of ["B", "A"]) p.observe({ type: "tool_execution_end", toolCallId: id, parentToolCallId: "parent", result: { content: [text("obsolete")], details: { obsolete: true } }, isError: true });
    const before = p.snapshot("s").steps.filter(s => s.kind === "tool_result");
    for (const id of ["A", "B"]) {
      const message = { role: "toolResult", toolCallId: id, toolName: "final", content, isError: false, details: { nil: null, bool: false, zero: 0, token: "credential-secret" }, nestedCalls: [{ content: [{ type: "thinking", thinking: "safe", thinkingSignature: "signature-secret" }] }] };
      p.observe({ type: "message_start", message });
      expect(p.snapshot("s").steps.find(s => s.id === before.find(s => s.toolCallId === id)!.id)?.status).toBe("completed");
      p.observe({ type: "message_end", message }); branch.push(entry(id, message));
    }
    const after = p.snapshot("s").steps.filter(s => s.kind === "tool_result");
    expect(after.map(s => [s.id, s.timestamp, s.toolCallId, s.parentToolCallId])).toEqual(before.map(s => [s.id, s.timestamp, s.toolCallId, s.parentToolCallId]));
    expect(after.map(s => s.sourceEntryId)).toEqual(["B", "A"]);
    for (const step of after) expect(step).toMatchObject({ status: "completed", toolName: "final", content: { content, details: { nil: null, bool: false, zero: 0, token: "[REDACTED]" }, nestedCalls: [{ content: [{ type: "thinking", thinking: "safe" }] }] } });
    expect(JSON.stringify(after)).not.toContain("signature-secret");
    expect(JSON.stringify(after)).not.toContain("obsolete");
  });
});
