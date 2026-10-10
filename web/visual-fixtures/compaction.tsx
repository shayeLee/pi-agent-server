// Isolated props only: never mount App/controller or connect to an API.
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "../src/components/Chat.js";
import type { CompactionState } from "../src/components/CompactionBanner.js";
import "../src/styles.css";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "light";
function Fixture() {
  const [status, setStatus] = useState<CompactionState["status"] | "hidden">("running");
  const [connected, setConnected] = useState(true);
  // Match the reducer: unrelated renders preserve compaction state identity.
  const compaction = useMemo<CompactionState | null>(() => status === "hidden" ? null : {
    status, reason: "threshold", tokensBefore: 123456789012345,
    ...(status === "succeeded" ? { tokensAfter: 1234567890123 } : {}),
  }, [status]);
  return <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <div style={{ padding: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
      <label>模拟状态 <select aria-label="模拟状态" value={status} onChange={e => setStatus(e.target.value as typeof status)}>
        {["running", "succeeded", "failed", "aborted", "unknown", "hidden"].map(value => <option key={value}>{value}</option>)}
      </select></label>
      <label><input type="checkbox" checked={connected} onChange={e => setConnected(e.target.checked)} />模拟连接</label>
      <span>隔离 mock · 不发送消息</span>
    </div>
    <Chat session={null} projects={[]} activeProjectId={null} onSelectProject={() => {}} canCreateSession={false} canWrite={false}
      timeline={[]} streaming={false} queued={false} loadError={null} models={[]} thinkingLevels={[]} defaultModel={null} defaultThinkingLevel="off"
      connected={connected} stats={null} compaction={compaction}
      onSend={() => {}} onSteer={() => {}} onFollowUp={() => {}} onAbort={() => {}} onToggleDetails={() => {}} onConfigChange={() => {}} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
