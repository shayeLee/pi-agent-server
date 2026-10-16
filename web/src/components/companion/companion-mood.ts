import { useCallback, useEffect, useRef, useState } from "react";
import type { RunStatus } from "../../hooks/useRunStatus.js";

export type CompanionMood = "idle" | "listening" | "curious" | "thinking" | "working" | "happy" | "sad" | "sleepy";
/** What the Composer reports; the companion only reacts, it never reads the text. */
export type ComposerActivity = "focus" | "blur" | "type" | "menu-open" | "menu-close" | "send";

export const TYPING_MS = 1500;
export const SLEEP_MS = 5 * 60_000;

export type CompanionSignals = {
  run: RunStatus["kind"];
  focused: boolean;
  menu: boolean;
  typedAt: number | null;
  lastActivityAt: number;
};

/**
 * Priority: how a run just ended, then what the person is doing right now, then what PI is
 * doing, then attention, then boredom. Typing outranks a running task so a steer is "heard".
 */
export function moodOf(signals: CompanionSignals, now: number): CompanionMood {
  if (signals.run === "completed") return "happy";
  if (signals.run === "failed" || signals.run === "aborted") return "sad";
  if (signals.menu) return "curious";
  if (signals.typedAt !== null && now - signals.typedAt < TYPING_MS) return "listening";
  if (signals.run === "running") return "working";
  if (signals.run === "submitting" || signals.run === "queued") return "thinking";
  if (signals.focused) return "listening";
  if (now - signals.lastActivityAt >= SLEEP_MS) return "sleepy";
  return "idle";
}

/** When the mood can next change without a new signal: typing fades, or boredom sets in. */
function nextDeadline(signals: CompanionSignals, now: number): number | null {
  const deadlines = [signals.typedAt === null ? null : signals.typedAt + TYPING_MS, signals.lastActivityAt + SLEEP_MS]
    .filter((at): at is number => at !== null && at > now);
  return deadlines.length ? Math.min(...deadlines) : null;
}

export function useCompanion(run: RunStatus["kind"], clock: () => number = Date.now) {
  // The clock is read, never subscribed to: a new function each render must not re-run effects.
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const now = useCallback(() => clockRef.current(), []);
  const [signals, setSignals] = useState<Omit<CompanionSignals, "run">>(() => ({ focused: false, menu: false, typedAt: null, lastActivityAt: now() }));
  const [nodKey, setNodKey] = useState(0);
  const [, setTick] = useState(0);

  // A run changing state is activity too: the companion wakes up for it.
  useEffect(() => { setSignals(value => ({ ...value, lastActivityAt: now() })); }, [run, now]);

  const current = { ...signals, run };
  const at = now();
  const deadline = nextDeadline(current, at);
  useEffect(() => {
    if (deadline === null) return;
    const timer = setTimeout(() => setTick(value => value + 1), deadline - at + 16);
    return () => clearTimeout(timer);
  }, [deadline, at]);

  const signal = useCallback((activity: ComposerActivity) => {
    const time = now();
    setSignals(value => {
      const next = { ...value, lastActivityAt: time };
      switch (activity) {
        case "focus": return { ...next, focused: true };
        case "blur": return { ...next, focused: false, menu: false };
        case "type": return { ...next, typedAt: time };
        case "menu-open": return { ...next, menu: true };
        case "menu-close": return { ...next, menu: false };
        case "send": return { ...next, typedAt: null, menu: false };
      }
    });
    if (activity === "send") setNodKey(value => value + 1);
  }, [now]);

  return { mood: moodOf(current, at), nodKey, signal };
}
