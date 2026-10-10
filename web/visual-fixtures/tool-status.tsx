// Isolated presentation fixture: real production component, no API/model calls.
import { createRoot } from "react-dom/client";
import { ToolCallCard } from "../src/components/ToolCallCard.js";
import "../src/styles/globals.css";
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "light";
createRoot(document.getElementById("root")!).render(<main style={{ padding: 24, maxWidth: 720, margin: "auto" }}>
  <button id="start">Keyboard start</button>
  {[{ id: "success", done: true, isError: false }, { id: "error", done: true, isError: true }, { id: "unfinished", done: false, isError: false }].map(({ id, done, isError }) =>
    <ToolCallCard key={id} call={{ toolCallId: id, toolName: "subagent_wait", args: { runIds: ["fixture-child"] }, done, isError, partialResult: "waiting for child", result: isError ? "Wait aborted: fixture error" : "child status: waiting; tool returned" }} />)}
</main>);
