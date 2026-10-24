import { useEffect, useRef, useState } from "react";
import type { ActivityEvent, ActivityResult } from "pi-agent-server/client";
import { zhCN } from "../i18n/zh-CN.js";
import type { CompanionPersona } from "../components/companion/companion-lines.js";
import type { CompanionMood } from "../components/companion/companion-mood.js";

/** How long the companion's word on another session stays up; long enough to click. */
export const ELSEWHERE_BUBBLE_MS = 6000;

export type ElsewhereResult = ActivityResult & { kind: "completed" | "failed" };
/** Another session that just ended, and what opens it. */
export type Elsewhere = { result: ElsewhereResult; open: () => void };

function pageVisible(): boolean {
  try { return document.visibilityState === "visible"; } catch { return true; }
}

/**
 * Another session just completed or failed while this page is in front: the companion says so
 * for ELSEWHERE_BUBBLE_MS (docs/companion-butler.md §6.1). The session on screen already shows its
 * own end, so it is skipped. Opening it, or the time running out, takes the word away.
 */
export function useElsewhereBubble(latest: ActivityEvent | null, activeSessionId: string | null,
  onOpen: (projectId: string, sessionId: string) => void): Elsewhere | null {
  const [result, setResult] = useState<ElsewhereResult | null>(null);
  // A run starting elsewhere must not cut the word short, so the timer outlives `latest`.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!latest || (latest.kind !== "completed" && latest.kind !== "failed") || latest.sessionId === activeSessionId || !pageVisible()) return;
    setResult(latest as ElsewhereResult);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult(null), ELSEWHERE_BUBBLE_MS);
  }, [latest]);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Opening that session elsewhere (the sidebar, a notification) also ends the word.
  useEffect(() => { if (result && result.sessionId === activeSessionId) setResult(null); }, [activeSessionId]);
  if (!result) return null;
  return { result, open: () => { clearTimeout(timer.current); setResult(null); onOpen(result.projectId, result.sessionId); } };
}

export function elsewhereLine(persona: CompanionPersona, result: ElsewhereResult): string {
  return zhCN.companion.voices[persona.style].elsewhere[result.kind](result.title || zhCN.companion.untitled);
}

/** A resting companion looks pleased or let down with the news; one busy with this session keeps its face. */
export function elsewhereMood(mood: CompanionMood, elsewhere: Elsewhere | null | undefined): CompanionMood {
  if (!elsewhere || (mood !== "idle" && mood !== "sleepy")) return mood;
  return elsewhere.result.kind === "completed" ? "happy" : "sad";
}
