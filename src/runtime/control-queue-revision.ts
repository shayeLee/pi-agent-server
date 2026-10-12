// Process-local, session-scoped ordering. Server epoch fences process restarts.
// Keep clocks across runtime disposal: late HTTP responses must never outrank a
// new incarnation. No transcript/queue payload is retained here.
const revisions = new Map<string, number>();
export function nextControlQueueRevision(sessionId: string): number {
  const revision = (revisions.get(sessionId) ?? 0) + 1;
  revisions.set(sessionId, revision);
  return revision;
}
