// Presentation-only: no API requests or command execution.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ToolCallCard } from "../src/components/ToolCallCard.js";
import { Markdown } from "../src/components/Markdown.js";
import "../src/styles.css";
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
export const partial = "### stdout, not Markdown\n`literal` and ``` fences\n  aligned   spaces\n";
export const final = partial + '"nested quotes": \\"quoted\\"\n<script>window.__executed=true</script>\n末尾\n';
export const args = { command: 'printf "%s\\n" "quoted"', nested: [false, 0, null, { text: final }] };
function Fixture() {
  const [done, setDone] = useState(false);
  return <main data-theme={theme} style={{ maxWidth: 808, margin: "0 auto", padding: 16 }}>
    <button onClick={() => setDone(true)}>完成快照</button>
    <ToolCallCard call={{ toolCallId: "unified", toolName: "bash", args, partialResult: partial, result: final, done, isError: false }} />
    <Markdown text={'```python\nprint("fenced Markdown still shares CodeBlock")\n```'} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
