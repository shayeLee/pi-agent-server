/** Placeholder blocks for sidebar/chat loading states. */
export function SessionListSkeleton() {
  return (
    <div className="space-y-2 px-3 py-2" data-testid="sessions-loading" role="status" aria-busy="true">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="h-9 animate-pulse rounded-md bg-muted/60" />
      ))}
    </div>
  );
}

export function ChatHistorySkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-4 py-6" role="status" aria-busy="true">
      <div className="ml-auto h-10 w-2/5 animate-pulse rounded-lg bg-muted/50" />
      <div className="h-24 w-full animate-pulse rounded-lg bg-muted/40" />
      <div className="h-16 w-4/5 animate-pulse rounded-lg bg-muted/40" />
    </div>
  );
}
