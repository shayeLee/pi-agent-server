import { EMPTY_MESSAGE, type UnsentMessage } from "./attachment-state.js";

export type DraftSource = {
  getSnapshot(scope: string): UnsentMessage;
  subscribe(scope: string, listener: () => void): () => void;
};

/** Page-local drafts. Only the editor for the changed scope is notified, not App/history. */
export function createDraftStore() {
  let messages: Record<string, UnsentMessage> = {};
  const listeners = new Map<string, Set<() => void>>();
  return {
    getAll: () => messages,
    getSnapshot: (scope: string) => messages[scope] ?? EMPTY_MESSAGE,
    update(scope: string, change: (previous: UnsentMessage) => UnsentMessage) {
      messages = { ...messages, [scope]: change(messages[scope] ?? EMPTY_MESSAGE) };
      for (const listener of listeners.get(scope) ?? []) listener();
    },
    subscribe(scope: string, listener: () => void) {
      let scoped = listeners.get(scope);
      if (!scoped) { scoped = new Set(); listeners.set(scope, scoped); }
      scoped.add(listener);
      return () => { scoped.delete(listener); if (!scoped.size) listeners.delete(scope); };
    },
  };
}
