// Isolated presentation fixture; never contacts an API or runs these sample commands.
import { createRoot } from "react-dom/client";
import { ToolCallCard } from "../src/components/ToolCallCard.js";
import "../src/styles.css";
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
export const waitText = "2/2 background subagent(s) finished.\n\n### [worker] run 2 — completed\n\n已创建 `/Users/mz/pi-default-project/worker-smoke-test.txt`。\n\n使用的命令：文件写入工具（`write`），随后使用 `read` 读回确认。\n读回结果：`worker ok`\n\n---\n\n### [claude-worker] run 3 — completed\n\n### 1. [P1] 配置加载可执行任意代码\n- **定位**：`load_config()`，第 20 行：`eval(f.read())`。\n- **风险**：不可信配置可执行代码。\n- **建议**：使用安全的数据解析器。";
const cases = [
  { toolName: "bash", args: { command: 'stat -f "%N  modified=%Sm size=%z" review-sample.py worker-smoke-test.txt' }, result: 'review-sample.py  modified=Oct  6 08:50:02 2026 size=382\nworker-smoke-test.txt  modified=Oct  6 08:50:10 2026 size=10' },
  { toolName: "subagent", args: { tasks: [
    { agent: "worker", task: "在当前工作目录 /Users/mz/pi-default-project 下创建文件 worker-smoke-test.txt，内容为单行文本 `worker ok`。创建后用 read 读回确认内容，并报告你使用的命令与读回结果。" },
    { agent: "claude-worker", task: "请对文件 /Users/mz/pi-default-project/review-sample.py 做一次只读代码审查。找出其中的缺陷与安全问题，按严重程度排序，每条给出：问题定位（函数名/行号）、风险说明、修复建议。不要修改任何文件。" },
  ] }, result: "2 background subagent(s) started:\n  runId: 2 — worker\n  runId: 3 — claude-worker\n\nCall subagent_wait (with no arguments) to collect all of their results." },
  { toolName: "subagent_wait", args: {}, result: waitText },
];
createRoot(document.getElementById("root")!).render(<main data-theme={theme} style={{ maxWidth: 808, margin: "0 auto", padding: "24px", height: "100vh", overflow: "auto" }}>
  {cases.map((item, index) => <div key={index} style={{ marginBottom: 32 }}><ToolCallCard call={{ ...item, toolCallId: `reference-${index}`, done: true, isError: false, partialResult: undefined, result: { content: [{ type: "text", text: item.result }], details: { fixture: true } } }} /></div>)}
</main>);
