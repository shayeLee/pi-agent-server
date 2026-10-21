import { zhCN } from "../i18n/zh-CN.js";
import { useState } from "react";
import { ApiError, type ChatState, type CommandPrompt, type CommandPromptAnswer } from "pi-agent-server/client";

const text = zhCN.commandPrompt;

/**
 * A dialog an extension command opened, shown above the composer of every page that has the session
 * open. Whoever answers first wins; the others keep the question, marked as answered elsewhere, until
 * the command's output arrives. Viewers see the question but cannot answer it.
 */
export function CommandPromptPanel({ entry, canAnswer, onAnswer }: {
  entry: NonNullable<ChatState["commandPrompt"]>;
  canAnswer: boolean;
  onAnswer: (answer: CommandPromptAnswer) => Promise<void>;
}) {
  const { prompt } = entry;
  /** The question this page answered; its own closed event must not read as "elsewhere". */
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<{ promptId: string; message: string } | null>(null);
  const mine = sent === prompt.promptId;
  const closed = entry.closed === "answered" || (error?.promptId === prompt.promptId && error.message === text.answeredElsewhere);

  async function answer(patch: Omit<CommandPromptAnswer, "promptId">) {
    setSent(prompt.promptId);
    setError(null);
    try {
      await onAnswer({ promptId: prompt.promptId, ...patch });
    } catch (failure) {
      setSent(null);
      setError({ promptId: prompt.promptId, message: failure instanceof ApiError && failure.status === 409 ? text.answeredElsewhere
        : text.failed(failure instanceof Error ? failure.message.replace(/^HTTP \d+: /, "") : String(failure)) });
    }
  }

  return <section className="command-prompt" data-testid="command-prompt" data-kind={prompt.kind} aria-label={text.label(prompt.command)}>
    <div className="command-prompt-head">
      <span className="command-prompt-command">/{prompt.command}</span>
      <span className="command-prompt-title">{prompt.title}</span>
    </div>
    {prompt.message && <p className="command-prompt-message">{prompt.message}</p>}
    {closed || mine
      ? <p className="command-prompt-note" role="status">{mine ? text.sent : text.answeredElsewhere}</p>
      : !canAnswer
        ? <p className="command-prompt-note">{text.readOnly}</p>
        : <PromptControls key={prompt.promptId} prompt={prompt} onAnswer={answer} />}
    {error && error.promptId === prompt.promptId && error.message !== text.answeredElsewhere
      && <p className="command-prompt-error" role="alert">{error.message}</p>}
  </section>;
}

function PromptControls({ prompt, onAnswer }: { prompt: CommandPrompt; onAnswer: (patch: Omit<CommandPromptAnswer, "promptId">) => void }) {
  const [value, setValue] = useState(prompt.prefill ?? "");
  const cancel = <button type="button" className="command-prompt-action" data-testid="command-prompt-cancel" onClick={() => onAnswer({ cancel: true })}>{text.cancel}</button>;
  if (prompt.kind === "select") {
    return <div className="command-prompt-options" role="group" aria-label={prompt.title}>
      {/* No autofocus on choices: an Enter still meant for the composer must not pick one. */}
      {prompt.options?.map(option => <button key={option} type="button" className="command-prompt-option" data-testid="command-prompt-option"
        onClick={() => onAnswer({ value: option })}>{option}</button>)}
      {cancel}
    </div>;
  }
  if (prompt.kind === "confirm") {
    return <div className="command-prompt-actions">
      <button type="button" className="command-prompt-action is-primary" data-testid="command-prompt-confirm" onClick={() => onAnswer({ confirmed: true })}>{text.confirm}</button>
      <button type="button" className="command-prompt-action" data-testid="command-prompt-deny" onClick={() => onAnswer({ confirmed: false })}>{text.deny}</button>
    </div>;
  }
  return <form className="command-prompt-form" onSubmit={event => { event.preventDefault(); onAnswer({ value }); }}>
    {prompt.kind === "editor"
      ? <textarea className="command-prompt-input" data-testid="command-prompt-input" rows={6} autoFocus value={value} aria-label={prompt.title}
        onChange={event => setValue(event.target.value)} />
      : <input className="command-prompt-input" data-testid="command-prompt-input" autoFocus autoComplete="off" spellCheck={false} value={value}
        placeholder={prompt.placeholder} aria-label={prompt.title} onChange={event => setValue(event.target.value)} />}
    <div className="command-prompt-actions">
      <button type="submit" className="command-prompt-action is-primary">{text.submit}</button>
      {cancel}
    </div>
  </form>;
}
