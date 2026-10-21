/**
 * One entry the composer offers after `/`. Prompt templates and skills are expanded by Pi on send;
 * extension commands (registered by explicitly loaded Pi extensions) run on the host like built-ins.
 */
export type SessionCommandInfo = {
  name: string;
  source: "builtin" | "prompt" | "skill" | "extension";
  description: string;
  argumentHint?: string;
};

export type SessionCommandList = { commands: SessionCommandInfo[] };

/** Host-executed commands; everything else after `/` is sent as a message. */
export type SessionCommandName = "compact" | "reload" | "extension";
/** `extension` runs the extension command `name` (without the leading `/`) with `args`. */
export type SessionCommandInput = { command: SessionCommandName; args?: string; name?: string };

/** What an extension command showed: its notifications, widgets and status lines, in order. */
export type CommandOutputLine = { level: "info" | "warning" | "error"; text: string };

export type SessionCommandResult =
  | { command: "compact"; tokensBefore: number; tokensAfter?: number }
  | { command: "reload"; contextFiles: number; promptTemplates: number; skills: number; extensions: number }
  | { command: "extension"; name: string; output: CommandOutputLine[] };

/** Dedicated durable record of an extension command run; kept in the session, never sent to the model. */
export type CommandOutputRecord = { version: 1; name: string; args: string; output: CommandOutputLine[]; failed: boolean };

/** Project-relative path suggestion for `@` references; names only, never contents. */
export type ProjectFileEntry = { path: string; kind: "file" | "directory" };
export type ProjectFileSearch = { entries: ProjectFileEntry[]; truncated: boolean };

/**
 * A dialog an extension command opened (select / confirm / input / editor). Every page that can
 * control the session shows it; the first answer wins and the others close it.
 */
export type CommandPrompt = {
  promptId: string;
  /** The command that asked, without the leading `/`. */
  command: string;
  kind: "select" | "confirm" | "input" | "editor";
  title: string;
  /** confirm: the question under the title. */
  message?: string;
  /** select: the choices, answered by value. */
  options?: string[];
  /** input: hint shown in the empty field. */
  placeholder?: string;
  /** editor: starting text. */
  prefill?: string;
  /** Milliseconds since the epoch when the question is dismissed unanswered. */
  expiresAt: number;
};

/** `cancel` answers like closing the dialog; otherwise select/input/editor send `value`, confirm sends `confirmed`. */
export type CommandPromptAnswer = { promptId: string; cancel?: boolean; value?: string; confirmed?: boolean };
