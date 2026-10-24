// Which session is an owner's butler (docs/companion-butler.md §12.2). A reset points the row at a
// new session; the old one stays, hidden and still counted in usage.
export interface ButlerStorePort {
  /** The owner's current butler session id; `null` before the first one. */
  get(ownerKey: string): Promise<string | null>;
  /** Points the owner's butler at `sessionId`, replacing any earlier one. */
  set(ownerKey: string, sessionId: string, createdAt: number): Promise<void>;
}
