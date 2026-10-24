// Login resource limits (docs/login-design.md §6).
//
// - At most two scrypt computations run at once; a third login is refused at once with 429 and
//   Retry-After: 1, and is not counted as a failure.
// - Failures back off exponentially per key (client IP and login name, counted separately), from
//   1 second up to 5 minutes. Requests inside the wait are refused at once; nothing sleeps on the server.
// - Records live in memory, at most 1000, dropped after 30 minutes without activity, cleared on restart.

export const MAX_CONCURRENT_SCRYPT = 2;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 1000;
const IDLE_MS = 30 * 60 * 1000;

export class ScryptGate {
  private running = 0;

  constructor(private readonly limit = MAX_CONCURRENT_SCRYPT) {}

  /** A release function, or null when the limit is reached. */
  tryAcquire(): (() => void) | null {
    if (this.running >= this.limit) return null;
    this.running++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
    };
  }
}

type Entry = { failures: number; nextAllowedAt: number; lastActivity: number };

export class LoginBackoff {
  private readonly entries = new Map<string, Entry>();

  /** Seconds until this key may try again; 0 when it may try now. */
  retryAfterSeconds(key: string, now: number): number {
    const entry = this.get(key, now);
    if (!entry || entry.nextAllowedAt <= now) return 0;
    return Math.ceil((entry.nextAllowedAt - now) / 1000);
  }

  recordFailure(key: string, now: number): void {
    const entry = this.get(key, now) ?? { failures: 0, nextAllowedAt: 0, lastActivity: now };
    entry.failures++;
    entry.nextAllowedAt = now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (entry.failures - 1));
    entry.lastActivity = now;
    // Re-insert so Map order stays least-recently-active first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  private get(key: string, now: number): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && now - entry.lastActivity > IDLE_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
