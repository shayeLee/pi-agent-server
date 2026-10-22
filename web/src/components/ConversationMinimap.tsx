import { zhCN } from "../i18n/zh-CN.js";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { TimelineItem } from 'pi-agent-server/client';
import { highlightTimelineTarget } from './step-navigation.js';

function previewText(text: string): string {
  return text.replace(/```[\s\S]*?```/g, zhCN.minimap.code)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(^|\n)\s{0,3}#{1,6}\s+/g, '$1')
    .replace(/[*`_]/g, '').trim();
}

export function conversationTurns(timeline: readonly TimelineItem[]) {
  const turns: {id: string; prompt: string; answer: string}[] = [];
  for (const item of timeline) {
    if (item.kind === 'message' && item.role === 'user') turns.push({id:item.id, prompt:item.text || zhCN.minimap.attachment, answer:''});
    else if (item.kind === 'message' && item.role === 'assistant' && item.text.trim() && turns.length) turns[turns.length - 1].answer = item.text;
  }
  return turns;
}

export function ConversationMinimap({timeline, viewport, onNavigate}: {
  timeline: readonly TimelineItem[]; viewport: RefObject<HTMLDivElement | null>; onNavigate: (timelineId: string) => void;
}) {
  const turns = useMemo(() => conversationTurns(timeline), [timeline]);
  const [railHeight, setRailHeight] = useState(280);
  const [focused, setFocused] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [preview, setPreview] = useState<{id:string; top:number} | null>(null);
  const rail = useRef<HTMLElement>(null);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  const pinned = useRef<string | null>(null);
  const navigating = useRef(false);
  const suppressHover = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settle = () => { clearTimeout(settleTimer.current); navigating.current = false; };
  const scheduleSettle = () => {
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(settle, 180);
  };
  useEffect(() => () => { cleanup.current?.(); clearTimeout(settleTimer.current); }, []);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const ids = new Set(turns.map(turn => turn.id));
    if (pinned.current && !ids.has(pinned.current)) { pinned.current = null; settle(); suppressHover.current = false; }
    const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-timeline-id]')).filter(row => ids.has(row.dataset.timelineId!));
    let frame = 0;
    const update = () => {
      frame = 0;
      setRailHeight(Math.max(48, Math.min(300, el.clientHeight * .6)));
      // Navigation centers the prompt, so reading position uses the same anchor.
      const boundary = el.getBoundingClientRect().top + el.clientTop + el.clientHeight / 2;
      let current = rows[0];
      for (const row of rows) { if (row.getBoundingClientRect().top > boundary) break; current = row; }
      // The last prompt may never reach the center when its reply is short.
      if (el.scrollHeight > el.clientHeight && el.scrollHeight - el.clientHeight - el.scrollTop <= 1) current = rows.at(-1) ?? current;
      setActive(pinned.current ?? current?.dataset.timelineId ?? null);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const onScroll = () => { if (navigating.current) scheduleSettle(); schedule(); };
    const resumeReading = () => {
      pinned.current = null;
      settle();
      setPreview(null);
      schedule();
    };
    const onWheel = (event: WheelEvent) => { if (event.deltaY) resumeReading(); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) resumeReading();
    };
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    resize?.observe(el);
    if (el.firstElementChild) resize?.observe(el.firstElementChild);
    el.addEventListener('scroll', onScroll, {passive:true});
    el.addEventListener('scrollend', settle);
    el.addEventListener('wheel', onWheel, {passive:true});
    el.addEventListener('touchmove', resumeReading, {passive:true});
    el.addEventListener('keydown', onKeyDown, true);
    update();
    return () => {
      cancelAnimationFrame(frame); resize?.disconnect();
      el.removeEventListener('scroll', onScroll); el.removeEventListener('scrollend', settle);
      el.removeEventListener('wheel', onWheel); el.removeEventListener('touchmove', resumeReading);
      el.removeEventListener('keydown', onKeyDown, true);
    };
  }, [turns, viewport]);
  useEffect(() => {
    const nav = rail.current;
    const button = nav?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!nav || !button) return;
    if (button.offsetTop < nav.scrollTop) nav.scrollTop = button.offsetTop;
    else if (button.offsetTop + button.offsetHeight > nav.scrollTop + nav.clientHeight) nav.scrollTop = button.offsetTop + button.offsetHeight - nav.clientHeight;
  }, [active, railHeight, turns.length]);
  useEffect(() => {
    if (!preview) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      // Focused ticks handle their own keys; editing controls keep cursor navigation.
      if (target instanceof Element && (rail.current?.contains(target)
        || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'))) return;
      if (event.key === 'Escape') { setPreview(null); return; }
      const index = turns.findIndex(turn => turn.id === preview.id);
      if (index < 0) return;
      const next = event.key === 'ArrowDown' ? Math.min(turns.length - 1, index + 1)
        : event.key === 'ArrowUp' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? turns.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      rail.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [preview, turns]);
  // A single turn has nowhere to navigate; a lone tick reads as a stray mark.
  if (turns.length < 2) return null;
  const selectedIndex = turns.findIndex(turn => turn.id === preview?.id);
  const selected = turns[selectedIndex];
  const bulgeCenter = selectedIndex >= 0 ? selectedIndex : Math.max(0, turns.findIndex(turn => turn.id === active));
  const tabStop = focused ?? active ?? turns[0].id;
  const show = (id:string, button:HTMLElement) => {
    if (navigating.current) return;
    const bounds = viewport.current?.getBoundingClientRect();
    setPreview({id, top:Math.max(8, Math.min(button.getBoundingClientRect().top - (bounds?.top ?? 0), (bounds?.height ?? 240) - 220))});
  };
  return <>
    <nav className="conversation-minimap" aria-label={zhCN.minimap.label} style={{maxHeight:railHeight}} ref={rail}
      onMouseLeave={() => { setPreview(null); if (!navigating.current) suppressHover.current = false; }}>
      {turns.map((turn, index) => <button key={turn.id} type="button" aria-label={zhCN.minimap.turn(index + 1, turn.prompt.slice(0, 80))}
        aria-current={active === turn.id ? 'true' : undefined} tabIndex={turn.id === tabStop ? 0 : -1}
        style={{flexBasis:Math.max(6, Math.min(10, railHeight / turns.length))}}
        onMouseEnter={event => { if (!suppressHover.current) show(turn.id, event.currentTarget); }}
        onMouseMove={event => { if (!navigating.current) { suppressHover.current = false; show(turn.id, event.currentTarget); } }}
        onFocus={event => {setFocused(turn.id); show(turn.id, event.currentTarget);}}
        onBlur={() => {setPreview(null); setFocused(null);}} onKeyDown={event => {
          if (event.key === 'Escape') {setPreview(null); event.stopPropagation(); return;}
          const next = event.key === 'ArrowDown' ? Math.min(turns.length - 1, index + 1)
            : event.key === 'ArrowUp' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? turns.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault(); rail.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
        }}
        onClick={() => {
          const target = Array.from(viewport.current?.querySelectorAll<HTMLElement>('[data-timeline-id]') ?? []).find(row => row.dataset.timelineId === turn.id);
          if (!target) return;
          pinned.current = turn.id; navigating.current = true; suppressHover.current = true;
          setActive(turn.id); setPreview(null); scheduleSettle();
          onNavigate(turn.id); cleanup.current?.(); cleanup.current = highlightTimelineTarget(target);
        }}><span style={{width: `${6 + 20 * Math.exp(-Math.pow((index - bulgeCenter) / 1.8, 2) / 2)}px`}} /></button>)}
    </nav>
    {selected && preview && <div className="minimap-preview" style={{top:preview.top}} role="tooltip">
      <div className="minimap-preview-meta">{zhCN.minimap.dialog} {selectedIndex + 1} / {turns.length}{active === selected.id && <span>{zhCN.minimap.reading}</span>}</div>
      <strong>{selected.prompt}</strong>
      <p>{previewText(selected.answer) || zhCN.minimap.noReply}</p>
      <div className="minimap-preview-hint">{zhCN.minimap.hint}</div>
    </div>}
  </>;
}
