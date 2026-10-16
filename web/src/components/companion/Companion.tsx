import { useEffect, useId, useMemo, useState } from "react";
import type { SessionCommandInfo } from "pi-agent-server/client";
import { zhCN } from "../../i18n/zh-CN.js";
import { CompanionFigure } from "./CompanionFigure.js";
import type { CompanionMood } from "./companion-mood.js";
import { moodLine, normalizeName, openingLines, readPersona, writePersona, type CompanionPersona, type CompanionStyle } from "./companion-lines.js";

const QUICK_START_LIMIT = 3;
const STYLES: CompanionStyle[] = ["concise", "lively", "formal"];

export function useCompanionPersona(): [CompanionPersona, (next: CompanionPersona) => void] {
  const [persona, setPersona] = useState(readPersona);
  return [persona, next => { setPersona(next); writePersona(next); }];
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
  recent: { title: string; updatedAt: number } | null;
  loadCommands?: () => Promise<SessionCommandInfo[]>;
  /** Puts `/name ` in the editor; the person still presses Enter. */
  onQuickStart?: (text: string) => void;
  now?: () => Date;
  seed?: number;
};

/** The blank session's host (DESIGN.md §6.6): the figure, what it says, and where to start. */
export function CompanionWelcome({ mood, nodKey, persona, onPersona, projectId, projectName, recent, loadCommands, onQuickStart,
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
  const lines = useMemo(() => list === null && loadCommands ? null
    : openingLines({ persona, now: now(), projectName, recent, commandCount: list?.length ?? null }, seeded(seed)),
  [persona.style, persona.name, projectName, recent?.title, recent?.updatedAt, list?.length, seed]);

  return <div className="companion-welcome" data-testid="companion-welcome">
    <div className="companion-stage">
      <button type="button" className="companion-avatar" data-mood={mood} aria-expanded={editing} aria-controls={editorId}
        aria-label={zhCN.companion.edit(persona.name)} title={zhCN.companion.edit(persona.name)} onClick={() => { boop(); setEditing(value => !value); }}>
        <CompanionFigure mood={mood} size={128} pulse={pulse} />
      </button>
      <div className="companion-speech" aria-live="polite">
        <span className="companion-name">{persona.name}</span>
        {lines && <>
          <p className="companion-greeting">{lines.greeting}</p>
          <p className="companion-hint">{lines.hint}</p>
        </>}
      </div>
    </div>
    {editing && <PersonaEditor id={editorId} persona={persona} onChange={onPersona} onDone={() => setEditing(false)} />}
    {onQuickStart && list && list.length > 0 && <div className="companion-quick" role="group" aria-label={zhCN.companion.quickStart}>
      {list.slice(0, QUICK_START_LIMIT).map(command => <button key={command.name} type="button" className="companion-chip"
        title={command.description} onClick={() => onQuickStart(`/${command.name} `)}>
        <span className="companion-chip-name">/{command.name}</span>
        {command.description && <span className="companion-chip-detail">{command.description}</span>}
      </button>)}
    </div>}
  </div>;
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

/** The companion docked beside the transcript: mood only, its words on hover, and it can be sent away. */
export function CompanionDock({ mood, nodKey, persona, onPersona }: { mood: CompanionMood; nodKey: number; persona: CompanionPersona; onPersona: (persona: CompanionPersona) => void }) {
  const [pulse] = usePulse(nodKey);
  if (!persona.docked) {
    return <button type="button" className="companion-dock is-away" data-testid="companion-dock" aria-label={zhCN.companion.show(persona.name)}
      title={zhCN.companion.show(persona.name)} onClick={() => onPersona({ ...persona, docked: true })}>
      <span className="companion-dock-dot" />
    </button>;
  }
  const line = moodLine(persona, mood);
  return <button type="button" className="companion-dock" data-testid="companion-dock" data-mood={mood}
    aria-label={`${line} ${zhCN.companion.hide(persona.name)}`} title={line} onClick={() => onPersona({ ...persona, docked: false })}>
    <CompanionFigure mood={mood} size={36} pulse={pulse} />
  </button>;
}
