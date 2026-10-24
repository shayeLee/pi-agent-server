import { useEffect, useRef, useState } from "react";
import type { ActivityEvent } from "pi-agent-server/client";
import { accountScopedKey } from "../auth/storage-scope.js";
import { zhCN } from "../i18n/zh-CN.js";

/** One notification per session within this window. */
export const NOTIFY_SESSION_GAP_MS = 10_000;
const STORAGE_KEY = "pi:companion-notify";

/** `insecure`: a plain-http address such as a LAN IP, where browsers refuse notifications. */
export type NotifyPermission = "unsupported" | "insecure" | "default" | "granted" | "denied";

function permission(): NotifyPermission {
  try {
    if (window.isSecureContext === false) return "insecure";
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  } catch { return "unsupported"; }
}

function readEnabled(): boolean {
  try { return localStorage.getItem(accountScopedKey(STORAGE_KEY)) === "on"; } catch { return false; }
}

function writeEnabled(on: boolean): void {
  try { localStorage.setItem(accountScopedKey(STORAGE_KEY), on ? "on" : "off"); } catch { /* Storage is optional. */ }
}

function pageHidden(): boolean {
  try { return document.visibilityState !== "visible"; } catch { return false; }
}

/**
 * System notifications for runs that end while this page is not in front
 * (docs/companion-butler.md §6.2): completed or failed only, at most one per session every
 * NOTIFY_SESSION_GAP_MS. Off by default and kept per browser, because the browser's own
 * permission is per browser too; switching it on asks for that permission.
 */
export function useRunNotifications(latest: ActivityEvent | null, options: { name: string; onOpen: (projectId: string, sessionId: string) => void }) {
  const [enabled, setEnabled] = useState(readEnabled);
  const [state, setState] = useState<NotifyPermission>(permission);
  const lastShown = useRef(new Map<string, number>());
  const onOpen = useRef(options.onOpen);
  onOpen.current = options.onOpen;
  const on = enabled && state === "granted";

  useEffect(() => {
    if (!on || !latest || (latest.kind !== "completed" && latest.kind !== "failed") || !pageHidden()) return;
    const previous = lastShown.current.get(latest.sessionId);
    if (previous !== undefined && latest.at - previous < NOTIFY_SESSION_GAP_MS) return;
    lastShown.current.set(latest.sessionId, latest.at);
    const title = latest.title || zhCN.companion.untitled;
    try {
      const notification = new Notification(zhCN.companion.notification[latest.kind](title), {
        body: latest.kind === "failed" && latest.message ? latest.message : options.name,
        tag: `pi-run-${latest.sessionId}`,
      });
      notification.onclick = () => {
        try { window.focus(); } catch { /* Focus is best effort. */ }
        onOpen.current(latest.projectId, latest.sessionId);
        notification.close();
      };
    } catch { /* Some browsers only allow notifications from a service worker. */ }
  }, [latest, on]);

  async function toggle(next: boolean): Promise<void> {
    if (!next) { setEnabled(false); writeEnabled(false); return; }
    let current = permission();
    if (current === "default") {
      try { current = await Notification.requestPermission(); } catch { current = permission(); }
    }
    setState(current);
    const granted = current === "granted";
    setEnabled(granted);
    writeEnabled(granted);
  }

  return { enabled: on, permission: state, toggle };
}
