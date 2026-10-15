import { useEffect, useState } from "react";
import type { ChatPhase } from "pi-agent-server/client";

export type RunStatus =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "queued" }
  /** `startedAt` only when this page observed the run start; joined runs have no timer. */
  | { kind: "running"; startedAt: number | null }
  | { kind: "completed" | "aborted" | "failed"; durationMs: number | null };

type Track = {
  sessionId: string | null;
  phase: ChatPhase;
  startedAt: number | null;
  terminal: Extract<RunStatus, { durationMs: number | null }> | null;
};

const LINGER_MS = 4000;

/** Pure transition: what this page can honestly say after `phase` changes. */
export function nextTrack(track: Track, sessionId: string | null, phase: ChatPhase, failed: boolean, at: number): Track {
  if (track.sessionId !== sessionId) return { sessionId, phase, startedAt: null, terminal: null };
  if (track.phase === phase) return track;
  if (phase === "submitting" || phase === "queued") return { sessionId, phase, startedAt: null, terminal: null };
  if (phase === "streaming") {
    const observedStart = track.phase === "submitting" || track.phase === "queued";
    return { sessionId, phase, startedAt: observedStart ? at : track.startedAt, terminal: null };
  }
  const kind = track.phase !== "streaming" ? null
    : phase === "completed" ? "completed" : phase === "aborted" ? "aborted" : failed ? "failed" : null;
  return { sessionId, phase, startedAt: null,
    terminal: kind ? { kind, durationMs: track.startedAt === null ? null : at - track.startedAt } : null };
}

/**
 * Run state for the header (DESIGN.md §5.2). Timing is a client observation: it starts
 * when this page sees submitting/queued turn into streaming, and is never inferred.
 */
export function useRunStatus(sessionId: string | null, phase: ChatPhase, failed: boolean, now: () => number = Date.now): RunStatus {
  const [track, setTrack] = useState<Track>({ sessionId, phase, startedAt: null, terminal: null });
  let current = track;
  if (track.sessionId !== sessionId || track.phase !== phase) {
    current = nextTrack(track, sessionId, phase, failed, now());
    setTrack(current);
  }
  const [, setTick] = useState(0);
  const ticking = current.phase === "streaming" && current.startedAt !== null;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setTick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const terminal = current.terminal;
  useEffect(() => {
    if (!terminal) return;
    const timer = setTimeout(() => setTrack(value => value.terminal === terminal ? { ...value, terminal: null } : value), LINGER_MS);
    return () => clearTimeout(timer);
  }, [terminal]);

  if (current.phase === "submitting") return { kind: "submitting" };
  if (current.phase === "queued") return { kind: "queued" };
  if (current.phase === "streaming") return { kind: "running", startedAt: current.startedAt };
  return terminal ?? { kind: "idle" };
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
