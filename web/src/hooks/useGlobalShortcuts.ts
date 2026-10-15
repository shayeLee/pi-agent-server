import { hasVisibleOverlay } from "../lib/overlays.js";
import { useEffect, useRef } from "react";

export type ShortcutHandlers = {
  palette: () => void;
  help: () => void;
  newSession: () => void;
  search: () => void;
  toggleTrace: () => void;
  toggleSidebar: () => void;
  focusComposer: () => void;
  toggleWork: () => void;
  latest: () => void;
};

/** Typing targets keep every unmodified key. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]'));
}

/** Any visible dialog or menu owns the keyboard. */
const overlayOpen = () => hasVisibleOverlay();

/**
 * Global shortcuts (DESIGN.md §9.1). Single-letter keys work only outside text fields
 * and overlays; modifier shortcuts work everywhere except inside overlays.
 */
export function useGlobalShortcuts(handlers: ShortcutHandlers, enabled = true) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return;
      const h = ref.current;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey && !event.shiftKey) {
        const key = event.key.toLowerCase();
        if (key === "k") { event.preventDefault(); if (!overlayOpen()) h.palette(); return; }
        if (overlayOpen()) return;
        if (key === "i") { event.preventDefault(); h.toggleTrace(); return; }
        if (key === "b") { event.preventDefault(); h.toggleSidebar(); return; }
        return;
      }
      if (mod || event.altKey || isTypingTarget(event.target) || overlayOpen()) return;
      const action = ({ "?": h.help, "/": h.search, n: h.newSession, N: h.newSession, i: h.focusComposer, e: h.toggleWork, End: h.latest } as Record<string, (() => void) | undefined>)[event.key];
      if (event.key === "j" || event.key === "k") { if (moveSessionFocus(event.key === "j" ? 1 : -1)) event.preventDefault(); return; }
      if (!action) return;
      // End inside the transcript is already handled there; elsewhere it jumps to the latest.
      if (event.key === "End" && event.target instanceof Element && event.target.closest("#chat-transcript")) return;
      event.preventDefault();
      action();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/** Roving focus over visible session rows; Enter then activates the focused row. */
export function moveSessionFocus(step: 1 | -1): boolean {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="session-list"] .session-select'))
    .filter(row => !row.closest("[hidden]"));
  if (!rows.length) return false;
  const current = rows.indexOf(document.activeElement as HTMLElement);
  const fallback = rows.findIndex(row => row.getAttribute("aria-current") === "true");
  const from = current >= 0 ? current : fallback >= 0 ? fallback - step : step > 0 ? -1 : rows.length;
  const next = rows[Math.max(0, Math.min(rows.length - 1, from + step))];
  next.focus();
  next.scrollIntoView?.({ block: "nearest" });
  return true;
}
