import { zhCN } from "../../i18n/zh-CN.js";
import type { CompanionMood } from "./companion-mood.js";

export type CompanionStyle = "concise" | "lively" | "formal";
export type CompanionPersona = { name: string; style: CompanionStyle; docked: boolean };

export const DEFAULT_PERSONA: CompanionPersona = { name: zhCN.companion.defaultName, style: "lively", docked: true };
const STORAGE_KEY = "pi.companion";
const MAX_NAME = 12;

/** This browser's copy of the persona: the server's when it has one, otherwise what was set here; `null` when nothing was. */
export function readStoredPersona(): CompanionPersona | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<CompanionPersona> | null;
    if (!raw || typeof raw !== "object") return null;
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, MAX_NAME) : DEFAULT_PERSONA.name;
    const style = raw.style === "concise" || raw.style === "formal" || raw.style === "lively" ? raw.style : DEFAULT_PERSONA.style;
    return { name, style, docked: raw.docked !== false };
  } catch { return null; }
}

/** Unavailable storage just means the defaults. */
export function readPersona(): CompanionPersona {
  return readStoredPersona() ?? DEFAULT_PERSONA;
}

export function writePersona(persona: CompanionPersona): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(persona)); } catch { /* storage unavailable */ }
}

export function normalizeName(name: string): string {
  return name.trim().slice(0, MAX_NAME) || DEFAULT_PERSONA.name;
}

export type DayPart = "dawn" | "morning" | "noon" | "afternoon" | "evening" | "night";
export function dayPart(hour: number): DayPart {
  if (hour < 5) return "night";
  if (hour < 8) return "dawn";
  if (hour < 11) return "morning";
  if (hour < 14) return "noon";
  if (hour < 18) return "afternoon";
  if (hour < 23) return "evening";
  return "night";
}

export type OpeningContext = {
  persona: CompanionPersona;
  now: Date;
  projectName: string | null;
  recent: { title: string; updatedAt: number } | null;
  commandCount: number | null;
};

const pick = <T,>(items: readonly T[], random: () => number): T => items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;

const HOUR = 3_600_000;
function ago(ms: number): string {
  if (ms < HOUR) return zhCN.companion.agoMinutes;
  if (ms < 24 * HOUR) return zhCN.companion.agoHours(Math.floor(ms / HOUR));
  return zhCN.companion.agoDays(Math.floor(ms / (24 * HOUR)));
}

/**
 * The welcome the companion says on a blank session: a greeting for the time of day in its
 * own voice, then one line drawn from where the person left off or what this project offers.
 * Random choice is injected so a given context and seed always read the same.
 */
export function openingLines(context: OpeningContext, random: () => number = Math.random): { greeting: string; hint: string } {
  const voice = zhCN.companion.voices[context.persona.style];
  const project = context.projectName ?? zhCN.companion.thisProject;
  const greeting = pick(voice.greetings[dayPart(context.now.getHours())], random)(project);
  const hints: string[] = [];
  if (context.recent) {
    const title = context.recent.title.trim().slice(0, 24) || zhCN.companion.untitled;
    hints.push(voice.resume(title, ago(Math.max(0, context.now.getTime() - context.recent.updatedAt))));
  }
  if (context.commandCount) hints.push(voice.commands(context.commandCount));
  hints.push(voice.files);
  return { greeting, hint: pick(hints, random) };
}

/** A short line for the docked companion's tooltip, in its voice. */
export function moodLine(persona: CompanionPersona, mood: CompanionMood): string {
  return `${persona.name}：${zhCN.companion.voices[persona.style].moods[mood]}`;
}
