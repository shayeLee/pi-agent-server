import { zhCN } from "../i18n/zh-CN.js";
import { useEffect } from "react";
import { formatElapsed, type RunStatus } from "../hooks/useRunStatus.js";
import { formatSpan } from "../i18n/format.js";

/** Plain status words, used both for display and for the polite live region. */
export function runStatusWord(status: RunStatus): string {
  switch (status.kind) {
    case "submitting": return zhCN.status.submitting;
    case "queued": return zhCN.status.queued;
    case "running": return zhCN.run.running;
    case "completed": return zhCN.status.completed;
    case "aborted": return zhCN.status.aborted;
    case "failed": return zhCN.run.failed;
    default: return "";
  }
}

type Glyph = Exclude<RunStatus["kind"], "idle"> | "armed";

/**
 * One family of 16px line glyphs: the same ring, with the state drawn inside it, so the
 * header reads at a glance and the colour (from tokens via currentColor) carries the tone.
 */
export function RunStatusIcon({ glyph }: { glyph: Glyph }) {
  return <svg className="run-icon" data-glyph={glyph} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {/* Waiting for the server: the ring is not yet closed. */}
    {glyph === "submitting" ? <circle cx="8" cy="8" r="6.25" strokeDasharray="2.4 2.5" />
      : <circle cx="8" cy="8" r="6.25" />}
    {glyph === "queued" && <path d="M8 4.9V8l2.1 1.4" />}
    {glyph === "running" && <circle className="run-icon-core" cx="8" cy="8" r="2.6" fill="currentColor" stroke="none" />}
    {glyph === "completed" && <path d="m5.3 8.2 1.9 1.9 3.6-3.8" />}
    {(glyph === "aborted" || glyph === "armed") && <rect x="5.6" y="5.6" width="4.8" height="4.8" fill="currentColor" stroke="none" />}
    {glyph === "failed" && <path d="m5.9 5.9 4.2 4.2m0-4.2-4.2 4.2" />}
  </svg>;
}

/**
 * Header run state (DESIGN.md §5.2, §5.4): a glyph, the state word, and the elapsed or final
 * time. The ticking timer is visual only; screen readers hear state changes through a separate
 * polite region, never every second.
 */
export function RunStatusBadge({ status, abortArmed = false }: { status: RunStatus; abortArmed?: boolean }) {
  const word = runStatusWord(status);
  const detail = status.kind === "running" && status.startedAt !== null ? formatElapsed(Date.now() - status.startedAt)
    : "durationMs" in status && status.durationMs !== null ? formatSpan(status.durationMs) : null;
  const announce = abortArmed ? zhCN.run.pressEscAgain : word;

  useEffect(() => {
    const running = status.kind === "running" || status.kind === "submitting" || status.kind === "queued";
    const base = document.title.replace(/^▶ /, "");
    document.title = running ? `▶ ${base}` : base;
  }, [status.kind]);
  useEffect(() => () => { document.title = document.title.replace(/^▶ /, ""); }, []);

  const glyph: Glyph | null = abortArmed ? "armed" : status.kind === "idle" ? null : status.kind;
  return <>
    {glyph && <span className={`run-status run-${glyph}`} data-testid="run-status" aria-hidden="true">
      <RunStatusIcon glyph={glyph} />
      <span className="run-word">{abortArmed ? zhCN.run.pressEscAgain : word}</span>
      {!abortArmed && detail && <span className="run-detail">{detail}</span>}
    </span>}
    <span className="sr-only" role="status" aria-live="polite">{announce}</span>
  </>;
}
