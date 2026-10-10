// Mock prop transitions only: no controller, API, session or model connection.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageItem } from "../src/components/MessageItem.js";
import "../src/styles.css";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "light";
function Fixture() {
  const [streaming, setStreaming] = useState(true);
  return <main style={{ padding: 24, maxWidth: 760, margin: "auto" }}>
    <h1>流式光标 · 隔离 UI 验证</h1>
    <p>仅使用 mock props；取消按钮模拟 streaming → false，不调用真实取消链。</p>
    {[false, true].flatMap(live => ["", "已收到的助手文本。"].map((text, index) =>
      <section key={`${live}-${index}`} data-testid={`case-${live}-${index}`}>
        <h2>{text ? "非空" : "空"}助手 / streaming={String(live)}</h2>
        <MessageItem item={{ kind: "message", id: `matrix-${live}-${index}`, role: "assistant", text, streaming: live }} />
      </section>))}
    <section data-testid="cancel-region">
      <h2>取消状态切换：{streaming ? "进行中" : "已取消"}</h2>
      <button onClick={() => setStreaming(false)} disabled={!streaming}>模拟取消 / 放弃</button>
      <h3>空助手</h3>
      <MessageItem item={{ kind: "message", id: "cancel-empty", role: "assistant", text: "", streaming }} />
      <h3>非空助手</h3>
      <MessageItem item={{ kind: "message", id: "cancel-text", role: "assistant", text: "取消后保留这段文本。", streaming }} />
      <MessageItem item={{ kind: "thinking", id: "cancel-thinking", text: "检查流式状态与光标是否一致。", streaming }} />
      <MessageItem item={{ kind: "thinking", id: "cancel-empty-thinking", text: "", streaming }} />
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
