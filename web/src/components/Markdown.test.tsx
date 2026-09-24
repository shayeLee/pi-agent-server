import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "./Markdown";

describe("Markdown used by ops viewer", () => {
  it("renders headings, GFM tables and code without executing raw HTML", () => {
    const { container } = render(<Markdown text={'# 标题\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1\n```\n\n<script>alert(1)</script>'} />);
    expect(container.querySelector("h1")?.textContent).toBe("标题");
    expect(container.querySelector("table td")?.textContent).toBe("1");
    expect(container.querySelector("pre code")?.textContent).toContain("const x = 1");
    expect(container.querySelector("script")).toBeNull();
  });

  it("does not turn unsafe links into executable URLs", () => {
    const { container } = render(<Markdown text="[点我](javascript:alert(1))" />);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("");
  });
});
