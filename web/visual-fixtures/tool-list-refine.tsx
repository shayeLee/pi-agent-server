// Presentation only: no API or model connection.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Inspector } from "../src/components/Inspector.js";
import { ToolCallCard } from "../src/components/ToolCallCard.js";
import type { ToolCall } from "pi-agent-server/client";
import "../src/styles.css";
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "dark";
const calls: ToolCall[] = [
  {toolCallId: "wait", toolName: "subagent_wait", args: {runIds: [1]}, result: "1/1 background subagent(s) finished. · worker reviewed the complete tool list and long summary layout", done: true, isError: false},
  {toolCallId: "bash", toolName: "bash", args: {command: "pnpm --filter web test -- tool-summary ToolCallCard"}, result: "Tests passed", done: true, isError: false},
  {toolCallId: "read", toolName: "read", args: {path: "web/src/components/Inspector.tsx"}, done: false, isError: false},
  {toolCallId: "edit", toolName: "edit", args: {path: "web/src/styles.css", oldText: "a { color: red; }", newText: "a { color: blue; }"}, done: true, isError: true},
  {toolCallId: "long", toolName: "custom_" + "extremely_long_tool_name_".repeat(6), args: {query: "Long summary that yields space to the complete tool name"}, done: true, isError: false},
].map(call => ({ partialResult: undefined, result: undefined, ...call }));
function Fixture() {
 const [open, setOpen] = useState(false);
 return <main style={{padding: 24, maxWidth: 1000, margin: "auto"}}>
  <button onClick={() => setOpen(true)}>打开 Inspector</button>
  <section style={{marginTop: 24}}>{calls.map(call => <ToolCallCard key={call.toolCallId} call={call} />)}</section>
  {open && <div className="app-shell"><Inspector session={null} entries={[]} timeline={calls.map(call => ({kind: "tool" as const, id: call.toolCallId, call}))} onClearEvents={() => {}} onClose={() => setOpen(false)} /></div>}
 </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
