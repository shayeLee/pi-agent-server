import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { projectExportSnapshot } from "../../src/agent/session-export.js";

const legacyFailbackFixture = JSON.parse(readFileSync(new URL("../fixtures/model-failback-legacy-custom-error-continuation.json", import.meta.url), "utf8"));
const entry = (id: string, parentId: string | null, message: unknown) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message });

describe("Pi export tool timeline", () => {
  it("keeps assistant block order, parallel same-name calls, full output, errors, abort gaps, and excludes thinking", () => {
    const branch = [
      entry("u1", null, { role: "user", content: "run" }),
      entry("a1", "u1", { role: "assistant", content: [
        { type: "text", text: "before" },
        { type: "thinking", thinking: "private" },
        { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a", apiKey: "never" } },
        { type: "text", text: "between" },
        { type: "toolCall", id: "call-b", name: "read", arguments: { path: "b" } },
      ] }),
      entry("r1", "a1", { role: "toolResult", toolCallId: "call-b", toolName: "read", content: [{ type: "text", text: "B" }], isError: false }),
      entry("r2", "r1", { role: "toolResult", toolCallId: "call-a", toolName: "read", content: [{ type: "text", text: "A" }], details: { exitCode: 7, authorization: "never" }, isError: true }),
      entry("a2", "r2", { role: "assistant", content: [{ type: "toolCall", id: "call-aborted", name: "read", arguments: {} }] }),
    ] as any;
    const snapshot = projectExportSnapshot([], branch);

    expect(snapshot.timeline.map((item) => item.type === "tool_call" ? `${item.type}:${item.callId}:${item.status}` : item.type === "tool_result" ? `${item.type}:${item.callId}` : item.type === "message" ? `${item.type}:${item.text}` : `${item.type}:${item.event}`)).toEqual([
      "message:run", "message:before", "tool_call:call-a:error", "message:between", "tool_call:call-b:completed", "tool_result:call-b", "tool_result:call-a", "tool_call:call-aborted:no_result",
    ]);
    expect(snapshot.timeline).not.toContainEqual(expect.objectContaining({ text: "private" }));
    expect(snapshot.timeline).toContainEqual(expect.objectContaining({ callId: "call-a", args: { path: "a", apiKey: "[REDACTED]" }, messageId: "a1", turnId: "u1" }));
    expect(snapshot.timeline).toContainEqual(expect.objectContaining({ callId: "call-a", result: { content: [{ type: "text", text: "A" }], details: { exitCode: 7, authorization: "[REDACTED]" } }, isError: true }));
  });

  it("does not include an orphaned branch when the selected branch does not contain it", () => {
    const selected = [entry("u-current", null, { role: "user", content: "current" })] as any;
    expect(projectExportSnapshot([], selected).timeline).toEqual([expect.objectContaining({ messageId: "u-current", text: "current" })]);
  });

  it("uses real entry ids for image-only and empty prototype messages without text matching", () => {
    const selected = [
      entry("img-user", null, { role: "user", content: [{ type: "image", data: "bad", mimeType: "image/png" }] }),
      entry("prototype", "img-user", { role: "assistant", content: [{ type: "prototype", artifactId: "p1" }] }),
    ] as any;
    const snapshot = projectExportSnapshot([], selected);
    expect(snapshot.messages).toEqual([
      expect.objectContaining({ sourceId: "img-user", role: "user", text: "" }),
      { sourceId: "prototype", role: "assistant", text: "" },
    ]);
    expect(snapshot.timeline).toEqual([
      expect.objectContaining({ type: "message", messageId: "img-user", text: "" }),
      expect.objectContaining({ type: "message", messageId: "prototype", text: "" }),
    ]);
  });

  it("uses a persisted custom failback marker at its original position, hides only its continuation, and drops empty retry assistants", () => {
    const branch = [
      entry("u", null, { role: "user", content: "run" }),
      entry("empty", "u", { role: "assistant", content: [] }),
      { type: "custom", id: "fb", parentId: "empty", timestamp: "2026-01-01T00:00:01.000Z", customType: "model-failback", data: { from: "a/model", to: "b/model", reason: "429", continuation: "[model-failback] internal continuation" } },
      entry("continuation", "fb", { role: "user", content: [{ type: "text", text: "[model-failback] internal " }, { type: "text", text: "continuation" }] }),
      entry("b", "continuation", { role: "assistant", content: [{ type: "toolCall", id: "tool-b", name: "read", arguments: {} }, { type: "text", text: "B answered" }] }),
    ] as any;
    const snapshot = projectExportSnapshot([], branch);
    expect(snapshot.messages.map((message) => message.text)).toEqual(["run", "B answered"]);
    expect(snapshot.timeline.map((item) => item.type)).toEqual(["message", "system_event", "tool_call", "message"]);
    expect(snapshot.timeline[1]).toMatchObject({ event: "model_failback", from: "a/model", to: "b/model", reason: "429" });
    // Prefixes and near matches remain real user content, even directly after a marker.
    expect(projectExportSnapshot([], [entry("real", null, { role: "user", content: "[model-failback] real user text" })] as any).timeline).toContainEqual(expect.objectContaining({ messageId: "real" }));
    const nearMatch = [{ type: "custom", id: "marker", parentId: null, customType: "model-failback", data: { from: "a", to: "b", reason: "x", continuation: "[model-failback] exact" } }, entry("real-next", "marker", { role: "user", content: [{ type: "text", text: "[model-failback] exact but user" }] })] as any;
    expect(projectExportSnapshot([], nearMatch).timeline).toContainEqual(expect.objectContaining({ messageId: "real-next" }));
  });

  it("hides the sanitized real legacy marker → empty error assistant → text-array continuation chain", () => {
    const snapshot = projectExportSnapshot([], legacyFailbackFixture as any);
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.timeline).toEqual([expect.objectContaining({ type: "system_event", event: "model_failback", id: "system-event:failback-marker" })]);
  });

  it("uses a new marker's exact continuation after the same terminal-error link", () => {
    const fixture = structuredClone(legacyFailbackFixture);
    fixture[0].data.continuation = fixture[2].message.content[0].text;
    expect(projectExportSnapshot([], fixture as any).messages).toEqual([]);
  });

  it("preserves ambiguous continuations and real user text sharing the internal prefix", () => {
    const marker = { type: "custom", id: "marker", parentId: null, customType: "model-failback", data: { from: "source/a", to: "backup/b", reason: "quota_exhausted" } };
    const exactLookingUser = "[model-failback] 之前的模型(source/a)发生终态错误(说明)。已切换到备用模型(backup/b),请继续完成之前的任务,不要重复已完成的步骤。用户补充";
    const branch = [
      marker,
      entry("visible-error", "marker", { role: "assistant", stopReason: "error", content: [{ type: "text", text: "partial answer" }] }),
      entry("real-user", "visible-error", { role: "user", content: [{ type: "text", text: exactLookingUser }] }),
    ] as any;
    const snapshot = projectExportSnapshot([], branch);
    expect(snapshot.messages).toContainEqual(expect.objectContaining({ sourceId: "real-user", text: exactLookingUser }));
    expect(snapshot.timeline).toContainEqual(expect.objectContaining({ type: "message", messageId: "real-user", text: exactLookingUser }));
  });

  it("sanitizes a very deep payload iteratively and leaves the enclosing export JSON-serializable", () => {
    let deep: unknown = { token: "do-not-leak" };
    for (let index = 0; index < 10_000; index += 1) deep = { child: deep };
    const snapshot = projectExportSnapshot([], [
      entry("a", null, { role: "assistant", content: [{ type: "toolCall", id: "deep", name: "inspect", arguments: deep }] }),
    ] as any);
    const encoded = JSON.stringify(snapshot);
    expect(encoded).toContain("nesting_too_deep");
    expect(encoded).not.toContain("do-not-leak");
  });
});
