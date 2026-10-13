import { useEffect, useRef, useState, type ReactNode } from "react";
import { Popover, PopoverAnchor, PopoverContent, PopoverArrow } from "./popover.js";

/** Hover details with actions: a non-modal popover, since tooltips cannot contain controls. */
export function InteractiveTooltip({ children, content, label, delayDuration = 250 }: {
  children: ReactNode;
  content: ReactNode;
  label: string;
  /** Mouse hover delay in milliseconds. Explicit keyboard/touch actions open immediately. */
  delayDuration?: number;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const panel = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const clear = () => clearTimeout(timer.current);
  const closeLater = () => { clear(); timer.current = setTimeout(() => { if (!panel.current?.contains(document.activeElement)) setOpen(false); }, 200); };
  useEffect(() => () => clearTimeout(timer.current), []);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverAnchor asChild>
      <span ref={anchor} className="interactive-tooltip-anchor"
        onPointerEnter={event => { if (event.pointerType === "mouse") { clear(); timer.current = setTimeout(() => setOpen(true), delayDuration); } }}
        onPointerLeave={closeLater}
        onFocus={event => { if (event.target.matches(":focus-visible")) { clear(); setOpen(true); } }}
        onBlur={event => { if (!panel.current?.contains(event.relatedTarget)) closeLater(); }}
        onContextMenu={event => { event.preventDefault(); clear(); setOpen(true); }}
        onKeyDown={event => {
          if (!open && event.key === "ArrowDown") { event.preventDefault(); clear(); setOpen(true); return; }
          if (open && (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey))) {
            const action = panel.current?.querySelector<HTMLButtonElement>("button");
            if (action) { event.preventDefault(); clear(); action.focus(); }
          }
          if (open && event.key === "Escape") { event.stopPropagation(); clear(); setOpen(false); }
        }}>
        {children}
      </span>
    </PopoverAnchor>
    <PopoverContent ref={panel} side="bottom" align="start" sideOffset={8} collisionPadding={12}
      className="interactive-tooltip-content" aria-label={label}
      onOpenAutoFocus={event => event.preventDefault()}
      onCloseAutoFocus={event => event.preventDefault()}
      onPointerEnter={clear} onPointerLeave={closeLater}
      onFocus={clear}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) closeLater(); }}
      onEscapeKeyDown={event => { event.stopPropagation(); anchor.current?.querySelector<HTMLButtonElement>("button")?.focus(); }}>
      <div className="interactive-tooltip-body">{content}</div>
      <PopoverArrow asChild width={14} height={7}>
        <svg className="interactive-tooltip-arrow" width="14" height="7" viewBox="0 0 14 7" aria-hidden="true">
          <path className="interactive-tooltip-arrow-fill" d="M0 -1H14V0L8 6Q7 7 6 6L0 0Z" />
          <path className="interactive-tooltip-arrow-edge" d="M0 0L6 6Q7 7 8 6L14 0" />
        </svg>
      </PopoverArrow>
    </PopoverContent>
  </Popover>;
}
