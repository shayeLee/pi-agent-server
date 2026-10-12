import sidebar from '../icons/svg/panel-left.svg?raw';
import plus from '../icons/svg/plus.svg?raw';
import plusNeutral from '../icons/svg/plus-neutral.svg?raw';
import folder from '../icons/svg/folder.svg?raw';
import chevron from '../icons/svg/chevron-right.svg?raw';
import down from '../icons/svg/chevron-down.svg?raw';
import up from '../icons/svg/chevron-up.svg?raw';
import projectChevronDown from '../icons/svg/project-chevron-down.svg?raw';
import projectChevronUp from '../icons/svg/project-chevron-up.svg?raw';
import search from '../icons/svg/search.svg?raw';
import moon from '../icons/svg/moon.svg?raw';
import sun from '../icons/svg/sun.svg?raw';
import ellipsis from '../icons/svg/more-horizontal.svg?raw';
import close from '../icons/svg/close.svg?raw';
import sparkles from '../icons/svg/sparkles.svg?raw';
import user from '../icons/svg/user.svg?raw';
import terminal from '../icons/svg/terminal.svg?raw';
import file from '../icons/svg/file-text.svg?raw';
import hourglass from '../icons/svg/hourglass.svg?raw';
import success from '../icons/svg/check-circle.svg?raw';
import check from '../icons/svg/check-mini.svg?raw';
import error from '../icons/svg/error-circle.svg?raw';
import steer from '../icons/svg/steer.svg?raw';
import clock from '../icons/svg/clock.svg?raw';
import trash from '../icons/svg/trash.svg?raw';
import send from '../icons/svg/send.svg?raw';
import stop from '../icons/svg/stop.svg?raw';
import paperclip from '../icons/svg/paperclip.svg?raw';
import copy from '../icons/svg/copy.svg?raw';
import edit from '../icons/svg/edit.svg?raw';

// Trusted build-time assets only. Never accept API, upload, or caller SVG strings.
const sources = { sidebar, plus, 'plus-neutral': plusNeutral, folder, chevron, down, up, 'project-chevron-down': projectChevronDown, 'project-chevron-up': projectChevronUp, search, moon, sun, ellipsis, close, sparkles, user, terminal, file, hourglass, 'check-circle': success, check, 'error-circle': error, 'paper-plane': steer, clock, trash, send, stop, paperclip, copy, edit } as const;
export type SourceIconName = keyof typeof sources;
const bodies = Object.fromEntries(Object.entries(sources).map(([name, source]) => {
  let body = source.replace(/^<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>[^<]*<\/title>/, '');
  // Composer buttons own the background; these assets supply only the glyph.
  if (name === 'send') body = body.replace(/<rect\b[^>]*\/>/, '');
  // Neutral colors inherit theme/disabled state; meaningful white and status fills remain.
  if (name === 'stop') body = body.replace(/<circle\b[^>]*\/>/, '').replace(/#fff/g, 'currentColor');
  const viewBoxMatch = source.match(/viewBox="([^"]+)"/);
  const viewBox = name === 'stop' ? '5 5 14 14' : viewBoxMatch ? viewBoxMatch[1] : '0 0 24 24';
  return [name, { __html: body, viewBox }];
})) as Record<SourceIconName, { __html: string; viewBox: string }>;
export function iconSource(name: string) {
  return Object.hasOwn(sources, name) ? bodies[name as SourceIconName] : undefined;
}
