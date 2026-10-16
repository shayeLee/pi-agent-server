import { useEffect, useState, type RefObject } from "react";

/** Small idle gestures the companion plays on its own between real signals. */
export const ANTICS = ["wave", "hop", "tilt", "peek", "knead", "wiggle", "boing"] as const;
export type Antic = (typeof ANTICS)[number];

const ANTIC_MS = 1600;
const ANTIC_GAP_MIN_MS = 3500;
const ANTIC_GAP_MAX_MS = 8000;
/** How far, in viewBox units, the eyes and face may turn toward the pointer. */
const GAZE_X = 2;
const GAZE_Y = 1.6;

export function prefersReducedMotion(): boolean {
  try { return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false; } catch { return false; }
}

/**
 * Where the eyes look: toward the pointer, saturating a couple of figure-widths away so the
 * gaze settles instead of creeping. Returns viewBox units.
 */
export function gazeOffset(rect: { left: number; top: number; width: number; height: number }, pointer: { x: number; y: number }): [number, number] {
  const dx = pointer.x - (rect.left + rect.width / 2);
  const dy = pointer.y - (rect.top + rect.height * 0.4);
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return [0, 0];
  const reach = Math.min(1, distance / Math.max(1, rect.width * 2));
  return [Number(((dx / distance) * reach * GAZE_X).toFixed(2)), Number(((dy / distance) * reach * GAZE_Y).toFixed(2))];
}

/** Follows the pointer anywhere on the page, at most once a frame, while `enabled`. */
export function useGaze(ref: RefObject<Element | null>, enabled: boolean): [number, number] | null {
  const [gaze, setGaze] = useState<[number, number] | null>(null);
  useEffect(() => {
    if (!enabled) { setGaze(null); return; }
    let frame = 0;
    let pointer: { x: number; y: number } | null = null;
    const update = () => {
      frame = 0;
      const rect = ref.current?.getBoundingClientRect();
      if (rect && pointer) setGaze(gazeOffset(rect, pointer));
    };
    const onMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => { window.removeEventListener("pointermove", onMove); if (frame) cancelAnimationFrame(frame); };
  }, [ref, enabled]);
  return gaze;
}

/** Plays one random antic every few seconds while `enabled`; never the same one twice running. */
export function useAntics(enabled: boolean, random: () => number = Math.random): Antic | null {
  const [antic, setAntic] = useState<Antic | null>(null);
  useEffect(() => {
    if (!enabled) { setAntic(null); return; }
    let last: Antic | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        const choices = ANTICS.filter(item => item !== last);
        last = choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))]!;
        setAntic(last);
        timer = setTimeout(() => { setAntic(null); schedule(); }, ANTIC_MS);
      }, ANTIC_GAP_MIN_MS + random() * (ANTIC_GAP_MAX_MS - ANTIC_GAP_MIN_MS));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [enabled, random]);
  return antic;
}
