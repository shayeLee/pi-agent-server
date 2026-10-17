import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CompanionGreeting, CompanionGreetingInput, SessionCommandInfo } from "pi-agent-server/client";
import type { RunStatus } from "../../hooks/useRunStatus.js";
import { zhCN } from "../../i18n/zh-CN.js";
import { CompanionFigure } from "./CompanionFigure.js";
import type { CompanionMood } from "./companion-mood.js";
import { dayPart, moodLine, normalizeName, openingLines, readPersona, readStoredPersona, writePersona, type CompanionPersona, type CompanionStyle } from "./companion-lines.js";

const QUICK_START_LIMIT = 3;
/** How long the companion "thinks" before it speaks its own line instead; a late reply is dropped. */
export const GREETING_WAIT_MS = 5000;
/** A line that comes back sooner than this (a cached one) appears without the thinking dots flashing first. */
export const PENDING_SHOW_MS = 400;
/** How long the docked companion has to sit quietly before it asks for the next blank session's line. */
export const PREFETCH_DELAY_MS = 2000;
/** How long the docked companion's word on a finished run stays up. */
export const BUBBLE_MS = 3000;
const STYLES: CompanionStyle[] = ["concise", "lively", "formal"];

/** Reads and writes the persona the server keeps for this person. */
export type CompanionPersonaSync = {
  load: () => Promise<CompanionPersona | null>;
  save: (persona: CompanionPersona) => Promise<void>;
};

/**
 * Starts from this browser's copy so the figure never waits, then takes the server's persona
 * unless the person already changed it here. A persona set in this browser before the server
 * kept one is carried up once. Saves go out in order, so the last change wins; a failed save
 * keeps the change in this browser.
 */
export function useCompanionPersona(sync?: CompanionPersonaSync): [CompanionPersona, (next: CompanionPersona) => void] {
  const [persona, setPersona] = useState(readPersona);
  const touched = useRef(false);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const save = (next: CompanionPersona) => {
    if (!sync) return;
    saving.current = saving.current.then(() => sync.save(next)).catch(() => undefined);
  };
  useEffect(() => {
    if (!sync) return;
    let current = true;
    sync.load().then(remote => {
      if (!current || touched.current) return;
      if (remote) { setPersona(remote); writePersona(remote); return; }
      const local = readStoredPersona();
      if (local) save(local);
    }, () => undefined);
    return () => { current = false; };
  }, [sync]);
  return [persona, next => { touched.current = true; setPersona(next); writePersona(next); save(next); }];
}

type Pulse = { key: number; kind: "nod" | "boop" };
/** Nods on each send (a new nodKey) and squishes when poked; the latest one plays. */
function usePulse(nodKey: number): [Pulse | null, () => void] {
  const [pulse, setPulse] = useState<Pulse | null>(null);
  useEffect(() => { if (nodKey) setPulse(value => ({ key: (value?.key ?? 0) + 1, kind: "nod" })); }, [nodKey]);
  return [pulse, () => setPulse(value => ({ key: (value?.key ?? 0) + 1, kind: "boop" }))];
}

/** Small seeded generator: one welcome per visit, stable across re-renders. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type CompanionWelcomeProps = {
  mood: CompanionMood;
  nodKey: number;
  persona: CompanionPersona;
  onPersona: (persona: CompanionPersona) => void;
  projectId: string | null;
  projectName: string | null;
  /** The latest session in this project; `undefined` while the list is still loading. */
  recent: { title: string; updatedAt: number } | null | undefined;
  loadCommands?: () => Promise<SessionCommandInfo[]>;
  /** Asks the model for the opening line; without it, or when it fails or is slow, local lines are used. */
  generateLines?: (input: CompanionGreetingInput) => Promise<CompanionGreeting>;
  /** Puts `/name ` in the editor; the person still presses Enter. */
  onQuickStart?: (text: string) => void;
  now?: () => Date;
  seed?: number;
};

/** The blank session's host (DESIGN.md §6.6): the figure, what it says, and where to start. */
export function CompanionWelcome({ mood, nodKey, persona, onPersona, projectId, projectName, recent, loadCommands, generateLines, onQuickStart,
  now = () => new Date(), seed: suppliedSeed }: CompanionWelcomeProps) {
  const [seed] = useState(() => suppliedSeed ?? Math.floor(Math.random() * 2 ** 32));
  const [commands, setCommands] = useState<{ projectId: string | null; list: SessionCommandInfo[] } | null>(null);
  const [editing, setEditing] = useState(false);
  const [pulse, boop] = usePulse(nodKey);
  const editorId = useId();

  useEffect(() => {
    if (!loadCommands) return;
    let current = true;
    loadCommands().then(list => { if (current) setCommands({ projectId, list }); }, () => { if (current) setCommands({ projectId, list: [] }); });
    return () => { current = false; };
  }, [loadCommands, projectId]);
  const list = commands?.projectId === projectId ? commands.list.filter(command => command.source !== "builtin") : null;

  // Waits for the command count so the line does not change under the reader.
  const local = useMemo(() => list === null && loadCommands ? null
    : openingLines({ persona, now: now(), projectName, recent: recent ?? null, commandCount: list?.length ?? null }, seeded(seed)),
  [persona.style, persona.name, projectName, recent?.title, recent?.updatedAt, list?.length, seed]);
  const generated = useGeneratedLines(generateLines, projectId, persona, recent, now);
  // The model's line when it came in time, otherwise ours; nothing while it is still thinking.
  const lines = generated.state === "ready" ? generated.lines : generated.state === "pending" ? null : local;
  const thinking = useAfter(generated.state === "pending", PENDING_SHOW_MS);

  return <div className="companion-welcome" data-testid="companion-welcome">
    <div className="companion-stage">
      <button type="button" className="companion-avatar" data-mood={mood} aria-expanded={editing} aria-controls={editorId}
        aria-label={zhCN.companion.edit(persona.name)} title={zhCN.companion.edit(persona.name)} onClick={() => { boop(); setEditing(value => !value); }}>
        <CompanionFigure mood={thinking && mood === "idle" ? "thinking" : mood} size={128} pulse={pulse} />
      </button>
      <div className="companion-speech" aria-live="polite">
        <span className="companion-name">{persona.name}</span>
        {/* Holds the room of a greeting and a hint, so nothing below moves when the words arrive. */}
        <div className="companion-lines">
          {lines ? <>
            <p className="companion-greeting">{lines.greeting}</p>
            <p className="companion-hint">{lines.hint}</p>
          </> : thinking && <p className="companion-greeting companion-pending" aria-label={zhCN.companion.thinking}>
            <span /><span /><span />
          </p>}
        </div>
      </div>
    </div>
    {editing && <PersonaEditor id={editorId} persona={persona} onChange={onPersona} onDone={() => setEditing(false)} />}
    {onQuickStart && list && list.length > 0 && <div className="companion-quick" role="group" aria-label={zhCN.companion.quickStart}>
      {list.slice(0, QUICK_START_LIMIT).map(command => <button key={command.name} type="button" className="companion-chip"
        title={command.description || undefined} onClick={() => onQuickStart(`/${command.name} `)}>/{command.name}</button>)}
    </div>}
  </div>;
}

/** True once `on` has held for `ms`; false again as soon as it stops. */
function useAfter(on: boolean, ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setLate(true), ms);
    return () => { clearTimeout(timer); setLate(false); };
  }, [on, ms]);
  return on && late;
}

/** What the model is told about this moment; the blank page and the early ask send the same. */
function greetingInput(persona: CompanionPersona, recent: { title: string; updatedAt: number } | null, at: Date): CompanionGreetingInput {
  return {
    persona: { name: persona.name, style: persona.style },
    dayPart: dayPart(at.getHours()),
    recent: recent ? { title: recent.title.slice(0, 200), minutesAgo: Math.max(0, Math.floor((at.getTime() - recent.updatedAt) / 60_000)) } : null,
  };
}

/** The server caches a line per these recency buckets, so asking again inside one costs nothing. */
function recencyBucket(minutes: number): string {
  if (minutes < 60) return "m";
  if (minutes < 24 * 60) return `h${Math.floor(minutes / 60)}`;
  return `d${Math.floor(minutes / (24 * 60))}`;
}

/**
 * Asks for the next blank session's line ahead of time while the person works in a session of
 * the same project, so the server's cache already holds it when they open a blank one. Waits
 * until no run is in flight and nothing has changed for PREFETCH_DELAY_MS, and asks at most
 * once per situation; the reply itself is not kept here.
 */
export function usePrefetchGreeting(generate: CompanionWelcomeProps["generateLines"], projectId: string | null, persona: CompanionPersona,
  recent: CompanionWelcomeProps["recent"], quiet: boolean, now: () => Date = () => new Date()) {
  const asked = useRef(new Set<string>());
  const at = now();
  const input = generate && projectId && quiet && recent !== undefined ? greetingInput(persona, recent, at) : null;
  const key = input ? JSON.stringify([projectId, input.persona, input.dayPart, input.recent && [input.recent.title, recencyBucket(input.recent.minutesAgo)]]) : null;
  useEffect(() => {
    if (!generate || !input || key === null || asked.current.has(key)) return;
    const timer = setTimeout(() => {
      asked.current.add(key);
      generate(input).catch(() => undefined);
    }, PREFETCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [key]);
}

type Generated = { state: "off" | "pending" | "fallback" } | { state: "ready"; lines: CompanionGreeting };

/**
 * One request per persona, project and recent session. Waits at most GREETING_WAIT_MS; after
 * that the local line stays, so the words never change while someone is reading them.
 */
function useGeneratedLines(generate: CompanionWelcomeProps["generateLines"], projectId: string | null, persona: CompanionPersona,
  recent: CompanionWelcomeProps["recent"], now: () => Date): Generated {
  // The wait starts with the page; the request only once the session list is in, so a list
  // that is still loading does not cost a second request (and one that never loads still times out).
  const waitKey = generate && projectId ? JSON.stringify([projectId, persona.name, persona.style]) : null;
  const key = waitKey !== null && recent !== undefined ? JSON.stringify([waitKey, recent?.title ?? null, recent?.updatedAt ?? null]) : null;
  const [expired, setExpired] = useState<string | null>(null);
  const expiredRef = useRef<string | null>(null);
  const [result, setResult] = useState<{ key: string; value: Generated } | null>(null);
  useEffect(() => {
    if (waitKey === null) return;
    const timer = setTimeout(() => { expiredRef.current = waitKey; setExpired(waitKey); }, GREETING_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waitKey]);
  useEffect(() => {
    if (!generate || key === null || waitKey === null) return;
    let current = true;
    // A reply after the wait is dropped: the local line is already on screen.
    const settle = (value: Generated) => { if (current && expiredRef.current !== waitKey) setResult({ key, value }); };
    generate(greetingInput(persona, recent ?? null, now()))
      .then(lines => settle({ state: "ready", lines }), () => settle({ state: "fallback" }));
    return () => { current = false; };
  }, [key]);
  if (waitKey === null) return { state: "off" };
  if (key !== null && result?.key === key) return result.value;
  return expired === waitKey ? { state: "fallback" } : { state: "pending" };
}

function PersonaEditor({ id, persona, onChange, onDone }: { id: string; persona: CompanionPersona; onChange: (persona: CompanionPersona) => void; onDone: () => void }) {
  const [name, setName] = useState(persona.name);
  const commit = () => { onChange({ ...persona, name: normalizeName(name) }); onDone(); };
  return <form id={id} className="companion-editor" data-testid="companion-editor" onSubmit={event => { event.preventDefault(); commit(); }}>
    <label className="companion-field">
      <span>{zhCN.companion.nameLabel}</span>
      <input value={name} maxLength={12} autoFocus onChange={event => setName(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onDone(); } }} />
    </label>
    <div className="companion-field" role="radiogroup" aria-label={zhCN.companion.styleLabel}>
      <span aria-hidden="true">{zhCN.companion.styleLabel}</span>
      {STYLES.map(style => <button key={style} type="button" role="radio" aria-checked={persona.style === style} className="companion-style"
        onClick={() => onChange({ ...persona, name: normalizeName(name), style })}>{zhCN.companion.styles[style]}</button>)}
    </div>
    <button type="submit" className="companion-done">{zhCN.companion.done}</button>
  </form>;
}

function pageVisible(): boolean {
  try { return document.visibilityState === "visible"; } catch { return true; }
}

/**
 * How a run this page watched just ended, for BUBBLE_MS: only completed or failed (an abort is
 * the person's own doing), and only if the page is in front when it ends — nothing is saved up
 * for later. The next run, or another session, takes it down at once.
 */
function useRunBubble(run: RunStatus["kind"]): "completed" | "failed" | null {
  const [bubble, setBubble] = useState<"completed" | "failed" | null>(null);
  useEffect(() => {
    if ((run !== "completed" && run !== "failed") || !pageVisible()) return;
    setBubble(run);
    const timer = setTimeout(() => setBubble(null), BUBBLE_MS);
    return () => { clearTimeout(timer); setBubble(null); };
  }, [run]);
  return bubble;
}

/**
 * The companion docked beside the transcript: mood only, its words on hover and, for a moment,
 * on how a run ended; it can be sent away.
 */
export function CompanionDock({ mood, run, nodKey, persona, onPersona }: {
  mood: CompanionMood;
  run: RunStatus["kind"];
  nodKey: number;
  persona: CompanionPersona;
  onPersona: (persona: CompanionPersona) => void;
}) {
  const [pulse] = usePulse(nodKey);
  const bubble = useRunBubble(run);
  if (!persona.docked) {
    return <button type="button" className="companion-dock is-away" data-testid="companion-dock" aria-label={zhCN.companion.show(persona.name)}
      title={zhCN.companion.show(persona.name)} onClick={() => onPersona({ ...persona, docked: true })}>
      <span className="companion-dock-dot" />
    </button>;
  }
  const line = moodLine(persona, mood);
  return <button type="button" className="companion-dock" data-testid="companion-dock" data-mood={mood}
    aria-label={`${line} ${zhCN.companion.hide(persona.name)}`} title={line} onClick={() => onPersona({ ...persona, docked: false })}>
    {/* The run state badge already says this for assistive tech. */}
    {bubble && <span className="companion-bubble" data-testid="companion-bubble" data-kind={bubble} aria-hidden="true">
      {zhCN.companion.voices[persona.style].bubbles[bubble]}
    </span>}
    <CompanionFigure mood={mood} size={44} pulse={pulse} />
  </button>;
}
