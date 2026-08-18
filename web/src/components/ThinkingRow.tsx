import { useState } from "react";
import type { TimelineItem } from "../types.js";

export type ThinkingRowProps = {
  thinking: Extract<TimelineItem, { kind: "thinking" }>;
};

export function ThinkingRow({ thinking }: ThinkingRowProps) {
  const [expanded, setExpanded] = useState(false);
  const summary = thinking.text.slice(0, 60).replace(/\n/g, " ");

  return (
    <div
      className={`message-row thinking-row ${thinking.streaming ? "streaming" : ""}`}
      data-expanded={expanded}
      data-testid={`thinking-${thinking.id}`}
    >
      <button
        type="button"
        className="thinking-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="thinking-chevron">▶</span>
        <span className="thinking-label">Think</span>
        {!expanded && <span className="thinking-summary">{summary || "思考中…"}</span>}
      </button>
      {expanded && (
        <div className="thinking-body" data-testid={`thinking-body-${thinking.id}`}>
          {thinking.text}
          {thinking.streaming && <span className="streaming-cursor">▍</span>}
        </div>
      )}
    </div>
  );
}
