import { iconSource } from './icon-sources.js';

export function ToolStatusIcon({ done, isError }: { done: boolean; isError: boolean }) {
  const state = !done ? "running" : isError ? "error" : "success";
  const label = !done ? "进行中" : isError ? "失败" : "已完成";
  if (done) return <svg className={`tool-status-icon tool-status-${state}`} data-icon={isError ? 'error-circle' : 'check-circle'} width="14" height="14" viewBox="0 0 24 24" fill="none" role="img" aria-label={label} focusable="false">
    <title>{label}</title><g dangerouslySetInnerHTML={iconSource(isError ? 'error-circle' : 'check-circle')} />
  </svg>;
  return <svg className={`tool-status-icon tool-status-${state}`} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" role="img" aria-label={label}>
    <title>{label}</title>
    {<path d="M8 2a6 6 0 1 1-6 6" />}
  </svg>;
}
