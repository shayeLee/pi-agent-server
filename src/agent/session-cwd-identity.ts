import { realpathSync, statSync } from "node:fs";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";

export type SessionCwdIdentity = { readonly version: 1; readonly cwd: string; readonly dev: number; readonly ino: number };

/** Canonical, inode-bound project root written into each new Pi JSONL. */
export function captureSessionCwdIdentity(cwd: string): SessionCwdIdentity {
  const canonical = realpathSync(cwd);
  const stat = statSync(canonical);
  if (!stat.isDirectory()) throw new Error("session project cwd is not a directory");
  return { version: 1, cwd: canonical, dev: stat.dev, ino: stat.ino };
}

/**
 * Trust only the immutable JSONL snapshot, never the mutable project/default cwd configuration.
 * Legacy transcripts without the inode identity are deliberately unavailable: a header cwd alone
 * cannot prove that a root path was not replaced before this request.
 */
export function readSessionCwdIdentity(entries: readonly unknown[]): SessionCwdIdentity | null {
  const header = entries[0] as SessionHeader | undefined;
  if (!header || typeof header.cwd !== "string") return null;
  for (const entry of entries) {
    const custom = entry as SessionEntry & { customType?: unknown; data?: unknown };
    if (custom.type !== "custom" || custom.customType !== "pi-agent-server:cwd-identity") continue;
    const data = custom.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
    const value = data as Partial<SessionCwdIdentity>;
    if (value.version !== 1 || typeof value.cwd !== "string" || typeof value.dev !== "number" || typeof value.ino !== "number") continue;
    // Header and identity must agree exactly. This prevents a later custom entry from redirecting root.
    if (value.cwd !== header.cwd) return null;
    return { version: 1, cwd: value.cwd, dev: value.dev, ino: value.ino };
  }
  return null;
}
