import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ToolCallCard } from "../src/components/ToolCallCard.js";
import { Markdown } from "../src/components/Markdown.js";
import "../src/styles/globals.css";

export const html = '<!doctype html>\n<html lang="zh-CN">\n  <head><meta charset="UTF-8" /><title>工业视觉智能检测数据大屏</title></head>\n  <body><div title="' + 'long-line-'.repeat(24) + '">内容</div><script>window.__executed = true</script><img src=x onerror="window.__executed=true"></body>\n</html>\n\n';
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
function Fixture() {
  const [text, setText] = useState('<!doctype html>\n<html lang="zh-CN">\n');
  return <main style={{ maxWidth: 900, margin: "0 auto", padding: 16, minWidth: 0 }}>
    <h2>CodeBlock · 隔离代码视觉验证</h2>
    <button onClick={() => setText(html)}>更新工具快照</button>
    <ToolCallCard call={{ toolCallId: "code-read", toolName: "read", args: { path: "/fixture/index.html" }, partialResult: { content: [{ type: "text", text }] }, result: undefined, done: false, isError: false }} />
    <Markdown text={'行内 `const inline = 1` 保留。\n\n```ts\nconst greeting: string = "你好";\n\n```\n\n```json\n{"ok": true, "count": 12}\n```\n\n```unknown\n日志 const true 这是自然语言\n```'} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
