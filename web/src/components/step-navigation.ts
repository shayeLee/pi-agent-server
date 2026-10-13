import type { SessionStep } from '../../../src/shared/session-steps.js';

export type TraceNavigation = { sessionId: string; timelineId: string; sequence: number };

/** Prefer source identities; validate the complete visible sequence for live rows. */
export function stepTarget(step: SessionStep, steps: readonly SessionStep[] = []): HTMLElement | undefined {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-timeline-id]'));
  if (step.toolCallId && !step.parentToolCallId) return rows.find(row => row.dataset.toolCallId === step.toolCallId);
  if (step.kind === 'notification') {
    const content = step.content as { notificationId?: string } | null;
    return rows.find(row => row.dataset.timelineId === `notification:${content?.notificationId}`);
  }
  const direct = recordedTarget(step, rows);
  if (direct) return direct;
  // Live rows do not yet carry persisted entry IDs. Associate only when the full
  // visible sequence agrees, including every known historical and tool anchor.
  // Never match message text: repeated prompts must remain separate destinations.
  const visible = steps.filter(item => ['user', 'assistant_text', 'thinking', 'tool_call', 'notification'].includes(item.kind)
    && !item.parentToolCallId && !(item.kind === 'thinking' && typeof item.content === 'string' && !item.content.trim()));
  const rendered = rows.filter(row => !(row.dataset.timelineKind === 'thinking' && !row.textContent?.trim()));
  if (visible.length !== rendered.length) return undefined;
  const consistent = visible.every((item, index) => {
    const row = rendered[index];
    if (row.dataset.timelineKind !== item.kind) return false;
    if (item.toolCallId) return row.dataset.toolCallId === item.toolCallId;
    const anchor = recordedTarget(item, rows);
    return !anchor || anchor === row;
  });
  const index = visible.findIndex(item => item.id === step.id);
  return consistent && index >= 0 ? rendered[index] : undefined;
}

function recordedTarget(step: SessionStep, rows: HTMLElement[]): HTMLElement | undefined {
  if (!step.sourceEntryId) return undefined;
  const source = step.sourceEntryId;
  const block = step.id.split(':').at(-1);
  const id = step.kind === 'user' ? `history-message:${source}`
    : step.kind === 'assistant_text' ? (block === "empty" ? `history-assistant-message:${source}` : `history-assistant-text:${source}:${block}`)
    : step.kind === 'thinking' ? `history-thinking:${source}:${block}` : undefined;
  return id ? rows.find(row => row.dataset.timelineId === id) : undefined;
}

let currentHighlight: (() => void) | undefined;
/** Share the transient selection between trace navigation and the minimap. */
export function highlightTimelineTarget(target: HTMLElement): () => void {
  currentHighlight?.();
  target.classList.add('timeline-entry-highlight');
  target.scrollIntoView({behavior:'smooth', block:'center'});
  target.focus({preventScroll:true});
  const clear = () => {
    clearTimeout(timer);
    target.classList.remove('timeline-entry-highlight');
    if (currentHighlight === clear) currentHighlight = undefined;
  };
  const timer = setTimeout(clear, 5000);
  currentHighlight = clear;
  return () => { if (currentHighlight === clear) clear(); };
}
