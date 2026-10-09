import path from "node:path";
import { realpathSync, statSync } from "node:fs";

export type CanonicalCwdIdentity = { readonly cwd: string; readonly dev: number; readonly ino: number };

export function canonicalCwdIdentity(cwd: string): CanonicalCwdIdentity {
  const canonical = realpathSync(cwd);
  const stat = statSync(canonical);
  if (!stat.isDirectory()) throw new Error("project directory unavailable");
  return { cwd: canonical, dev: stat.dev, ino: stat.ino };
}

export function splitSessionExcludeCwds(value: string | undefined): string[] {
  return (value ?? "").split(",").map(value => value.trim()).filter(Boolean);
}

/** Exact canonical directory exclusions. Invalid configuration denies all native access. */
export class NativeSessionPolicy {
  private readonly excluded: readonly { input: string; identity: CanonicalCwdIdentity }[];
  private readonly excludedPaths: ReadonlySet<string>;
  constructor(excludedCwds: readonly string[]) {
    try {
      if (excludedCwds.length > 64) throw new Error();
      this.excluded = Object.freeze([...new Set(excludedCwds)].map(input => {
        if (!path.isAbsolute(input)) throw new Error();
        return Object.freeze({ input, identity: Object.freeze(canonicalCwdIdentity(input)) });
      }));
      this.excludedPaths = new Set(this.excluded.map(entry => entry.identity.cwd));
    } catch { throw new Error("native session exclusion configuration unavailable"); }
  }

  allows(identity: CanonicalCwdIdentity): boolean {
    try {
      // Fixed startup canonical targets, but disappearance/replacement/alias retargeting
      // still denies all native output. Only directory metadata, never transcript reads.
      for (const entry of this.excluded) {
        const current = canonicalCwdIdentity(entry.input);
        if (current.cwd !== entry.identity.cwd || current.dev !== entry.identity.dev || current.ino !== entry.identity.ino) return false;
      }
      const current = canonicalCwdIdentity(identity.cwd);
      return current.cwd === identity.cwd && current.dev === identity.dev && current.ino === identity.ino && !this.excludedPaths.has(current.cwd);
    } catch {
      return false;
    }
  }
}

/** CLI agent directory, not the server's private PI_AGENT_DIR or DATA_DIR. */
export function resolveNativeSessionSourceDir(options: {
  sourceDir?: string; home: string; env: Readonly<Record<string, string | undefined>>;
}): string {
  const expand = (value: string) => value === "~" ? options.home : value.startsWith("~/") ? path.join(options.home, value.slice(2)) : value;
  const agentDir = options.env.PI_CODING_AGENT_DIR || path.join(options.home, ".pi", "agent");
  return path.resolve(expand(options.sourceDir?.trim() || path.join(expand(agentDir), "sessions")));
}
