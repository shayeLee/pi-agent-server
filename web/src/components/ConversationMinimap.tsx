import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { TimelineItem } from 'pi-agent-server/client';
import { highlightTimelineTarget } from './step-navigation.js';

function previewText(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(^|\n)\s{0,3}#{1,6}\s+/g, '$1')
    .replace(/[*`_]/g, '').trim();
}

export function conversationTurns(timeline: readonly TimelineItem[]) {
  const turns: {id: string; prompt: string; answer: string}[] = [];
  for (const item of timeline) {
    if (item.kind === 'message' && item.role === 'user') turns.push({id:item.id, prompt:item.text || '图片或附件', answer:''});
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
  useEffect(() => () => cleanup.current?.(), []);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const ids = new Set(turns.map(turn => turn.id));
    const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-timeline-id]')).filter(row => ids.has(row.dataset.timelineId!));
    let frame = 0;
    const update = () => {
      frame = 0;
      setRailHeight(Math.max(48, Math.min(300, el.clientHeight * .6)));
      const boundary = el.getBoundingClientRect().top + Math.min(80, el.clientHeight / 4);
      let current = rows[0];
      for (const row of rows) { if (row.getBoundingClientRect().top > boundary) break; current = row; }
      setActive(current?.dataset.timelineId ?? null);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    resize?.observe(el);
    if (el.firstElementChild) resize?.observe(el.firstElementChild);
    el.addEventListener('scroll', schedule, {passive:true});
    update();
    return () => { cancelAnimationFrame(frame); resize?.disconnect(); el.removeEventListener('scroll', schedule); };
  }, [turns, viewport]);
  useEffect(() => {
    const nav = rail.current;
    const button = nav?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!nav || !button) return;
    if (button.offsetTop < nav.scrollTop) nav.scrollTop = button.offsetTop;
    else if (button.offsetTop + button.offsetHeight > nav.scrollTop + nav.clientHeight) nav.scrollTop = button.offsetTop + button.offsetHeight - nav.clientHeight;
  }, [active, railHeight, turns.length]);
  if (!turns.length) return null;
  const selectedIndex = turns.findIndex(turn => turn.id === preview?.id);
  const selected = turns[selectedIndex];
  const bulgeCenter = selectedIndex >= 0 ? selectedIndex : Math.max(0, turns.findIndex(turn => turn.id === active));
  const tabStop = focused ?? active ?? turns[0].id;
  const show = (id:string, button:HTMLElement) => {
    const bounds = viewport.current?.getBoundingClientRect();
    setPreview({id, top:Math.max(8, Math.min(button.getBoundingClientRect().top - (bounds?.top ?? 0), (bounds?.height ?? 240) - 220))});
  };
  return <>
    <nav className="conversation-minimap" aria-label="会话导航" style={{maxHeight:railHeight}} ref={rail} onMouseLeave={() => setPreview(null)}>
      {turns.map((turn, index) => <button key={turn.id} type="button" aria-label={`第 ${index + 1} 轮：${turn.prompt.slice(0, 80)}`}
        aria-current={active === turn.id ? 'true' : undefined} tabIndex={turn.id === tabStop ? 0 : -1}
        style={{flexBasis:Math.max(6, Math.min(10, railHeight / turns.length))}}
        onMouseEnter={event => show(turn.id, event.currentTarget)} onFocus={event => {setFocused(turn.id); show(turn.id, event.currentTarget);}}
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
          onNavigate(turn.id); cleanup.current?.(); cleanup.current = highlightTimelineTarget(target);
          setPreview(null);
        }}><span style={{width: `${6 + 20 * Math.exp(-Math.pow((index - bulgeCenter) / 1.8, 2) / 2)}px`}} /></button>)}
    </nav>
    {selected && preview && <div className="minimap-preview" style={{top:preview.top}} role="tooltip">
      <div className="minimap-preview-meta">对话 {selectedIndex + 1} / {turns.length}{active === selected.id && <span>正在阅读</span>}</div>
      <strong>{selected.prompt}</strong>
      <p>{previewText(selected.answer) || '暂无文字回复'}</p>
      <div className="minimap-preview-hint">点击跳转 · ↑ ↓ 切换</div>
    </div>}
  </>;
}
