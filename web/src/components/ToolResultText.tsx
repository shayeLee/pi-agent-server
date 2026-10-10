import { useState } from "react";
import { CodeBlock } from "./CodeBlock.js";
import { Icon } from "./Icon.js";
import { Markdown } from "./Markdown.js";

/** Conservative prose signal, not a Markdown parser. Code/log sources opt out. */
export function isMarkdownProse(text: string): boolean {
  return /(?:^|\n\s*\n)#{1,6} [^\n]+/.test(text)
    && (/(?:^|\n)[-*+] \S/.test(text) || /`[^`\n]+`/.test(text))
    && !/(?:^|\n)(?:\d{4}-\d\d-\d\d[T ]|\[?(?:INFO|DEBUG|WARN|ERROR)\b)/.test(text);
}
export type ToolTextFormat = "text" | "markdown";
export function DisplayModeToggle({ markdown, onToggle }: { markdown: boolean; onToggle: () => void }) {
  return <button type="button" className="tool-display-mode" aria-label="Markdown 展示" title={markdown ? "切换原文视图" : "切换 Markdown 视图"} aria-pressed={markdown}
    onClick={onToggle}><Icon name="markdown" /></button>;
}
export function ToolResultText({ text, language, log = false, initialFormat, lineNumbers = false }: { text: string; language?: string; log?: boolean; initialFormat?: ToolTextFormat; lineNumbers?: boolean }) {
  const [mode, setMode] = useState<"text" | "markdown" | null>(null);
  if (log) return <CodeBlock code={text} language="bash" label="输出" emphasizeFail={/^\s*FAIL\b/m.test(text)} />;
  if (language) return <CodeBlock code={text} language={language} lineNumbers={lineNumbers} />;
  const markdown = mode ? mode === "markdown" : initialFormat ? initialFormat === "markdown" : isMarkdownProse(text);
  return <div className="tool-prose">
    <DisplayModeToggle markdown={markdown} onToggle={() => setMode(markdown ? "text" : "markdown")} />
    {markdown ? <Markdown text={text} imagePolicy="link" /> : <pre className="tool-readable-value">{text}</pre>}
  </div>;
}
