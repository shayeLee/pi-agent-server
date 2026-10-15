import { zhCN } from "../i18n/zh-CN.js";
import { iconSource } from './icon-sources.js';

export function ToolStatusIcon({ done, isError, glyph = false }: { done: boolean; isError: boolean; glyph?: boolean }) {
  const state = !done ? "running" : isError ? "error" : "success";
  const label = !done ? zhCN.steps.streaming : isError ? zhCN.composer.failed : zhCN.status.completed;
  // Ledger step rows use text glyphs (DESIGN.md §5.1); other surfaces keep the icon library.
  if (glyph) return <span className={`tool-status-icon tool-status-${state} tool-status-glyph`} role="img" aria-label={label} title={label}>
    {state === "running" ? "◐" : state === "error" ? "✗" : "✓"}
  </span>;
  if (done) return <svg className={`tool-status-icon tool-status-${state}`} data-icon={isError ? 'error-circle' : 'check-circle'} width="14" height="14" viewBox="0 0 24 24" fill="none" role="img" aria-label={label} focusable="false">
    <title>{label}</title><g dangerouslySetInnerHTML={iconSource(isError ? 'error-circle' : 'check-circle')} />
  </svg>;
  return <svg className={`tool-status-icon tool-status-${state}`} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" role="img" aria-label={label}>
    <title>{label}</title>
    {<path d="M8 2a6 6 0 1 1-6 6" />}
  </svg>;
}
