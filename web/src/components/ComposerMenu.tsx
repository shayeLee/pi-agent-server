import { useEffect, useRef } from "react";
import type { ProjectFileEntry, SessionCommandInfo } from "pi-agent-server/client";
import { zhCN } from "../i18n/zh-CN.js";
import { Icon } from "./Icon.js";

export type ComposerMenuItem =
  | { kind: "command"; command: SessionCommandInfo }
  | { kind: "file"; entry: ProjectFileEntry };

export const COMPOSER_MENU_ID = "composer-menu";
export const composerOptionId = (index: number) => `composer-menu-option-${index}`;

/** `@` file / `/` command suggestions above the editor; keyboard stays in the textarea. */
export function ComposerMenu({ items, active, status, onPick, onHover }: {
  items: ComposerMenuItem[];
  active: number;
  /** Shown instead of options while loading or when nothing matches. */
  status: string | null;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`#${composerOptionId(active)}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, items]);
  return <div className="composer-menu" data-testid="composer-menu" data-open="true">
    {status ? <div className="composer-menu-status" role="status">{status}</div> :
      <div ref={listRef} id={COMPOSER_MENU_ID} role="listbox" aria-label={zhCN.composer.menuLabel} className="composer-menu-options">
        {items.map((item, index) => {
          const selected = index === active;
          const common = { id: composerOptionId(index), role: "option", "aria-selected": selected, className: "composer-menu-option",
            // mousedown keeps focus (and the caret) in the textarea.
            onMouseDown: (event: React.MouseEvent) => { event.preventDefault(); onPick(index); }, onMouseEnter: () => onHover(index) } as const;
          if (item.kind === "file") {
            const slash = item.entry.path.lastIndexOf("/");
            return <div key={`f:${item.entry.path}`} {...common} data-kind="file">
              <Icon name={item.entry.kind === "directory" ? "folder" : "file"} size={13} className="composer-menu-icon" />
              <span className="composer-menu-name">{item.entry.path.slice(slash + 1)}{item.entry.kind === "directory" ? "/" : ""}</span>
              {slash > 0 && <span className="composer-menu-detail">{item.entry.path.slice(0, slash)}</span>}
            </div>;
          }
          const { command } = item;
          return <div key={`c:${command.name}`} {...common} data-kind="command">
            <span className="composer-menu-name">/{command.name}</span>
            {command.argumentHint && <span className="composer-menu-hint">{command.argumentHint}</span>}
            <span className="composer-menu-detail">{command.description}</span>
            {command.source !== "builtin" && <span className="composer-menu-source">{zhCN.composer.commandSource[command.source]}</span>}
          </div>;
        })}
      </div>}
  </div>;
}
