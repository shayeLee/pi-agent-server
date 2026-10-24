import { accountScopedKey } from "./auth/storage-scope.js";

/** Navigation hints only; never credentials, drafts, or cached private content. */
export type RecentSelection = { version: 1; projectId: string; sessionId: string | null };
// The Web API uses the current origin (baseUrl=""). No owner identity is exposed;
// every restored ID must therefore be validated against freshly authorized API lists.
export function recentSelectionKey(): string {
  return accountScopedKey(`pi.recent-selection.v1:${new URL("/", window.location.href).origin}`);
}
export function clearRecentSelection(): void {
  try { window.localStorage.removeItem(recentSelectionKey()); } catch { /* Storage may be denied. */ }
}
export function readRecentSelection(): RecentSelection | null {
  try {
    const raw = window.localStorage.getItem(recentSelectionKey());
    if (raw === null) return null;
    if (raw.length > 1024) throw new Error("oversize");
    const value = JSON.parse(raw);
    const validId = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 256;
    if (!value || value.version !== 1 || !validId(value.projectId) ||
      !(value.sessionId === null || validId(value.sessionId)) ||
      Object.keys(value).some(key => !["version", "projectId", "sessionId"].includes(key))) throw new Error("invalid");
    return value;
  } catch { clearRecentSelection(); return null; }
}
export function writeRecentSelection(projectId: string, sessionId: string | null): void {
  try { window.localStorage.setItem(recentSelectionKey(), JSON.stringify({ version: 1, projectId, sessionId })); }
  catch { /* Navigation works without persistence. */ }
}
