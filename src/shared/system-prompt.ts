/** Prompt provenance is explicit; live effective does not imply sent to a model. */
export type SessionSystemPrompt =
  | { source: "live_effective" | "creation_snapshot"; prompt: string }
  | { source: "unavailable"; prompt: null };

/** No truthiness checks, truncation, synthetic sections, or unrelated configuration. */
export function projectSystemPrompt(live: string | null | undefined, creation: string | null): SessionSystemPrompt {
  if (typeof live === "string") return { source: "live_effective", prompt: live };
  if (typeof creation === "string") return { source: "creation_snapshot", prompt: creation };
  return { source: "unavailable", prompt: null };
}
