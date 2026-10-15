import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SubagentConversation, SubagentRun } from "pi-agent-server/client";
import { SubagentChat, SubagentList } from "./Subagents.js";

const run = (patch: Partial<SubagentRun>): SubagentRun => ({ id: "r", runId: "1", agent: "worker", task: "检查布局", startedAt: 0, endedAt: 10_000,
  status: "completed", revision: 1, ...patch });

describe("SubagentList", () => {
  it("puts the status glyph before the name and a compact duration last, so both columns line up", () => {
    render(<SubagentList runs={[run({ id: "a", endedAt: 10_000 }), run({ id: "b", runId: "2", endedAt: 136_000, status: "failed" })]}
      selected={null} onSelect={vi.fn()} loading={false} error={null} />);
    const headings = [...document.querySelectorAll(".subagent-list-heading")];
    for (const heading of headings) {
      expect(heading.firstElementChild).toHaveClass("subagent-glyph");
      expect(heading.lastElementChild).toHaveClass("subagent-duration");
    }
    expect(headings.map(heading => heading.querySelector(".subagent-duration")!.textContent)).toEqual(["10s", "2m16s"]);
    expect(screen.getByRole("img", { name: "失败" })).toHaveTextContent("✗");
  });

  it("shows no duration for a historical run whose end is unknown", () => {
    render(<SubagentList runs={[run({ status: "unknown", endedAt: undefined })]} selected={null} onSelect={vi.fn()} loading={false} error={null} />);
    expect(document.querySelector(".subagent-duration")).toBeEmptyDOMElement();
  });
});

describe("SubagentChat", () => {
  it("does not repeat the task in the strip: it is the conversation's first turn", () => {
    const conversation: SubagentConversation = { run: run({ task: "只读任务：检查布局" }), messages: [], inputs: [],
      timeline: [{ kind: "message", id: "u", role: "user", text: "只读任务：检查布局", streaming: false, hostInput: "initial", timestamp: "2026-10-15T02:38:07.000Z", sourceLabel: "主代理 · 初始任务 · 已送达" }] };
    render(<SubagentChat conversation={conversation} loading={false} error={null} title="主会话" inspectorOpen={false} onBack={vi.fn()} onToggleInspector={vi.fn()} />);
    expect(screen.getAllByText("只读任务：检查布局")).toHaveLength(1);
    expect(document.querySelector(".ledger-entry .ledger-tag")).toHaveTextContent("主代理");
    expect(document.querySelector(".ledger-entry .ledger-note")).toHaveTextContent("初始任务");
    // The host turn is timed like every other ledger row.
    expect(document.querySelector(".ledger-entry .ledger-time time")).toHaveAttribute("dateTime", "2026-10-15T02:38:07.000Z");
  });

  it("shows inputs not yet delivered as host rows with the delivery state in the gutter", () => {
    const conversation: SubagentConversation = { run: run({ status: "running", endedAt: undefined }), messages: [], timeline: [],
      inputs: [{ id: "i", text: "改为只检查侧栏", timestamp: Date.parse("2026-10-15T02:40:00.000Z"), kind: "steer", delivery: "submitted" }] };
    render(<SubagentChat conversation={conversation} loading={false} error={null} title="主会话" inspectorOpen={false} onBack={vi.fn()} onToggleInspector={vi.fn()} />);
    const row = screen.getByText("改为只检查侧栏").closest(".ledger-entry")!;
    expect(row.querySelector(".ledger-tag")).toHaveTextContent("主代理");
    // steer is shown as 引导, the control queue's word for the same act.
    expect([...row.querySelectorAll(".ledger-note")].map(note => note.textContent)).toEqual(["引导", "等待送达"]);
    expect(row.querySelector(".ledger-time time")).toHaveAttribute("dateTime", "2026-10-15T02:40:00.000Z");
  });
});
