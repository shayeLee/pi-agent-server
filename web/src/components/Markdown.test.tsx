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

  it("keeps images enabled by default and makes the no-load image policy explicit", () => {
    const text = '![photo](https://example.invalid/photo.png)\n\n![unsafe](javascript:alert%281%29)\n\n<img src="x" onerror="alert(1)">';
    const { container, rerender } = render(<Markdown text={text} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.invalid/photo.png");
    rerender(<Markdown text={text} imagePolicy="link" />);
    expect(container.querySelector("img, script")).toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.invalid/photo.png");
    expect(container.querySelectorAll("a")[1]).not.toHaveAttribute("href");
  });

  it("does not turn unsafe links into executable URLs", () => {
    const { container } = render(<Markdown text="[点我](javascript:alert(1))" />);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("");
  });
});
