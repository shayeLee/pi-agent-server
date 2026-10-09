import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CodeBlock, MAX_HIGHLIGHT_LENGTH } from "./CodeBlock.js";
import { Markdown } from "./Markdown.js";
import { ToolCallCard } from "./ToolCallCard.js";
import type { ToolCall } from "pi-agent-server/client";

describe("CodeBlock", () => {
  it.each([['html', '<!doctype html>\n<html><script>window.pwned=1</script><img onerror="alert(1)"></html>\n'], ['ts', 'const x: string = "hi";\n'], ['json', '{"ok":true}\n']])("highlights %s without changing source", (language, code) => {
    const { container } = render(<CodeBlock code={code} language={language} />);
    expect(container.querySelector("pre")?.textContent).toBe(code);
    expect(container.querySelector("span[class^=hljs-]")).not.toBeNull();
    expect(container.querySelector("script, img, iframe")).toBeNull();
  });
  it.each([undefined, "unknown", "plaintext"])("keeps %s plain", language => {
    const code = "日志 const x = 1\n\n";
    const { container } = render(<CodeBlock code={code} language={language} />);
    expect(container.querySelector("pre")?.textContent).toBe(code);
    expect(container.querySelector(".hljs-keyword")).toBeNull();
  });
  it("bounds highlighting, never text", () => {
    const code = 'const x = "' + 'a'.repeat(MAX_HIGHLIGHT_LENGTH) + '";\n';
    const { container } = render(<CodeBlock code={code} language="ts" />);
    expect(container.querySelector("pre")?.textContent).toBe(code);
    expect(container.querySelector(".hljs-keyword")).toBeNull();
  });
  it("copies exact bytes, reports failure and clears feedback on a new snapshot", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const code = "  <html>\r\n</html>\n\n";
    const { rerender } = render(<CodeBlock code={code} language="html" />);
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    await screen.findByText("已复制");
    expect(writeText).toHaveBeenCalledWith(code);
    rerender(<CodeBlock code="new\n" language="html" />);
    expect(screen.getByRole("status")).toHaveTextContent("");
    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    await screen.findByText("复制失败，请选择原文复制");
  });
  it("Markdown leaves inline code intact and keeps fenced trailing newlines", () => {
    const { container } = render(<Markdown text={'Inline `const x`\n\n```ts\nconst x = 1;\n\n```\n'} />);
    expect(container.querySelector("p code")?.textContent).toBe("const x");
    expect(container.querySelector(".code-block pre")?.textContent).toBe("const x = 1;\n\n");
    expect(container.querySelector("pre pre")).toBeNull();
  });
});

const call: ToolCall = { toolCallId: "code", toolName: "read", args: { path: "/tmp/index.html" }, done: false, isError: false, partialResult: undefined, result: undefined };
describe("tool code language and snapshots", () => {
  it("uses path, preserves block order, replaces snapshots, retains raw access", () => {
    const result = (text: string) => ({ content: [{ type: "text", text }, { type: "text", text: "<footer>end</footer>\n" }] });
    const { container, rerender } = render(<ToolCallCard call={{ ...call, partialResult: result("<html>\n") }} />);
    expect(screen.getByRole("button", { name: /工具调用/ })).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector('.tool-result-text .code-block')?.getAttribute("data-language")).toBe("html");
    rerender(<ToolCallCard call={{ ...call, partialResult: result("<html>\n<body>second</body>\n") }} />);
    expect(Array.from(container.querySelectorAll(".tool-result-text pre"), p => p.textContent)).toEqual(["<html>\n<body>second</body>\n", "<footer>end</footer>\n"]);
    fireEvent.click(screen.getByRole("button", { name: "工具更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "查看原始数据" }));
    expect(JSON.parse(container.querySelector('dialog[open] pre')!.textContent!).partialResult).toEqual(result("<html>\n<body>second</body>\n"));
  });
  it.each([
    [{ path: "unknown.log" }, "plain prose const true", undefined],
    [{ path: "unknown" }, "<!doctype html>\n<html lang='en'>\n", "html"],
    [{ path: "code.ts" }, 'const x: number = 1;\n', "typescript"],
    [{ path: "data.json" }, '{"ok":true}\n', "json"],
    [{ path: "x.html", language: "unknown" }, '<html>\n', undefined],
  ])("uses conservative hints %j", (args, text, language) => {
    const { container } = render(<ToolCallCard call={{ ...call, args, partialResult: text }} />);
    expect(screen.getByRole("button", { name: /工具调用/ })).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".tool-result-text .code-block")?.getAttribute("data-language")).toBe(language);
    expect(container.querySelector(".tool-result-text pre")?.textContent).toBe(text);
  });
  it("uses bash CodeBlock for both command and inert log output", () => {
    const { container } = render(<ToolCallCard call={{ ...call, toolName: "bash", args: { command: 'echo "hi"\n' }, partialResult: 'const true log\n' }} />);
    expect(screen.getByRole("button", { name: /工具调用/ })).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".tool-parameters .code-block")?.getAttribute("data-language")).toBe("bash");
    expect(container.querySelector(".tool-result-text .code-block")?.getAttribute("data-language")).toBe("bash");
    expect(container.querySelector(".tool-result-text pre")?.textContent).toBe('const true log\n');
  });
});
