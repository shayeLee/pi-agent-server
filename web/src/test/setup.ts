import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// jsdom has no native top-layer implementation; real inertness/Tab are browser-tested.
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };

// jsdom does not lay out elements; actual ResizeObserver geometry is covered
// by the workspace browser suite, including wrapping and breakpoint changes.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// vitest 默认 globals:false，RTL 不会自动注册 afterEach(cleanup)，
// 这里手动保证每个测试之间卸载组件、清理 DOM。
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});