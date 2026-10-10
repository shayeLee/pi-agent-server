export function ToolStatusIcon({ done, isError }: { done: boolean; isError: boolean }) {
  const state = !done ? "running" : isError ? "error" : "success";
  const label = !done ? "进行中" : isError ? "失败" : "已完成";
  return (
    <svg className={`tool-status-icon tool-status-${state}`} width="16" height="16" viewBox="0 0 16 16" fill="none" role="img" aria-label={label}>
      <title>{label}</title>
      {state === "running" ? (
        <path d="M8 2a6 6 0 1 1-6 6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      ) : (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          {state === "error" ? (
            <path d="M5.4 5.4 10.6 10.6M10.6 5.4 5.4 10.6" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
          ) : (
            <path d="M4.6 8.2 6.9 10.5 11.4 5.6" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          )}
        </>
      )}
    </svg>
  );
}
