// RunActivityHub (docs/companion-butler.md §4.1): which sessions are running now and how recent runs
// ended, kept in memory from the runtime's observability events. It knows only session ids; who may
// see which session is decided when reading (ActivityService), never here. A restart starts empty.

import type { ObservabilityEvent, ObservabilityPort } from "./ports/observability-port.js";
import type { ActivityOutcome } from "../shared/activity.js";

/** One change as the hub saw it, before access checks and titles. */
export type RawActivity = {
  id: number;
  at: number;
  sessionId: string;
  kind: "started" | ActivityOutcome;
  durationMs?: number;
  message?: string;
};

export type RawActivitySnapshot = {
  /** Every change with a larger id happened after this snapshot. */
  lastId: number;
  running: { sessionId: string; startedAt: number }[];
  /** Newest first. */
  recent: RawActivity[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MESSAGE_LIMIT = 200;

/** The first line of an error, at most MESSAGE_LIMIT characters. */
export function activityMessage(message: string): string {
  const line = message.split(/\r?\n/, 1)[0]!.trim();
  return line.length > MESSAGE_LIMIT ? `${line.slice(0, MESSAGE_LIMIT - 1)}…` : line;
}

export class RunActivityHub implements ObservabilityPort {
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxRecent: number;
  private readonly running = new Map<string, { requestId: string; startedAt: number }>();
  /** Oldest first; trimmed by count and age. */
  private readonly recent: RawActivity[] = [];
  private readonly listeners = new Set<(activity: RawActivity) => void>();
  /** A failed turn waits one microtask for its `error` event, which carries the message. */
  private readonly failing = new Map<string, RawActivity>();
  private lastId = 0;

  constructor(options: { now?: () => number; retentionMs?: number; maxRecent?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? DAY_MS;
    this.maxRecent = options.maxRecent ?? 1000;
  }

  observe(event: ObservabilityEvent): void {
    if (event.type === "turn_started") {
      this.running.set(event.sessionId, { requestId: event.requestId, startedAt: this.now() });
      this.publish({ id: ++this.lastId, at: this.now(), sessionId: event.sessionId, kind: "started" });
      return;
    }
    if (event.type === "error") {
      const pending = this.failing.get(event.requestId);
      if (pending && pending.sessionId === event.sessionId) pending.message = activityMessage(event.message);
      return;
    }
    if (event.type !== "turn") return;
    if (this.running.get(event.sessionId)?.requestId === event.requestId) this.running.delete(event.sessionId);
    const kind: ActivityOutcome = event.outcome === "error" ? "failed" : event.outcome;
    const activity: RawActivity = { id: 0, at: this.now(), sessionId: event.sessionId, kind, durationMs: event.durationMs };
    if (kind !== "failed") {
      this.finish(activity);
      return;
    }
    // The runtime reports the turn first and its error right after, in the same tick.
    this.failing.set(event.requestId, activity);
    queueMicrotask(() => {
      this.failing.delete(event.requestId);
      this.finish(activity);
    });
  }

  snapshot(): RawActivitySnapshot {
    this.prune();
    return {
      lastId: this.lastId,
      running: [...this.running].map(([sessionId, run]) => ({ sessionId, startedAt: run.startedAt })),
      recent: [...this.recent].reverse(),
    };
  }

  /** Changes after this call, in order. A listener that throws does not stop the others. */
  subscribe(listener: (activity: RawActivity) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private finish(activity: RawActivity): void {
    activity.id = ++this.lastId;
    this.recent.push(activity);
    this.prune();
    this.publish(activity);
  }

  private prune(): void {
    const before = this.now() - this.retentionMs;
    let drop = Math.max(0, this.recent.length - this.maxRecent);
    while (drop < this.recent.length && this.recent[drop]!.at < before) drop++;
    if (drop > 0) this.recent.splice(0, drop);
  }

  private publish(activity: RawActivity): void {
    for (const listener of this.listeners) {
      try { listener(activity); } catch { /* One listener must not break the stream for others. */ }
    }
  }
}

/** Sends each observability event to every port; one failing port does not stop the rest. */
export function fanOutObservability(...ports: (ObservabilityPort | undefined)[]): ObservabilityPort {
  const present = ports.filter((port): port is ObservabilityPort => port !== undefined);
  return {
    observe(event) {
      for (const port of present) {
        try { port.observe(event); } catch { /* Observability is best effort. */ }
      }
    },
  };
}
