import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFollowBottom } from "./useFollowBottom.js";

/** A ResizeObserver the test fires by hand (jsdom has none). */
let resized: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
});
afterEach(() => { vi.unstubAllGlobals(); resized = undefined; });

/** A scroll container whose metrics the test controls; scrollTop clamps like a browser. */
function container(height: number, viewport: number) {
  const el = document.createElement("div");
  let top = height - viewport;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => viewport });
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = Math.min(value, height - viewport); } });
  return { el, grow: (value: number) => { height = value; act(() => resized?.()); }, at: (value: number) => { top = value; } };
}

it("a navigation scroll that starts near the bottom is not pulled back down while the list resizes", () => {
  const box = container(10_000, 500);
  const hook = renderHook(({ key, navigation }) => useFollowBottom(key, "content", true, navigation),
    { initialProps: { key: "mount", navigation: undefined as unknown } });
  (hook.result.current.ref as { current: HTMLDivElement }).current = box.el;
  // Attach to the element (a session key change), following from the bottom.
  hook.rerender({ key: "session", navigation: undefined });
  const navigation = { id: 1 };
  hook.rerender({ key: "session", navigation });
  // First frames of the smooth scroll are still within reach of the bottom, and the list grows
  // right then (navigation renders every skipped entry): the scroll must keep its course.
  box.at(10_000 - 500 - 10); act(() => hook.result.current.onScroll());
  box.grow(12_000);
  expect(box.el.scrollTop).toBe(10_000 - 500 - 10);
  box.at(3_000); act(() => hook.result.current.onScroll());
  box.grow(12_100);
  expect(box.el.scrollTop).toBe(3_000);
  box.el.dispatchEvent(new Event("scrollend"));
  // After the navigation, reaching the bottom by hand resumes following as before.
  box.at(12_100 - 500); act(() => hook.result.current.onScroll());
  box.grow(12_400);
  expect(box.el.scrollTop).toBe(12_400 - 500);
});
