// Isolated presentation fixture: no API, writes, or command execution.
import { createRoot } from "react-dom/client";
import { ToolCallCard } from "../src/components/ToolCallCard.js";
import "../src/styles.css";
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
export const command = 'printf "%s\\n" "' + "long command preview ".repeat(25) + '"';
export const content = 'def greet(name):\n    # literal **Markdown**\n    print("Hello", name)\n\n\ngreet("world")\n';
export const editOld = 'def greet(name):\n    print("old", name)\nlast';
export const editNew = 'def greet(name):\n    print("new", name)\nlast\n';
export const edits = [{ oldText: 'const n: number = 0;\n', newText: 'const n: number = 1;\n' }, { oldText: '', newText: '  <img onerror="window.__executed=1">\n' }, { oldText: 'removed\n', newText: '' }, { oldText: '', newText: '' }];
createRoot(document.getElementById("root")!).render(<main style={{ maxWidth: 808, margin: "0 auto", padding: 16 }}>
  <ToolCallCard call={{ toolCallId: "bash", toolName: "bash", args: { command }, done: true, result: "literal stdout", isError: false }} />
  <ToolCallCard call={{ toolCallId: "write", toolName: "write", args: { path: "/tmp/example.py", content }, done: true, result: "Successfully wrote to /tmp/example.py", isError: false }} />
  <ToolCallCard call={{ toolCallId: "edit-single", toolName: "edit", args: { path: "/tmp/example.py", oldText: editOld, newText: editNew, flag: false, count: 0 }, done: true, result: "Successfully replaced 1 block(s) in /tmp/example.py.", isError: false }} />
  <ToolCallCard call={{ toolCallId: "edit-batch", toolName: "edit", args: { path: "/tmp/example.ts", edits }, done: true, result: "Successfully replaced 4 block(s) in /tmp/example.ts.", isError: false }} />
  <ToolCallCard call={{ toolCallId: "edit-plain", toolName: "edit", args: { path: "/tmp/example.unknown", oldText: "**literal**\n", newText: "  plain\n" }, done: false, isError: false }} />
  {[undefined, null, {}, []].map((args, i) => <ToolCallCard key={i} call={{ toolCallId: `empty-${i}`, toolName: "empty", args, done: false, isError: false }} />)}
  <button type="button">Other button</button>
</main>);
