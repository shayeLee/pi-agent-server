import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// vitest 默认 globals:false，RTL 不会自动注册 afterEach(cleanup)，
// 这里手动保证每个测试之间卸载组件、清理 DOM。
afterEach(() => {
  cleanup();
});