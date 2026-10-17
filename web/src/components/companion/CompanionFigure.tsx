import { useRef } from "react";
import { prefersReducedMotion, useAntics, useGaze } from "./companion-life.js";
import type { CompanionMood } from "./companion-mood.js";

const star = (x: number, y: number, r: number) => `M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z`;
const SPARKLES = [star(7, 18, 2.4), star(58, 26, 2), star(54, 9, 1.5)];
/** Below this size the face keeps only what still reads: bigger eyes and the mouth, no blush, catchlights or nose. */
const SMALL_SIZE = 64;

/**
 * One continuous outline: two rounded ears, no neck, a sitting body a touch wider than the
 * head. A single soft shape is what makes a mascot read as cute at any size.
 */
const SILHOUETTE = "M32 13.4C29.6 13.4 27.4 13.7 25.6 14.3C23.6 12.4 21.2 9.9 19.6 8.9Q17.6 7.8 17.4 10C17 13.6 16.6 17.4 16 21.4"
  + "C13.8 25.6 12.8 30.6 12.8 36C12.8 45 13.6 51.6 16.6 55C18.4 57.2 20.8 58 24 58H40C43.2 58 45.6 57.2 47.4 55"
  + "C50.4 51.6 51.2 45 51.2 36C51.2 30.6 50.2 25.6 48 21.4C47.4 17.4 47 13.6 46.6 10Q46.4 7.8 44.4 8.9"
  + "C42.8 9.9 40.4 12.4 38.4 14.3C36.6 13.7 34.4 13.4 32 13.4Z";

/**
 * The companion (DESIGN.md §6.6): an original line-drawn cat in the Ledger's own line
 * language — one stroke weight, currentColor only, solid fills only for eyes, nose and an
 * open mouth. The sprout between its ears is the "soul": it sways at rest, turns accent
 * while PI works, and droops when a run fails. Moving parts are classes so the motion lives
 * in CSS; the two living behaviours (eyes on the pointer, idle antics) are off under reduced
 * motion and when `alive` is false.
 */
export function CompanionFigure({ mood, size, pulse = null, alive = true }: {
  mood: CompanionMood;
  size: number;
  /** A one-shot reaction: `nod` after a send, `boop` when poked. A new key replays it. */
  pulse?: { key: number; kind: "nod" | "boop" } | null;
  alive?: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const living = alive && !prefersReducedMotion();
  const watching = living && (mood === "idle" || mood === "curious");
  const gaze = useGaze(ref, watching);
  const antic = useAntics(living && mood === "idle");
  const [gx, gy] = watching && gaze ? gaze : [0, 0];
  const small = size < SMALL_SIZE;
  return <svg ref={ref} className="companion-figure" data-mood={mood} data-antic={antic ?? undefined} data-size={small ? "small" : undefined} width={size} height={size}
    viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false">
    {/* Remounting the group replays the one-shot reaction. */}
    <g key={pulse?.key ?? 0} className={pulse ? `companion-body is-${pulse.kind}` : "companion-body"}>
      <g className="companion-lean">
        <path className="companion-tail" d="M48 55.6c4.8.5 8.6-2.2 9.1-6.5c.4-3.3-1.6-5.6-4.1-5.2" />
        <g className="companion-sprout">
          <path d="M32 13.6c.1-1.2.1-2.4.1-3.4" />
          <path className="companion-leaf" d="M32.1 10.2C31.2 7 33 4.6 36.6 3.4C37 6.6 35.6 9.2 32.1 10.2Z" />
        </g>
        {/* Raised paws sit behind the outline and come out to wave or cheer. */}
        <path className="companion-raise companion-raise-left" d="M13.4 40.6c-3.4-1.2-5.6-3.9-6-7.4c-.3-2.3 2.1-3.3 3.6-1.6" />
        <path className="companion-raise companion-raise-right" d="M50.6 40.6c3.4-1.2 5.6-3.9 6-7.4c.3-2.3-2.1-3.3-3.6-1.6" />
        <path className="companion-outline" d={SILHOUETTE} fill="var(--bg)" />
        <path className="companion-paw companion-paw-left" d="M24.2 58c0-2.7 1.4-4.2 3.2-4.2s3.2 1.5 3.2 4.2" />
        <path className="companion-paw companion-paw-right" d="M33.4 58c0-2.7 1.4-4.2 3.2-4.2s3.2 1.5 3.2 4.2" />
        {/* The face turns a little toward the pointer, and the eyes a little more. */}
        <g className="companion-gaze" style={{ transform: `translate(${gx * 0.5}px, ${gy * 0.5}px)` }}>
          <Face mood={mood} gaze={[gx * 0.6, gy * 0.6]} small={small} />
        </g>
      </g>
    </g>
    {mood === "happy" && <g className="companion-sparkles" stroke="none">{SPARKLES.map(d => <path key={d} d={d} />)}</g>}
    {mood === "thinking" && <g className="companion-dots" stroke="none" fill="currentColor">
      <circle cx="51" cy="12" r="1.4" /><circle cx="55.5" cy="8.5" r="1.4" /><circle cx="60" cy="5" r="1.4" />
    </g>}
    {mood === "sleepy" && <path className="companion-z" d="M51.5 2.5h5l-5 6h5" strokeWidth="1.4" />}
  </svg>;
}

/** One open eye: a solid dot with a page-coloured catchlight, which is most of what makes it look alive. */
function Eye({ x, y, scale = 1, shine = true }: { x: number; y: number; scale?: number; shine?: boolean }) {
  const rx = 2.4 * scale, ry = 2.8 * scale;
  return <g className="companion-eye">
    <ellipse cx={x} cy={y} rx={rx} ry={ry} fill="currentColor" stroke="none" />
    {shine && <>
      <circle className="companion-shine" cx={x - rx * 0.3} cy={y - ry * 0.4} r={rx * 0.42} stroke="none" />
      <circle className="companion-shine" cx={x + rx * 0.35} cy={y + ry * 0.4} r={rx * 0.16} stroke="none" />
    </>}
  </g>;
}

/** How much bigger the open eyes are drawn at small size. */
const SMALL_EYES = 1.3;

const EYE_L = 25;
const EYE_R = 39;
const EYE_Y = 33.4;
const FULL_NOSE = <path className="companion-nose" d="M31 36.1h2l-1 1.1Z" fill="currentColor" strokeWidth="0.8" />;
/** The cat's little "ω". */
const MOUTH = <path d="M29.6 38.1c.7.9 1.7.9 2.4 0c.7.9 1.7.9 2.4 0" strokeWidth="1.4" />;
/** Manga blush: three short strokes under each eye. */
const FULL_BLUSH = <path className="companion-blush" d="M18.6 39.6l1.1-1.6M20.6 39.6l1.1-1.6M22.6 39.6l1.1-1.6M41.3 39.6l1.1-1.6M43.3 39.6l1.1-1.6M45.3 39.6l1.1-1.6" strokeWidth="1" />;

function Face({ mood, gaze: [gx, gy], small }: { mood: CompanionMood; gaze: [number, number]; small: boolean }) {
  const grow = small ? SMALL_EYES : 1;
  const eyes = (left = 1, right = 1) => <g className="companion-eyes-gaze" style={{ transform: `translate(${gx}px, ${gy}px)` }}>
    <g className="companion-eyes"><Eye x={EYE_L} y={EYE_Y} scale={left * grow} shine={!small} /><Eye x={EYE_R} y={EYE_Y} scale={right * grow} shine={!small} /></g>
  </g>;
  const blush = small ? null : FULL_BLUSH;
  const nose = small ? null : FULL_NOSE;
  switch (mood) {
    case "happy":
      return <g className="companion-face" data-blush="strong">
        {blush}
        <path d="M22.2 34.2c1-2.6 4.6-2.6 5.6 0M36.2 34.2c1-2.6 4.6-2.6 5.6 0" strokeWidth="2" />
        {nose}
        <path d="M29.4 38c.6 2.9 4.6 2.9 5.2 0Z" fill="currentColor" strokeWidth="1.2" />
      </g>;
    case "sad":
      return <g className="companion-face">
        <path d="M22 30.4l4.4-1.4M42 30.4l-4.4-1.4" strokeWidth="1.4" />
        {eyes(0.85, 0.85)}
        {nose}
        <path d="M30.2 39.6c1.1-1.1 2.5-1.1 3.6 0" strokeWidth="1.4" />
      </g>;
    case "sleepy":
      return <g className="companion-face">
        {blush}
        <path d="M22.2 33.4c1 1.5 4.6 1.5 5.6 0M36.2 33.4c1 1.5 4.6 1.5 5.6 0" strokeWidth="2" />
        {nose}
        <ellipse cx="32" cy="39" rx="0.8" ry="1" fill="currentColor" stroke="none" />
      </g>;
    case "curious":
      return <g className="companion-face">
        {blush}
        {eyes(1.18, 0.9)}
        {nose}
        <ellipse cx="32" cy="39.2" rx="1.1" ry="1.3" strokeWidth="1.3" />
      </g>;
    default: {
      // idle, listening, thinking, working: eyes open; the mouth says which.
      const mouth = mood === "working" ? <path d="M30.6 38.5h2.8" strokeWidth="1.4" />
        : mood === "thinking" ? <path d="M29.8 38.8c.7-.7 1.5-.7 2.2 0s1.5.7 2.2 0" strokeWidth="1.3" />
        : MOUTH;
      return <g className="companion-face">{mood === "working" ? null : blush}{eyes()}{nose}{mouth}</g>;
    }
  }
}
