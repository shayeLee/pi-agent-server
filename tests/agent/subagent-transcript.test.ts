import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TranscriptJournal } from "../../integrations/agent-team/transcript.js";
import { projectSubagents } from "../../src/agent/subagent-transcript.js";
import { PiJsonlConversationStorage } from "../../src/agent/pi-jsonl-conversation-storage.js";
import { DEFAULT_PROJECT_ID } from "../../src/shared/project-identity.js";

describe("subagent transcript durability", () => {
  it("saves initial/steer/assistant/tool messages before wait; reloads through production storage without adding parent model context", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "child-transcript-"));
    try {
      const manager = SessionManager.create(root, path.join(root, "sessions", "parent"));
      manager.appendMessage({ role: "user", content: "parent prompt", timestamp: 1 });
      const journal = new TranscriptJournal((type, data) => manager.appendCustomEntry(type, data), () => {});
      journal.start({ id: "1", agent: "worker", task: "初始任务", startedAt: 1, thinkingLevel: "high" });
      const message = (m: any) => { journal.event("1", { type: "message_start", message: m }); journal.event("1", { type: "message_end", message: m }); };
      message({ role: "user", content: [{ type: "text", text: "Task: 初始任务" }] });
      const steer = "完整 steer\n引号 \" $ ` Unicode 中文";
      journal.steer("1", steer)(true);
      message({ role: "user", content: steer });
      const output = "完整结果".repeat(15000);
      message({ role: "assistant", content: [{ type: "thinking", thinking: "检查" }, { type: "text", text: "正在执行" },
        { type: "toolCall", id: "call", name: "bash", arguments: { command: "echo full" } }] });
      journal.event("1", { type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: { command: "echo full" } });
      journal.event("1", { type: "tool_execution_end", toolCallId: "call", toolName: "bash", result: { content: [{ type: "text", text: output }], details: { full: true } } });
      message({ role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: output }], details: { full: true } });
      message({ role: "assistant", content: [{ type: "text", text: "已完成" }] });
      journal.event("1", { type: "thinking_level_changed", level: "xhigh" });
      journal.finish("1", "completed", { endedAt: 100 });
      const id = projectSubagents("parent", manager.getBranch()).runs[0]!.id;
      expect(manager.buildSessionContext().messages).toHaveLength(1);
      const file = manager.getSessionFile()!;
      expect(readFileSync(file, "utf8")).toContain(output);
      // New storage instance = no live registry, journal or SDK session involved.
      const snapshot = await new PiJsonlConversationStorage(root).readSubagents({ agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: file }, { sessionId: "parent", projectId: DEFAULT_PROJECT_ID }, id);
      const c = snapshot.conversation!;
      expect(c.run.status).toBe("completed");
      expect(c.run.thinkingLevel).toBe("xhigh");
      expect(c.messages).toHaveLength(5);
      expect(c.inputs.map(i => i.delivery)).toEqual(["delivered", "delivered"]);
      expect(c.timeline.filter(i => i.kind === "message").map(i => i.text)).toEqual(["Task: 初始任务", steer, "正在执行", "已完成"]);
      const calls = c.timeline.filter(i => i.kind === "tool");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.call.args).toEqual({ command: "echo full" });
      expect(calls[0]!.call.result).toMatchObject({ content: [{ text: output }], details: { full: true } });
      const restarted = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
        import { PiJsonlConversationStorage } from './src/agent/pi-jsonl-conversation-storage.ts';
        const [root, file, id, projectId] = process.argv.slice(1);
        console.log(JSON.stringify(await new PiJsonlConversationStorage(root).readSubagents(
          { agentKind: 'pi', conversationFormat: 'pi-jsonl-v3', conversationRef: file }, { sessionId: 'parent', projectId }, id)));
      `, root, file, id, DEFAULT_PROJECT_ID], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }));
      expect(restarted.conversation).toEqual(c);

    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps duplicate steer attempts distinct, failures undelivered, live partials transient, and restart status unknown", () => {
    const entries: any[] = [];
    const partials = new Map();
    const journal = new TranscriptJournal((customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }), (type, data: any) => {
      if (type.endsWith("-live")) partials.set(data.id, structuredClone(data));
    });
    journal.start({ id: "1", agent: "worker", task: "task", startedAt: 1 });
    journal.event("1", { type: "message_end", message: { role: "user", content: "Task: task" } });
    journal.steer("1", "same")(false);
    journal.steer("1", "same")(true);
    journal.steer("1", "same")(true);
    journal.event("1", { type: "message_end", message: { role: "user", content: "same" } });
    journal.event("1", { type: "message_start", message: { role: "assistant", content: [] } });
    journal.event("1", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } });
    const id = entries[0].data.id;
    expect(JSON.stringify(entries)).not.toContain("partial");
    const live = projectSubagents("s", entries, { active: new Set([id]), partials }, id).conversation!;
    expect(live.timeline.at(-1)).toMatchObject({ text: "partial", streaming: true });
    expect(live.inputs.map(i => i.delivery)).toEqual(["delivered", "failed", "delivered", "submitted"]);
    const cold = projectSubagents("s", entries, undefined, id).conversation!;
    expect(cold.run.status).toBe("unknown");
    expect(cold.inputs.at(-1)?.delivery).toBe("unknown");
    journal.finish("1", "stopped", { endedAt: 5 });
    const stopped = projectSubagents("s", entries, undefined, id).conversation!;
    expect(stopped.timeline.at(-1)).toMatchObject({ text: "partial", streaming: false });
    expect(stopped.run.status).toBe("stopped");
    journal.start({ id: "1", agent: "worker", task: "new task", startedAt: 10 });
    expect(projectSubagents("s", entries).runs.map(r => r.id)).toEqual([id, expect.not.stringMatching(id)]);
  });

  it("recovers legacy collected logs once and never attributes an earlier user message to a later steer", () => {
    const result = { runId: "1", agent: "worker", task: "legacy", startedAt: 1, endedAt: 2, exitCode: 0,
      messages: [{ role: "user", content: "legacy" }, { role: "assistant", content: [{ type: "text", text: "saved reply" }] }] };
    const legacy = ["subagent", "subagent_wait"].map((toolName, id) => ({ type: "message", id: String(id), message: { role: "toolResult", toolName, details: { results: [result] } } }));
    const snapshot = projectSubagents("s", legacy);
    expect(snapshot.runs).toHaveLength(1);
    expect(projectSubagents("s", legacy, undefined, snapshot.runs[0]!.id).conversation).toMatchObject({ run: { legacy: true, status: "completed" }, messages: result.messages });
    const entries: unknown[] = [];
    const journal = new TranscriptJournal((customType, data) => entries.push({ type: "custom", customType, data }), () => {});
    journal.start({ id: "1", agent: "worker", task: "task", startedAt: 1 });
    journal.event("1", { type: "message_end", message: { role: "user", content: "task" } });
    journal.event("1", { type: "message_end", message: { role: "user", content: "same" } });
    journal.steer("1", "same")(true);
    const id = projectSubagents("s", entries).runs[0]!.id;
    const c = projectSubagents("s", entries, undefined, id).conversation!;
    expect(c.timeline[1]).toMatchObject({ sourceLabel: "用户消息" });
    expect(c.inputs[1]?.delivery).toBe("unknown");
  });

  it("does not publish unsaved entries on a write failure", () => {
    const published: unknown[] = [];
    const journal = new TranscriptJournal(() => { throw new Error("disk full"); }, (_, data) => published.push(data));
    expect(() => journal.start({ id: "1", agent: "worker", task: "task", startedAt: 1 })).toThrow("disk full");
    expect(published).toEqual([]);
  });
});
