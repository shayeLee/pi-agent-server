import { describe, expect, it } from "vitest";
import { projectExportTimeline, projectLegacyHistory } from "./history-projection.js";

describe("export history projection", () => {
  it("restores abort evidence only for assistant replies", () => {
    const result = projectExportTimeline([
      { type: "message", role: "user", text: "question", stopReason: "aborted" },
      { type: "message", role: "assistant", text: "partial", stopReason: "aborted" },
      { type: "message", role: "assistant", text: "complete", stopReason: "stop" },
    ], []);
    expect(result[0]).not.toHaveProperty("stopReason");
    expect(result[1]).toMatchObject({ stopReason: "aborted", streaming: false });
    expect(result[2]).not.toHaveProperty("stopReason");
  });
  it("associates images by source ID, not identical prompt text", () => {
    const images = [{ mediaType: "image/png", base64: "AA==" }];
    const result = projectExportTimeline([
      { type: "message", role: "user", messageId: "one", text: "same" },
      { type: "message", role: "user", messageId: "two", text: "same" },
      { type: "message", role: "assistant", id: "reply", text: "same" },
    ], [{ role: "user", sourceId: "two", images }]);
    expect(result).toEqual([
      { kind: "message", id: "history-message:one", role: "user", text: "same", streaming: false, images: undefined },
      { kind: "message", id: "history-message:two", role: "user", text: "same", streaming: false, images },
      { kind: "message", id: "history-reply", role: "assistant", text: "same", streaming: false },
    ]);
  });

  it("settles the latest matching tool call and retains valid duration and standalone results", () => {
    const result = projectExportTimeline([
      { type: "tool_call", id: "first", toolCallId: "call", toolName: "bash", args: { command: "one" } },
      { type: "tool_call", id: "second", toolCallId: "call", toolName: "bash", args: { command: "two" } },
      { type: "tool_result", toolCallId: "call", result: "done", durationMs: 0 },
      { type: "tool_result", id: "orphan", toolCallId: "orphan", result: "failure", isError: true, durationMs: -1 },
    ], []);
    expect(result[0]).toMatchObject({ kind: "tool", call: { done: false } });
    expect(result[1]).toMatchObject({ kind: "tool", call: { args: { command: "two" }, done: true, result: "done", durationMs: 0 } });
    expect(result[2]).toMatchObject({ kind: "tool", call: { toolName: "工具", done: true, isError: true } });
    if (result[2]?.kind === "tool") expect(result[2].call).not.toHaveProperty("durationMs");
  });

  it("restores extension command runs and drops malformed output lines", () => {
    const row = { type: "command_output", version: 1, name: "antigravity.usage", args: "all", failed: true, entryId: "e9", timestamp: "2026-10-19T10:00:00Z",
      output: [{ level: "error", text: "No credentials" }, { level: "loud", text: "x" }, null] };
    expect(projectExportTimeline([row, { ...row, name: 1 }], [])).toEqual([{ kind: "command", id: "command:e9", version: 1, name: "antigravity.usage", args: "all",
      failed: true, output: [{ level: "error", text: "No credentials" }], entryId: "e9", timestamp: "2026-10-19T10:00:00Z" }]);
  });

  it("deduplicates notifications and skips malformed rows without reordering history", () => {
    const notification = { type: "notification", version: 1, notificationId: "n", entryId: "e", text: "notice", runIds: [] };
    expect(projectExportTimeline([null, false, notification, { ...notification, text: "duplicate" },
      { ...notification, notificationId: "invalid", runIds: [1] },
      { type: "thinking", text: "thought" }], [])).toEqual([
      { kind: "notification", id: "notification:n", version: 1, notificationId: "n", entryId: "e", text: "notice", runIds: [], timestamp: "" },
      { kind: "thinking", id: "history-1", text: "thought", streaming: false },
    ]);
  });

  it("preserves legacy role fallback and IDs after filtering malformed messages", () => {
    expect(projectLegacyHistory(null)).toEqual([]);
    expect(projectLegacyHistory([null, { role: "user", text: "hi", sourceId: "source" },
      { role: "system", text: "legacy" }, { role: "assistant", text: 1 }])).toEqual([
      { kind: "message", id: "history-message:source", role: "user", text: "hi", streaming: false, images: [] },
      { kind: "message", id: "hist-1", role: "assistant", text: "legacy", streaming: false },
    ]);
  });
});
