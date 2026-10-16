import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { isMarkdownProse, ToolResultText } from "./ToolResultText.js";
import { ToolCallCard } from "./ToolCallCard.js";

describe("tool presentation modes", () => {
  const text = "2/2 finished.\n\n### First result\n\nRead `file.ts`.\n\n- **Result**: complete\n\n### Second result\n\nNo changes.";
  it.each(["subagent", "subagent_wait"])("%s defaults weak prose to Markdown and preserves manual plain across partial/final", toolName => {
    const base = { toolCallId: "agent", toolName, args: {}, done: false, isError: false, result: undefined, partialResult: "## Only heading" };
    const { container, rerender } = render(<ToolCallCard call={base} />);
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    expect(screen.getByRole("heading", { name: "Only heading" })).toBeInTheDocument();
    // Keep expansion through completion, independently of the display preference.
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    fireEvent.click(screen.getByRole("button", { name: "Markdown 展示" }));
    const partial = "- only list\n  exact spaces\n";
    rerender(<ToolCallCard call={{ ...base, partialResult: { content: [{ type: "text", text: partial }] } }} />);
    expect(container.querySelector(".tool-result-text pre")?.textContent).toBe(partial);
    const final = partial + "\n## Final\n";
    rerender(<ToolCallCard call={{ ...base, done: true, result: { content: [{ type: "text", text: final }] } }} />);
    expect(screen.getByRole("button", { name: "Markdown 展示" })).toHaveAttribute("aria-pressed", "false");
    expect(container.querySelector(".tool-result-text pre")?.textContent).toBe(final);
    fireEvent.click(screen.getByRole("button", { name: "Markdown 展示" }));
    expect(screen.getByRole("heading", { name: "Final" })).toBeInTheDocument();
  });
  it.each(["subagent", "subagent_wait"])("%s defaults list-only prose safely and leaves details-only fallback plain", toolName => {
    const base = { toolCallId: "agent", toolName, args: {}, done: false, isError: false, result: undefined };
    const raw = '- only list\n\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n\n![remote](https://example.invalid/tracker.png)';
    const { container, rerender } = render(<ToolCallCard call={{ ...base, partialResult: { content: [{ type: "text", text: raw }], details: { hidden: "## Not prose" } } }} />);
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    expect(container.querySelectorAll("li")).toHaveLength(1);
    expect(container.querySelector("script, img")).toBeNull();
    expect(screen.queryByText("Not prose")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Markdown 展示" }));
    expect(container.querySelector(".tool-result-text pre")?.textContent).toBe(raw);
    const fallback = { details: { text: "## Not prose\n- retained" } };
    rerender(<ToolCallCard call={{ ...base, partialResult: fallback }} />);
    expect(container.querySelector(".markdown")).toBeNull();
    expect(container.querySelector(".tool-result-text pre")?.textContent).toBe(JSON.stringify(fallback, null, 2));
    rerender(<ToolCallCard call={{ ...base, partialResult: { content: [{ type: "image", data: "untrusted" }] } }} />);
    expect(container.querySelector("img, .markdown")).toBeNull();
    expect(screen.getByText(/非文本或未知内容/)).toBeInTheDocument();
  });
  it.each(["any_tool", "subagent_logs", "subagent_status", "write", "edit"])("%s retains generic weak-prose heuristic", toolName => {
    const { container } = render(<ToolCallCard call={{ toolCallId: "generic", toolName, args: {}, done: false, isError: false, result: undefined, partialResult: "## Only heading" }} />);
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    expect(container.querySelector(".markdown")).toBeNull();
    expect(container.querySelector(".tool-result-text pre")?.textContent).toBe("## Only heading");
    expect(isMarkdownProse(text)).toBe(true);
  });
  it("renders generic Markdown without executing HTML; raw text remains reachable", () => {
    const { container } = render(<ToolResultText text={text + '\n\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>'} />);
    expect(screen.getByRole("heading", { name: "First result" })).toBeInTheDocument();
    expect(container.querySelectorAll("li")).toHaveLength(1);
    expect(container.querySelector("script, img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Markdown 展示" }));
    expect(container.querySelector("pre")?.textContent).toContain('<script>alert(1)</script>');
  });
  it("never loads unknown images in automatic or manual Markdown and preserves raw URLs", () => {
    const images = '\n\n![remote](https://example.invalid/tracker.png)\n\n![inline](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)\n\n![relative](/tracker.png)';
    const raw = text + images;
    const { container } = render(<ToolResultText text={raw} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "remote" })).toHaveAttribute("href", "https://example.invalid/tracker.png");
    expect(screen.getByText("inline")).not.toHaveAttribute("href");
    expect(screen.getByRole("link", { name: "relative" })).toHaveAttribute("href", "/tracker.png");
    fireEvent.click(screen.getByRole("button", { name: "Markdown 展示" }));
    expect(container.querySelector("pre")?.textContent).toBe(raw);
    fireEvent.click(screen.getByRole("button", { name: "Markdown 展示" }));
    expect(container.querySelector("img")).toBeNull();
  });
  it("logs stay plain without Markdown controls while explicit code remains highlighted", () => {
    expect(isMarkdownProse("INFO log\n\n### heading\n- item")).toBe(false);
    expect(isMarkdownProse("  aligned   log\nnext line")).toBe(false);
    const rawLog = "  ### literal heading\n- `literal` list\n```bash\necho hi\n```\n  aligned   spaces\n";
    const { container, rerender } = render(<ToolResultText text={rawLog} log />);
    expect(container.querySelector('.code-block[data-language="bash"] pre')?.textContent).toBe(rawLog);
    expect(container.querySelector(".markdown")).toBeNull();
    expect(screen.queryByRole("button", { name: "Markdown 展示" })).not.toBeInTheDocument();
    rerender(<ToolResultText text={rawLog + "\nfinal"} log />);
    expect(container.querySelector("pre")?.textContent).toBe(rawLog + "\nfinal");
    rerender(<ToolResultText text={rawLog} log language="python" />);
    expect(container.querySelector('.code-block[data-language="bash"] pre')?.textContent).toBe(rawLog);
    rerender(<ToolResultText text={text} language="python" />);
    expect(container.querySelector(".markdown")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe(text);
  });
  it("empty parameters are absent while exact result stays readable", () => {
    render(<ToolCallCard call={{ toolCallId: "generic", toolName: "any_tool", args: {}, result: text, partialResult: undefined, done: true, isError: false }} />);
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    expect(screen.queryByRole("region", { name: "参数" })).toBeNull();
    expect(screen.queryByText("无参数")).toBeNull();
    expect(screen.queryByText("参数原始数据")).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Markdown 展示' }));
    expect(screen.getByTestId('tool-result-text').querySelector('pre')?.textContent).toBe(text);
  });
});
