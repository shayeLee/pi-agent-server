// Test-only rich-content fixture. Vite serves it in dev; production build has only index.html.
import { createRoot } from "react-dom/client";
import type { TimelineItem } from "pi-agent-server/client";
import { MessageItem } from "../src/components/MessageItem.js";
import { ToolCallCard } from "../src/components/ToolCallCard.js";
import { EventLog } from "../src/components/EventLog.js";
import "../src/styles.css";
import "./rich.css";

const theme = new URLSearchParams(location.search).get("theme");
document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";

const longPath = "/workspace/packages/application/src/very-long-directory-name/another-long-directory-name/repositories/deeply-nested-file.ts";
const items: TimelineItem[] = [
  { kind: "message", id: "user-fixture", role: "user", text: "分析这个项目中的错误，并给出修改建议。", streaming: false },
  { kind: "thinking", id: "thinking-fixture", text: "先定位调用链，再检查错误边界与重试策略。\n需要比较预期与实际状态，并保留可复现的证据。", streaming: false },
  { kind: "tool", id: "tool-running", call: { toolCallId: "tool-running", toolName: "read", args: { path: longPath }, partialResult: { progress: "读取中", path: longPath }, result: undefined, isError: false, done: false } },
  { kind: "tool", id: "tool-done", call: { toolCallId: "tool-done", toolName: "bash", args: { command: "rg -n 'handleRequest' src && volta run pnpm test", cwd: "/workspace/packages/application" }, partialResult: undefined, result: { exitCode: 0, files: [longPath], output: "111 tests passed\n".repeat(12) }, isError: false, done: true } },
  { kind: "tool", id: "tool-error", call: { toolCallId: "tool-error", toolName: "bash", args: { command: "volta run pnpm typecheck" }, partialResult: undefined, result: { exitCode: 1, stderr: `Cannot resolve ${longPath}\n`.repeat(8) }, isError: true, done: true } },
  { kind: "message", id: "assistant-fixture", role: "assistant", streaming: false, text: "已定位问题。下面是修改建议：\n\n```typescript\nexport async function handleRequest(input: string) {\n  const source = await readSource(input);\n  return source.length > 0 ? source : null; // explicit fallback\n}\n```\n\n长路径：`" + longPath + "`。请先运行测试，再检查错误边界。" },
  { kind: "thinking", id: "thinking-stream", text: "继续检查长日志与流式状态", streaming: true },
];
const events = [
  { seq: 1, type: "thinking_delta", time: "12:34:56", data: { text: "先定位调用链" } },
  { seq: 2, type: "tool_start", time: "12:34:57", data: { toolCallId: "tool-done", args: { path: longPath } } },
  { seq: 3, type: "tool_end", time: "12:34:58", data: { toolCallId: "tool-error", isError: true, stderr: `Cannot resolve ${longPath}\n`.repeat(8) } },
  { seq: 4, type: "completed", time: "12:34:59", data: { durationMs: 3100, totalTokens: 408 } },
];

createRoot(document.getElementById("root")!).render(
  <main className="fixture-shell">
    <section className="fixture-conversation" aria-label="富内容对话视觉测试">
      <header className="fixture-title">Workbench Neo · 富内容视觉测试</header>
      <div className="fixture-timeline timeline">
        {items.map((item) => item.kind === "tool" ? <ToolCallCard key={item.id} call={item.call} /> : <MessageItem key={item.id} item={item} />)}
      </div>
    </section>
    <section className="fixture-inspector" aria-label="事件日志视觉测试">
      <EventLog entries={events} onClear={() => {}} />
    </section>
  </main>,
);
