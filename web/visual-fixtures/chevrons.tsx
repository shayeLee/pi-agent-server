// Presentation only: no API/model calls.
import { createRoot } from "react-dom/client";
import { ThinkingRow } from "../src/components/ThinkingRow.js";
import { ToolCallCard } from "../src/components/ToolCallCard.js";
import { ProjectSwitcher } from "../src/components/ProjectSwitcher.js";
import { ModelThinkingPicker } from "../src/components/ModelThinkingPicker.js";
import { SelectMenu } from "../src/components/SelectMenu.js";
import { EventLog } from "../src/components/EventLog.js";
import { SessionList } from "../src/components/SessionList.js";
import "../src/styles.css";
const noop = () => {};
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "light";
const model = { provider: "fixture", id: "complete-model-id-with-long-name-".repeat(3), name: "Fixture" };
createRoot(document.getElementById("root")!).render(<main style={{ padding: 24, maxWidth: 720, margin: "auto", overflow: "auto", height: "100vh" }}>
  <button id="start">Keyboard start</button>
  <div className="sidebar" style={{ width: "100%", height: "auto" }}>
    <ProjectSwitcher projects={[{ id: "p", name: "项目", cwd: "/fixture", isDefault: true }]} activeId="p" onSelect={noop} onCreate={noop} onDelete={noop} />
    <SessionList sessions={[{ id: "s", title: "会话", updatedAt: 1 } as Parameters<typeof SessionList>[0]["sessions"][number]]} activeId="s" onSelect={noop} onDelete={noop} onRename={noop} onExport={noop} />
  </div>
  <ThinkingRow thinking={{ kind: "thinking", id: "alignment", text: new URLSearchParams(location.search).get("thinking") ?? "完整思考内容", streaming: false }} />
  <ToolCallCard call={{ toolCallId: "alignment", toolName: "bash", args: { command: "echo fixture" }, done: true, isError: false, partialResult: undefined, result: "fixture result" }} />
  <ModelThinkingPicker models={[model]} defaultModel={model} defaultThinkingLevel="medium" thinkingLevels={["off", "medium"]} modelProvider={null} modelId={null} thinkingLevel={null} onConfigChange={noop} />
  <SelectMenu options={[{ value: "a", label: "普通菜单" }]} value="a" ariaLabel="普通菜单" onChange={noop} />
  <EventLog entries={[{ seq: 1, type: "tool_end", time: "12:00", data: { fixture: true } }]} onClear={noop} />
</main>);
