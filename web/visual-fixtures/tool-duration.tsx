// Offline presentation fixture; values are synthetic test inputs, not measured executions.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { ToolCall } from "pi-agent-server/client";
import { ToolCallCard } from "../src/components/ToolCallCard.js";
import "../src/styles.css";
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "light";
const base: ToolCall = { toolCallId: "", toolName: "bash", args: { command: "printf 'offline duration fixture with a long summary that must yield before the tool name'" }, partialResult: "waiting for fixture update", result: "fixture output", isError: false, done: true };
const calls: ToolCall[] = [
  { ...base, toolCallId: "zero", durationMs: 0 },
  { ...base, toolCallId: "fast", toolName: "read", args: { path: "/fixture/long/path/to/source-file.ts" }, durationMs: 0.123456789 },
  { ...base, toolCallId: "seconds", durationMs: 1234.56789 },
  { ...base, toolCallId: "wait", toolName: "subagent_wait", args: { runIds: ["fixture-child"] }, result: "Wait returned; child is still running.", durationMs: 61500 },
  { ...base, toolCallId: "long", toolName: "custom_" + "extremely_long_tool_name_".repeat(4), durationMs: 3600000, isError: true, result: "Fixture error: permission denied.\nFull error details remain readable." },
  { ...base, toolCallId: "old", toolName: "legacy_tool", args: {}, result: "Old history without duration" },
  { ...base, toolCallId: "null", toolName: "unknown_duration", durationMs: null },
  { ...base, toolCallId: "parallel", toolName: "subagent", args: { tasks: [{ agent: "reviewer", task: "Review this fixture only" }, { agent: "designer", task: "Inspect the compact header" }] }, durationMs: 1000 },
];
function Fixture() {
  const [done, setDone] = useState(false);
  return <main style={{ maxWidth: 760, margin: "auto", padding: 16 }}>
    <p>离线 UI fixture · 合成测试值</p>
    <button onClick={() => setDone(true)}>完成 fixture 调用</button>
    <section style={{ display: "grid", gap: 8, marginTop: 16 }}>
      <ToolCallCard call={{ ...base, toolCallId: "live", toolName: "subagent_wait", args: { runIds: ["fixture-child"] }, done, durationMs: done ? 2345.6789 : undefined }} />
      {calls.map(call => <ToolCallCard key={call.toolCallId} call={call} />)}
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
