import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ConversationMinimap, conversationTurns } from './ConversationMinimap.js';
import type { TimelineItem } from 'pi-agent-server/client';
const timeline: TimelineItem[] = [
  {kind:'message',id:'u1',role:'user',text:'相同问题',streaming:false},
  {kind:'thinking',id:'t1',text:'internal',streaming:false},
  {kind:'message',id:'a1',role:'assistant',text:'回复一',streaming:false},
  {kind:'message',id:'u2',role:'user',text:'相同问题',streaming:false},
  {kind:'message',id:'a2',role:'assistant',text:'回复二',streaming:false},
];
it('switches a hovered preview with real keyboard focus and keeps boundaries stable', () => {
  render(<ConversationMinimap timeline={timeline} viewport={{current:document.createElement('div')}} onNavigate={vi.fn()} />);
  const buttons = screen.getAllByRole('button');
  fireEvent.mouseEnter(buttons[0]);
  expect(buttons[0]).not.toHaveFocus();
  expect(screen.getByRole('tooltip')).toHaveTextContent('回复一');
  expect(fireEvent.keyDown(document.body, {key:'ArrowDown'})).toBe(false);
  expect(buttons[1]).toHaveFocus();
  expect(screen.getByRole('tooltip')).toHaveTextContent('回复二');
  fireEvent.keyDown(buttons[1], {key:'ArrowDown'});
  expect(buttons[1]).toHaveFocus();
  fireEvent.keyDown(buttons[1], {key:'ArrowUp'});
  expect(buttons[0]).toHaveFocus();
  expect(screen.getByRole('tooltip')).toHaveTextContent('回复一');
  fireEvent.keyDown(buttons[0], {key:'Escape'});
  expect(screen.queryByRole('tooltip')).toBeNull();
});

it('leaves editing keys alone and stops handling keys when hover closes or the minimap unmounts', () => {
  const {unmount} = render(<><textarea aria-label="草稿" /><ConversationMinimap timeline={timeline}
    viewport={{current:document.createElement('div')}} onNavigate={vi.fn()} /></>);
  const buttons = screen.getAllByRole('button');
  const input = screen.getByRole('textbox');
  input.focus();
  fireEvent.mouseEnter(buttons[0]);
  expect(fireEvent.keyDown(input, {key:'ArrowDown'})).toBe(true);
  expect(input).toHaveFocus();
  expect(screen.getByRole('tooltip')).toHaveTextContent('回复一');
  expect(fireEvent.keyDown(document.body, {key:'ArrowDown', isComposing:true})).toBe(true);
  expect(fireEvent.keyDown(document.body, {key:'ArrowDown', ctrlKey:true})).toBe(true);
  fireEvent.mouseLeave(screen.getByRole('navigation'));
  expect(fireEvent.keyDown(document.body, {key:'ArrowDown'})).toBe(true);
  expect(input).toHaveFocus();
  fireEvent.mouseEnter(buttons[0]);
  unmount();
  expect(fireEvent.keyDown(document.body, {key:'ArrowDown'})).toBe(true);
});

it('groups by user turns and navigates repeated prompts by identity', () => {
  expect(conversationTurns(timeline)).toEqual([{id:'u1',prompt:'相同问题',answer:'回复一'},{id:'u2',prompt:'相同问题',answer:'回复二'}]);
  const viewport = document.createElement('div');
  const target = document.createElement('div');
  target.dataset.timelineId = 'u2'; target.scrollIntoView = vi.fn();
  viewport.append(target);
  const navigate = vi.fn();
  const {unmount} = render(<ConversationMinimap timeline={timeline} viewport={{current:viewport}} onNavigate={navigate} />);
  expect(screen.getAllByRole('button')).toHaveLength(2);
  const button = screen.getByRole('button', {name:'第 2 轮：相同问题'});
  fireEvent.focus(screen.getByRole('button', {name:'第 1 轮：相同问题'}));
  fireEvent.keyDown(screen.getByRole('button', {name:'第 1 轮：相同问题'}), {key:'ArrowDown'});
  expect(button).toHaveFocus();
  expect(button).toHaveAttribute('tabindex', '0');
  fireEvent.mouseEnter(button);
  expect(screen.getByRole('tooltip')).toHaveTextContent('回复二');
  fireEvent.click(button);
  expect(navigate).toHaveBeenCalledOnce();
  expect(target.scrollIntoView).toHaveBeenCalledOnce();
  expect(target).toHaveClass('timeline-entry-highlight');
  expect(screen.queryByRole('tooltip')).toBeNull();
  unmount();
  expect(target).not.toHaveClass('timeline-entry-highlight');
});

it('tapers neighboring ticks around the current turn and follows hover before returning', () => {
  const items: TimelineItem[] = Array.from({length:11}, (_, index) => ({kind:'message', id:`u${index}`, role:'user', text:'same', streaming:false}));
  const viewport = document.createElement('div');
  Object.defineProperty(viewport, 'clientHeight', {value:400});
  items.forEach((item, index) => {
    const row = document.createElement('div');
    row.dataset.timelineId = item.id;
    row.getBoundingClientRect = () => ({top:200 + (index - 5) * 100}) as DOMRect;
    viewport.append(row);
  });
  render(<ConversationMinimap timeline={items} viewport={{current:viewport}} onNavigate={vi.fn()} />);
  const buttons = screen.getAllByRole('button');
  const width = (index:number) => parseFloat(buttons[index].querySelector('span')!.style.width);
  expect(buttons[5]).toHaveAttribute('aria-current','true');
  expect(width(5)).toBeGreaterThan(width(4));
  expect(width(4)).toBeGreaterThan(width(3));
  expect(width(3)).toBeGreaterThan(width(2));
  expect(width(4)).toBe(width(6));
  fireEvent.mouseEnter(buttons[2]);
  expect(width(2)).toBeGreaterThan(width(3));
  expect(width(1)).toBe(width(3));
  fireEvent.mouseLeave(screen.getByRole('navigation'));
  expect(width(5)).toBeGreaterThan(width(4));
});

it('tracks the turn spanning the viewport center after navigation and manual scrolling', () => {
  const viewport = document.createElement('div');
  Object.defineProperty(viewport, 'clientHeight', {value:600});
  Object.defineProperty(viewport, 'scrollHeight', {value:2000});
  viewport.getBoundingClientRect = () => ({top:100}) as DOMRect;
  let secondTop = 400;
  const first = document.createElement('div');
  first.dataset.timelineId = 'u1';
  first.getBoundingClientRect = () => ({top:-500}) as DOMRect;
  const second = document.createElement('div');
  second.dataset.timelineId = 'u2';
  second.getBoundingClientRect = () => ({top:secondTop}) as DOMRect;
  second.scrollIntoView = vi.fn(() => { secondTop = 375; });
  viewport.append(first, second);
  let update: FrameRequestCallback | undefined;
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { update = callback; return 1; });
  const {unmount} = render(<ConversationMinimap timeline={timeline} viewport={{current:viewport}} onNavigate={vi.fn()} />);
  const buttons = screen.getAllByRole('button');
  const scroll = () => {
    fireEvent.scroll(viewport);
    act(() => update?.(0));
  };
  expect(buttons[1]).toHaveAttribute('aria-current', 'true');
  fireEvent.click(buttons[1]);
  scroll();
  expect(second.scrollIntoView).toHaveBeenCalledWith({behavior:'smooth', block:'center'});
  expect(buttons[1]).toHaveAttribute('aria-current', 'true');
  secondTop = 401;
  fireEvent.wheel(viewport, {deltaY:-100});
  scroll();
  expect(buttons[0]).toHaveAttribute('aria-current', 'true');
  secondTop = 399;
  scroll();
  expect(buttons[1]).toHaveAttribute('aria-current', 'true');
  // A short final turn can still sit below center at the scroll limit.
  secondTop = 650;
  viewport.scrollTop = 1400;
  scroll();
  expect(buttons[1]).toHaveAttribute('aria-current', 'true');
  viewport.scrollTop = 0;
  scroll();
  expect(buttons[0]).toHaveAttribute('aria-current', 'true');
  unmount();
  raf.mockRestore();
});

it('pins clicked turns through smooth scrolling and layout updates, then releases on manual input', () => {
  const viewport = document.createElement('div');
  Object.defineProperty(viewport, 'clientHeight', {value:600});
  let secondTop = 900;
  for (const [id, top] of [['u1', 0], ['u2', 900]] as const) {
    const row = document.createElement('div');
    row.dataset.timelineId = id;
    row.getBoundingClientRect = () => ({top:id === 'u2' ? secondTop : top}) as DOMRect;
    row.scrollIntoView = vi.fn();
    viewport.append(row);
  }
  let update: FrameRequestCallback | undefined;
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { update = callback; return 1; });
  const props = {timeline, viewport:{current:viewport}, onNavigate:vi.fn()};
  const {rerender, unmount} = render(<ConversationMinimap {...props} />);
  const buttons = screen.getAllByRole('button');
  const scroll = () => { fireEvent.scroll(viewport); act(() => update?.(0)); };
  expect(buttons[0]).toHaveAttribute('aria-current', 'true');
  fireEvent.click(buttons[1]);
  expect(buttons[1]).toHaveAttribute('aria-current', 'true');
  scroll();
  expect(buttons[1]).toHaveAttribute('aria-current', 'true');
  fireEvent(viewport, new Event('scrollend'));
  rerender(<ConversationMinimap {...props} timeline={[...timeline]} />);
  expect(buttons[1]).toHaveAttribute('aria-current', 'true');
  fireEvent.keyDown(viewport, {key:'PageUp'});
  scroll();
  expect(buttons[0]).toHaveAttribute('aria-current', 'true');
  fireEvent.click(buttons[1]);
  fireEvent.touchMove(viewport);
  scroll();
  expect(buttons[0]).toHaveAttribute('aria-current', 'true');
  // A second click supersedes the first destination, even mid-animation.
  fireEvent.click(buttons[1]);
  fireEvent.click(buttons[0]);
  secondTop = 200;
  scroll();
  expect(buttons[0]).toHaveAttribute('aria-current', 'true');
  fireEvent.wheel(viewport, {deltaY:100});
  scroll();
  expect(buttons[1]).toHaveAttribute('aria-current', 'true');
  unmount();
  raf.mockRestore();
});

it('suppresses previews during navigation and requires pointer movement to reopen after settling', () => {
  vi.useFakeTimers();
  const viewport = document.createElement('div');
  const target = document.createElement('div');
  target.dataset.timelineId = 'u2'; target.scrollIntoView = vi.fn();
  viewport.append(target);
  const {unmount} = render(<ConversationMinimap timeline={timeline} viewport={{current:viewport}} onNavigate={vi.fn()} />);
  const buttons = screen.getAllByRole('button');
  fireEvent.mouseEnter(buttons[1]);
  expect(screen.getByRole('tooltip')).toHaveTextContent('回复二');
  fireEvent.click(buttons[1]);
  fireEvent.mouseEnter(buttons[0]);
  fireEvent.mouseMove(buttons[0]);
  fireEvent.focus(buttons[0]);
  expect(screen.queryByRole('tooltip')).toBeNull();
  act(() => vi.advanceTimersByTime(100));
  fireEvent.scroll(viewport);
  act(() => vi.advanceTimersByTime(100));
  fireEvent.mouseMove(buttons[0]);
  expect(screen.queryByRole('tooltip')).toBeNull();
  act(() => vi.advanceTimersByTime(180));
  fireEvent.mouseEnter(buttons[0]);
  expect(screen.queryByRole('tooltip')).toBeNull();
  fireEvent.mouseMove(buttons[0]);
  expect(screen.getByRole('tooltip')).toHaveTextContent('回复一');
  fireEvent.click(buttons[1]);
  fireEvent(viewport, new Event('scrollend'));
  fireEvent.focus(buttons[0]);
  expect(screen.getByRole('tooltip')).toHaveTextContent('回复一');
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
