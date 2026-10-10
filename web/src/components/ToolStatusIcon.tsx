export function ToolStatusIcon({ done, isError }: { done: boolean; isError: boolean }) {
  const state = !done ? "running" : isError ? "error" : "success";
  const label = !done ? "进行中" : isError ? "失败" : "已完成";
  return <svg className={`tool-status-icon tool-status-${state}`} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={label}>
    <title>{label}</title>
    {state === "running" ? <path d="M8 2a6 6 0 1 1-6 6" /> : state === "error" ? <><circle cx="8" cy="8" r="6" /><path d="m6 6 4 4m0-4-4 4" /></> : <path d="m3 8 3 3 7-7" />}
  </svg>;
}
