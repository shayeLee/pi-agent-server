/**
 * Whether any matching overlay is actually visible. The app keeps a closed native
 * Modal <dialog> mounted, so mere presence in the DOM must never count.
 */
export function hasVisibleOverlay(selector = 'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"]'): boolean {
  return Array.from(document.querySelectorAll(selector)).some(element => {
    if (element.closest('dialog:not([open]), [hidden], [aria-hidden="true"]')) return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  });
}
