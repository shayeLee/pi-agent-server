import type { ProjectFileEntry, SessionCommandInfo, SessionCommandInput } from "pi-agent-server/client";

/** The token under the caret that a menu completes, as Pi's editor reads it. */
export type CompletionToken =
  | { kind: "command"; query: string; start: number; end: number }
  | { kind: "file"; query: string; start: number; end: number };

/**
 * `/name` only as the first token of the message (Pi runs commands from the start of the
 * editor); `@path` anywhere after whitespace. `@"…"` quotes a path with spaces.
 */
export function completionToken(text: string, caret: number): CompletionToken | null {
  const before = text.slice(0, caret);
  const command = /^\/(\S*)$/.exec(before);
  if (command) return { kind: "command", query: command[1]!, start: 0, end: caret };
  const file = /(?:^|\s)@("[^"]*|[^\s"]*)$/.exec(before);
  if (!file) return null;
  const start = caret - file[1]!.length - 1;
  return { kind: "file", query: file[1]!.replace(/^"/, ""), start, end: caret };
}

/** `@path`, quoted when it contains whitespace. Directories keep the menu open on their children. */
export function fileReference(entry: ProjectFileEntry): string {
  const value = entry.kind === "directory" ? `${entry.path}/` : entry.path;
  return /\s/.test(value) ? `@"${value}"` : `@${value}`;
}

export function applyCompletion(text: string, token: CompletionToken, replacement: string, trailingSpace: boolean): { text: string; caret: number } {
  const after = text.slice(token.end);
  const insert = trailingSpace && !after.startsWith(" ") ? `${replacement} ` : replacement;
  return { text: text.slice(0, token.start) + insert + after, caret: token.start + insert.length };
}

/** Prefix matches first, then other substring matches, each in the server's order. */
export function filterCommands(commands: readonly SessionCommandInfo[], query: string): SessionCommandInfo[] {
  const needle = query.toLowerCase();
  const prefix = commands.filter(command => command.name.toLowerCase().startsWith(needle));
  const inner = commands.filter(command => !command.name.toLowerCase().startsWith(needle) && command.name.toLowerCase().includes(needle));
  return [...prefix, ...inner];
}

/** The host runs `/compact [instructions]` and `/reload`; any other text is a message. */
export function hostCommand(text: string): SessionCommandInput | null {
  const match = /^\/(compact|reload)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const args = match[2]?.trim();
  return match[1] === "compact" ? { command: "compact", ...(args ? { args } : {}) } : { command: "reload" };
}
