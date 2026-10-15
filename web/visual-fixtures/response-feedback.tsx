// Local reducer/UI verification only; no API requests or model generation.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { addUserMessage, applySseEvent, createChatState, type SessionRecord } from "pi-agent-server/client";
import { Chat } from "../src/components/Chat.js";
import "../src/styles.css";

const session: SessionRecord = { id: "feedback-fixture", ownerKey: "fixture", projectId: "fixture", title: "回复反馈验收",
  createdAt: 1, updatedAt: 1, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null };
const start = (state = createChatState()) => applySseEvent(addUserMessage(state, "请解释这个问题", undefined, `r-${state.timeline.length}`),
  { type: "status", phase: "agent_start", requestId: `r-${state.timeline.length}` });
function Fixture() {
  const [state, setState] = useState(() => start());
  return <main style={{height:"100dvh", display:"flex", flexDirection:"column"}}>
    <div style={{padding:12, display:"flex", gap:12}}>
      <button onClick={() => setState(previous => applySseEvent(applySseEvent(previous,
        {type:"text_delta", text:"这是一段尚未完成的回复，", requestId:previous.activeRequestId ?? undefined}),
        {type:"aborted", requestId:previous.activeRequestId ?? undefined}))}>模拟半截回复中止</button>
      <button onClick={() => setState(previous => start(previous))}>开始下一轮等待</button>
    </div>
    <Chat session={session} projects={[]} activeProjectId="fixture" onSelectProject={() => {}} canCreateSession={false}
      timeline={state.timeline} streaming={state.phase === "streaming"} queued={false} loadError={null}
      models={[]} thinkingLevels={[]} defaultModel={null} defaultThinkingLevel="off" connection="open" stats={null}
      onSend={() => {}} onFollowUp={() => {}} onConfigChange={() => {}} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
