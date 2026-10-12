import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Icon, type IconName } from './Icon.js';
import { ToolStatusIcon } from './ToolStatusIcon.js';
import steer from '../icons/svg/steer.svg?raw';
import send from '../icons/svg/send.svg?raw';
import clock from '../icons/svg/clock.svg?raw';
import success from '../icons/svg/check-circle.svg?raw';
import error from '../icons/svg/error-circle.svg?raw';
import projectChevronDown from '../icons/svg/project-chevron-down.svg?raw';
import projectChevronUp from '../icons/svg/project-chevron-up.svg?raw';

function graphics(source: string) {
  return new DOMParser().parseFromString(source, 'image/svg+xml').querySelector('svg')!;
}
it.each<[IconName, string]>([['project-chevron-down', projectChevronDown], ['project-chevron-up', projectChevronUp]])('uses dedicated 12px geometry for %s', (name, source) => {
  const { container } = render(<Icon name={name} size={12} className="disclosure-chevron" />);
  const svg = container.querySelector('svg')!;
  expect(svg).toHaveAttribute('viewBox', '0 0 12 12');
  expect(svg).toHaveAttribute('width', '12');
  expect(svg).toHaveAttribute('height', '12');
  expect(svg).toHaveClass('ui-icon', 'disclosure-chevron');
  expect(svg.querySelector('title')).toBeNull();
  for (const attr of graphics(source).querySelector('path')!.attributes) {
    expect(svg.querySelector('path')).toHaveAttribute(attr.name, attr.value);
  }
});

it.each<[IconName, string]>([['paper-plane', steer], ['send', send], ['clock', clock]])('uses source geometry for %s and preserves decorative semantics', (name, source) => {
  const { container } = render(<Icon name={name} size={20} className="sample" />);
  const svg = container.querySelector('svg')!;
  expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
  expect(svg).toHaveAttribute('width', '20');
  expect(svg).toHaveAttribute('height', '20');
  expect(svg).toHaveClass('ui-icon', 'sample');
  expect(svg).toHaveAttribute('aria-hidden', 'true');
  expect(svg).toHaveAttribute('focusable', 'false');
  expect(svg.querySelector('title')).toBeNull();
  for (const attr of graphics(source).querySelector('path')!.attributes) {
    expect(svg.querySelector('path')).toHaveAttribute(attr.name, attr.value);
  }
  if (name === 'send') expect(svg.querySelector('rect')).toBeNull();
});
it.each([[false, success, '已完成'], [true, error, '失败']] as const)('retains independently labelled tool status %s', (isError, source, label) => {
  const { getByRole } = render(<ToolStatusIcon done isError={isError} />);
  const svg = getByRole('img', { name: label });
  expect(svg.querySelector('title')).toHaveTextContent(label);
  expect(svg.querySelector('path')).toHaveAttribute('d', graphics(source).querySelector('path')!.getAttribute('d'));
  expect(svg.querySelector('path')).toHaveAttribute('stroke', '#fff');
});
it('keeps the running spinner even when an unfinished tool has isError', () => {
  const { getByRole } = render(<ToolStatusIcon done={false} isError />);
  expect(getByRole('img', {name:'进行中'})).toHaveClass('tool-status-running');
});
