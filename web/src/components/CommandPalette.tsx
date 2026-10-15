import { zhCN } from "../i18n/zh-CN.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogPortal, DialogTitle } from "./ui/dialog.js";

export type Command = {
  id: string;
  label: string;
  group: string;
  /** Shortcut shown on the right, e.g. "⌘I". */
  hint?: string;
  run: () => void;
};

/** ⌘K command palette (DESIGN.md §9.1): type to filter, ↑/↓ to move, Enter to run. */
export function CommandPalette({ open, onOpenChange, commands }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => { if (open) { setQuery(""); setCursor(0); } }, [open]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? commands.filter(command => `${command.label} ${command.group}`.toLowerCase().includes(needle)) : commands;
  }, [commands, query]);
  const active = Math.min(cursor, Math.max(0, filtered.length - 1));
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  const run = (command: Command | undefined) => {
    if (!command) return;
    onOpenChange(false);
    // Let the dialog restore focus first; the command may move focus itself.
    setTimeout(command.run, 0);
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogPortal>
      <DialogContent className="command-palette" data-testid="command-palette" aria-describedby={undefined}>
        <DialogTitle className="sr-only">{zhCN.palette.title}</DialogTitle>
        <DialogDescription className="sr-only">{zhCN.palette.description}</DialogDescription>
        <input className="command-input" data-testid="command-input" autoFocus placeholder={zhCN.palette.placeholder}
          role="combobox" aria-expanded="true" aria-controls="command-list" aria-activedescendant={filtered[active] ? `command-${filtered[active].id}` : undefined}
          value={query} onChange={event => { setQuery(event.target.value); setCursor(0); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown") { event.preventDefault(); setCursor(Math.min(filtered.length - 1, active + 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setCursor(Math.max(0, active - 1)); }
            else if (event.key === "Enter") { event.preventDefault(); run(filtered[active]); }
          }} />
        <ul id="command-list" role="listbox" className="command-list" ref={listRef} aria-label={zhCN.palette.title}>
          {filtered.length === 0 && <li className="command-empty">{zhCN.palette.empty}</li>}
          {filtered.map((command, index) => <li key={command.id} id={`command-${command.id}`} role="option" data-index={index}
            aria-selected={index === active} className={`command-item${index === active ? " is-active" : ""}`}
            onMouseMove={() => setCursor(index)} onClick={() => run(command)}>
            <span className="command-group">{command.group}</span>
            <span className="command-label">{command.label}</span>
            {command.hint && <kbd className="command-hint">{command.hint}</kbd>}
          </li>)}
        </ul>
      </DialogContent>
    </DialogPortal>
  </Dialog>;
}

const actions = zhCN.palette.shortcutActions;
export const SHORTCUTS: Array<[string, string]> = [
  ["⌘K", actions.palette],
  ["N", actions.newSession],
  ["/", actions.search],
  ["j / k", actions.move],
  ["Enter", actions.open],
  ["⌘I", actions.trace],
  ["⌘B", actions.sidebar],
  ["i", actions.input],
  ["e", actions.work],
  ["End", actions.latest],
  ["Esc", actions.escape],
  ["?", actions.help],
];

/** Shortcut reference (DESIGN.md §9.1). */
export function ShortcutHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogPortal>
      <DialogContent className="shortcut-help" data-testid="shortcut-help">
        <DialogTitle className="shortcut-help-title">{zhCN.palette.shortcuts}</DialogTitle>
        <DialogDescription className="sr-only">{zhCN.palette.shortcutsDescription}</DialogDescription>
        <dl className="shortcut-list">
          {SHORTCUTS.map(([keys, action]) => <div key={keys} className="shortcut-row"><dt><kbd>{keys}</kbd></dt><dd>{action}</dd></div>)}
        </dl>
      </DialogContent>
    </DialogPortal>
  </Dialog>;
}
