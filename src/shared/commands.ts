/** One entry the composer offers after `/`. Prompt templates and skills are expanded by Pi on send. */
export type SessionCommandInfo = {
  name: string;
  source: "builtin" | "prompt" | "skill";
  description: string;
  argumentHint?: string;
};

export type SessionCommandList = { commands: SessionCommandInfo[] };

/** Host-executed commands; everything else after `/` is sent as a message. */
export type SessionCommandName = "compact" | "reload";
export type SessionCommandInput = { command: SessionCommandName; args?: string };

export type SessionCommandResult =
  | { command: "compact"; tokensBefore: number; tokensAfter?: number }
  | { command: "reload"; contextFiles: number; promptTemplates: number; skills: number; extensions: number };

/** Project-relative path suggestion for `@` references; names only, never contents. */
export type ProjectFileEntry = { path: string; kind: "file" | "directory" };
export type ProjectFileSearch = { entries: ProjectFileEntry[]; truncated: boolean };
