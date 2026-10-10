import { useMemo, useState, type ReactNode } from "react";
import { Icon } from "./Icon.js";
import { createLowlight } from "lowlight";
import xml from "highlight.js/lib/languages/xml";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";

// Never auto-detect: highlight only explicitly selected languages. Import only these ten grammars.
const highlighter = createLowlight({ xml, javascript, typescript, json, css, bash, python, sql, yaml, markdown });
const aliases: Record<string, string> = { html: "html", htm: "html", xml: "xml", svg: "xml", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", json: "json", css: "css", sh: "bash", zsh: "bash", bash: "bash", py: "python", sql: "sql", yml: "yaml", yaml: "yaml", md: "markdown" };
export function codeLanguage(language?: string): string | undefined {
  const name = language?.trim().toLowerCase();
  if (!name) return undefined;
  const resolved = aliases[name] ?? name;
  return highlighter.registered(resolved) ? resolved : undefined;
}

export function fileCodeLanguage(path?: string): string | undefined {
  return codeLanguage(path?.split(/[\\/]/).pop()?.split(".").slice(1).pop());
}

// Only text and inert spans are emitted; no HAST properties become DOM attributes.
type HighlightNode = ReturnType<typeof highlighter.highlight>["children"][number];
function renderNodes(nodes: HighlightNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.value;
    if (node.type !== "element") return null;
    const children = renderNodes(node.children);
    if (node.tagName !== "span") return children;
    const classes = node.properties.className;
    const className = Array.isArray(classes) ? classes.filter(c => typeof c === "string" && /^(hljs-[\w-]+|[\w-]+_)$/.test(c)).join(" ") : undefined;
    return <span key={index} className={className}>{children}</span>;
  });
}

export const MAX_HIGHLIGHT_LENGTH = 50_000;
const cache = new Map<string, ReactNode[]>();
function highlighted(code: string, language?: string): ReactNode {
  if (!language || code.length > MAX_HIGHLIGHT_LENGTH) return code;
  const key = `${language}\0${code}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const nodes = renderNodes(highlighter.highlight(language, code).children);
    if (cache.size >= 16) cache.delete(cache.keys().next().value!);
    cache.set(key, nodes);
    return nodes;
  } catch { return code; }
}

function failLines(code: string): ReactNode {
  const lines = code.split("\n");
  return lines.map((line, index) => (
    <span key={index} className={/^\s*FAIL\b/.test(line) ? "log-fail" : undefined}>
      {line}{index < lines.length - 1 ? "\n" : ""}
    </span>
  ));
}

export type CodeBlockProps = {
  code: string;
  language?: string;
  copyLabel?: string;
  label?: string;
  lineNumbers?: boolean;
  emphasizeFail?: boolean;
};
export function CodeBlock({ code, language, copyLabel = "复制代码", label, lineNumbers = false, emphasizeFail = false }: CodeBlockProps) {
  const resolved = codeLanguage(language);
  const content = useMemo(
    () => emphasizeFail ? failLines(code) : highlighted(code, resolved),
    [code, resolved, emphasizeFail],
  );
  const lineCount = code.split("\n");
  // Tie feedback to the exact snapshot, not an obsolete streamed value.
  const [copy, setCopy] = useState<{ code: string; message: string } | null>(null);
  return <div className={`code-block${lineNumbers ? " has-line-nums" : ""}`} data-language={resolved ?? "plain"}>
    <div className="code-block-toolbar"><span>{label ?? (resolved ?? (language === "plaintext" ? "plaintext" : "plain"))}</span>
      <button type="button" aria-label={copyLabel} onClick={async () => {
        try { await navigator.clipboard.writeText(code); setCopy({ code, message: "已复制" }); }
        catch { setCopy({ code, message: "复制失败，请选择原文复制" }); }
      }}><Icon name="copy" /></button><span role="status">{copy?.code === code ? copy.message : ""}</span>
    </div>
    <div className="code-block-scroll">
      {lineNumbers && <div className="code-line-nums" aria-hidden="true">{lineCount.map((_, index) => <span key={index}>{index + 1}</span>)}</div>}
      <pre tabIndex={0} aria-label="代码原文"><code>{content}</code></pre>
    </div>
  </div>;
}
