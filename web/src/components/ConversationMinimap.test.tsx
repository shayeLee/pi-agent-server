import { fireEvent, render, screen } from '@testing-library/react';
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
    row.getBoundingClientRect = () => ({top:(index - 5) * 100}) as DOMRect;
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
