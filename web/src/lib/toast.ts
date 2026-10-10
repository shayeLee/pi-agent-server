import { useSyncExternalStore } from "react";

export type ToastTone = "error" | "info" | "success";
export type Toast = { id: number; tone: ToastTone; title: string; description?: string };

const DISMISS_MS: Record<ToastTone, number> = { error: 8000, info: 4000, success: 3000 };
let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(next: readonly Toast[]): void {
  toasts = next;
  for (const listener of listeners) listener();
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  emit(toasts.filter((toast) => toast.id !== id));
}

/** Transient UI feedback only; never a substitute for server-confirmed state. */
export function toast(tone: ToastTone, title: string, description?: string): number {
  const duplicate = toasts.find((item) => item.tone === tone && item.title === title && item.description === description);
  if (duplicate) dismissToast(duplicate.id);
  const id = nextId++;
  emit([...toasts, { id, tone, title, ...(description ? { description } : {}) }].slice(-4));
  timers.set(id, setTimeout(() => dismissToast(id), DISMISS_MS[tone]));
  return id;
}

export function toastError(title: string, error?: unknown): number {
  const description = error === undefined ? undefined : error instanceof Error ? error.message : String(error);
  return toast("error", title, description);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const snapshot = () => toasts;

export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function resetToastsForTest(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  emit([]);
}
