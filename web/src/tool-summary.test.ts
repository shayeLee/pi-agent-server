import { describe, expect, it } from "vitest";
import type { ToolCall } from "pi-agent-server/client";
import { toolSummary, subagentTasks } from "./tool-summary.js";
const call = (toolName: string, args: unknown, extra: Partial<ToolCall> = {}): ToolCall => ({ toolCallId: "s", toolName, args, result: undefined, partialResult: undefined, done: false, isError: false, ...extra });
const result = (text: string) => ({ content: [{ type: "text", text }] });
describe("toolSummary actual snapshots only", () => {
  it("preserves every parallel agent/task for CSS-only truncation; startup is not child completion", () => {
    const tasks = [{ agent: "scout", task: "inspect" }, { agent: "worker", task: "x".repeat(300), cwd: "/tmp" }];
    const summary = toolSummary(call("subagent", { tasks }, { done: true, result: { ...result("Background subagents started (runIds: r1, r2)."), details: { liveRunIds: ["r1", "r2"], results: [] } } }));
    expect(summary).toContain("scout、worker · inspect · ");
    expect(summary).not.toContain("\n");
    expect(summary).toContain("x".repeat(300));
    expect(summary).not.toContain("…");
    expect(summary).not.toMatch(/completed|finished/);
    expect(tasks[1].task).toHaveLength(300);
    expect(toolSummary(call("subagent", { agent: "worker", task: "single" }))).toBe("worker: single");
  });
  it("only recognizes nonempty valid arrays and preserves complete duplicate/long names", () => {
    const name = "worker-".repeat(40);
    const tasks = [{ agent: "lite", task: "x".repeat(500) }, { agent: "lite", task: "second" }, { agent: name, task: "third" }];
    expect(toolSummary(call("subagent", { tasks }))).toMatch(new RegExp(`^lite、lite、${name}`));
    expect(subagentTasks("subagent", { tasks })).toBe(tasks);
    for (const tasks of [[], null, "invalid", [null, {}], [{ agent: "lite", task: 3 }]]) {
      expect(subagentTasks("subagent", { tasks })).toBeUndefined();
      expect(() => toolSummary(call("subagent", { tasks }))).not.toThrow();
    }
    expect(subagentTasks("unknown", { tasks })).toBeUndefined();
  });
  it("wait targets plus latest real count, elapsed and agent words, not stale partial", () => {
    const c = call("subagent_wait", { runIds: ["r1", "r2"] }, { partialResult: result("0/2 settled after 1s\nworker: reading") });
    expect(toolSummary(c)).toBe('runIds=["r1","r2"] · 0/2 settled after 1s · worker: reading');
    expect(toolSummary(c)).not.toContain("\n");
    expect(toolSummary({ ...c, partialResult: result("1/2 settled after 2s\nworker: testing") })).not.toContain("reading");
    expect(toolSummary(call("subagent_wait", {}))).toBe("全部待收集 runs");
    expect(toolSummary({ ...c, done: true, result: result("Waited 1s: 0/2 finished, 2 still running.") })).toContain("still running");
    expect(toolSummary({ ...c, done: true, result: { ...result("2/2 background subagent(s) finished.\n### [worker] run r1 — failed"), details: { results: [{ exitCode: 1 }] } } })).toContain("failed");
  });
  it.each([
    ["subagent_status", { runId: "r1" }, "run: r1"],
    ["subagent_status", {}, "全部 runs"],
    ["subagent_logs", { runId: "r1", tail: 0 }, "run: r1 · tail: 0"],
    ["subagent_steer", { runId: "r1", message: "change plan" }, "run: r1 · message: change plan"],
    ["subagent_stop", { runId: "r1" }, "run: r1"],
  ])("%s uses args and first true confirmation, no invented updates", (name, args, expected) => {
    expect(toolSummary(call(name, args, { result: result("\nactual confirmation\nsecond line"), done: true }))).toBe(`${expected} · actual confirmation`);
  });
  it("bash only latest nonempty tail; final false/0/empty wins", () => {
    const c = call("bash", { command: "echo hi" }, { partialResult: result("first\nsecond\n\n") });
    expect(toolSummary(c)).toBe("echo hi · second");
    expect(toolSummary(c)).not.toContain("\n");
    expect(toolSummary({ ...c, result: false })).toBe("echo hi · false");
    expect(toolSummary({ ...c, result: 0 })).toBe("echo hi · 0");
    expect(toolSummary({ ...c, result: "" })).toBe("echo hi");
    expect(toolSummary({ ...c, done: true })).toBe("echo hi");
  });
  it("paths, edit batches, primitive args and unknown safe fields", () => {
    for (const name of ["read", "write"]) expect(toolSummary(call(name, { path: "a.ts" }))).toBe("a.ts");
    expect(toolSummary(call("edit", { path: "a.ts", edits: [{}, {}] }))).toBe("a.ts · 2 项修改");
    expect(toolSummary(call("unknown", { flag: false, zero: 0, nested: { unsafe: "<script>" } }))).toContain('flag: false · zero: 0 · nested: {"unsafe":"<script>"}');
    expect(toolSummary(call("unknown", false))).toBe("false");
  });
});
