import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThinkingRow } from "../src/components/ThinkingRow.js";
import { ToolCallCard } from "../src/components/ToolCallCard.js";
import "../src/styles/globals.css";
import "./diff-thinking-cleanup.css";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
export const args = { path: "/Users/mz/pi-default-project/福州佳云网络科技有限公司-企业简介总结.md", edits: [
  { oldText: "> 用途：企业简介/招商/对外宣传参考文档", newText: "> 用途：企业简介/招商/对外宣传参考文档\n> [EDIT-TEST] 这是一行临时测试标记" },
  { oldText: "keep\nold\n", newText: "keep\nnew\n" },
  { oldText: "", newText: "insert\n" }, { oldText: "delete\n", newText: "" }, { oldText: "", newText: "" },
] };
export const huge = " \r\n" + "x".repeat(100_001);
export const fullThinking = " \n".repeat(40) + "检查调用链\t保留完整原文\n下一步验证";
function Fixture() {
  const [text, setText] = useState(" \n\t");
  const [streaming, setStreaming] = useState(true);
  return <main className="fixture-shell"><section className="fixture-conversation"><header className="fixture-title">Diff / thinking · 隔离展示验证</header>
    <button onClick={() => setText(fullThinking)}>真实思考到达</button><button onClick={() => setStreaming(false)}>结束思考</button>
    <div className="fixture-timeline timeline">
      <ThinkingRow thinking={{ kind: "thinking", id: "historical-empty", text: "\n \t", streaming: false }} />
      <ThinkingRow thinking={{ kind: "thinking", id: "late", text, streaming }} />
      <ToolCallCard call={{ toolCallId: "edit", toolName: "edit", args, done: false, isError: false, partialResult: undefined, result: undefined }} />
      <ToolCallCard call={{ toolCallId: "result", toolName: "edit", args: { path: "result.ts", oldText: "old\n", newText: "new\n" }, done: true, isError: true, partialResult: undefined, result: "真实错误结果：replacement failed; 原文保留" }} />
      <ToolCallCard call={{ toolCallId: "large", toolName: "edit", args: { path: "huge.ts", oldText: huge, newText: "\tnew\r\n\n" }, done: true, isError: false, partialResult: undefined, result: "完整大片段结果" }} />
    </div></section></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
