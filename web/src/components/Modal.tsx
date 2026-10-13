import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon.js";

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
};

let locks = 0;
let previousOverflow = "";
function lockScroll() {
  if (locks++ === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  return () => { if (--locks === 0) document.body.style.overflow = previousOverflow; };
}

/** Native top-layer modal: browser inertness, with explicit keyboard boundary wrapping. */
export function Modal({ open, onClose, title, children, footer }: ModalProps) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const outsideDown = useRef(false);
  useLayoutEffect(() => {
    if (!open) return;
    const element = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    const unlock = lockScroll();
    close.current?.focus({ preventScroll: true });
    return () => {
      outsideDown.current = false;
      element.close();
      unlock();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);
  const outside = (x: number, y: number) => {
    const rect = dialog.current!.getBoundingClientRect();
    return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
  };
  return <dialog ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onPointerDown={event => { outsideDown.current = event.target === event.currentTarget && outside(event.clientX, event.clientY); }}
    onPointerCancel={() => { outsideDown.current = false; }}
    onClick={event => {
      const dismiss = outsideDown.current && event.target === event.currentTarget && outside(event.clientX, event.clientY);
      outsideDown.current = false;
      if (dismiss) onClose();
    }}
    onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); return; }
      if (event.key !== "Tab") return;
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')).filter(el => el.getClientRects().length > 0 && !el.closest('[inert]'));
      const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    {open && <>
      <header className="modal-header"><h2 id={titleId}>{title}</h2><button ref={close} type="button" className="modal-close" aria-label="关闭对话框" onClick={onClose}><Icon name="close" size={20} /></button></header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-footer">{footer}</footer>}
    </>}
  </dialog>;
}
