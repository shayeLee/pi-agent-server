import { zhCN } from "../i18n/zh-CN.js";
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

const DIFF_LANGUAGES = new Set(["diff", "patch", "udiff"]);
const DIFF_HEADER = /^(diff |index |--- |\+\+\+ |@@)/;
/**
 * A diff by label, or an unlabelled block every non-empty line of which is a diff line
 * (+, -, space context, @@ hunk, "\ No newline", file headers) with both additions and
 * deletions present. Strict on purpose: ordinary text must never turn red and green.
 */
export function isDiff(code: string, language?: string): boolean {
  const name = language?.trim().toLowerCase();
  if (name && DIFF_LANGUAGES.has(name)) return true;
  if (name && name !== "plain" && name !== "plaintext" && name !== "text") return false;
  const lines = code.split("\n").filter(line => line.trim());
  if (lines.length < 2) return false;
  let adds = 0, dels = 0;
  for (const line of lines) {
    if (DIFF_HEADER.test(line) || line.startsWith("\\")) continue;
    if (line.startsWith("+")) adds++;
    else if (line.startsWith("-")) dels++;
    else if (!line.startsWith(" ")) return false;
  }
  return adds > 0 && dels > 0;
}

function diffLines(code: string): ReactNode {
  return code.split("\n").map((line, index) => {
    const kind = line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ") ? "diff-hunk"
      : line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-delete" : "";
    // Each line is its own block row; an empty line keeps one space so it keeps its height.
    return <span key={index} className={`diff-line${kind ? ` ${kind}` : ""}`}>{line || " "}</span>;
  });
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

export type CodeBlockProps = { code: string; language?: string; copyLabel?: string };
export function CodeBlock({ code, language, copyLabel = zhCN.code.copy }: CodeBlockProps) {
  const diff = useMemo(() => isDiff(code, language), [code, language]);
  const resolved = diff ? undefined : codeLanguage(language);
  const content = useMemo(() => diff ? diffLines(code) : highlighted(code, resolved), [code, resolved, diff]);
  // Tie feedback to the exact snapshot, not an obsolete streamed value.
  const [copy, setCopy] = useState<{ code: string; message: string } | null>(null);
  return <div className="code-block" data-language={diff ? "diff" : resolved ?? "plain"}>
    <div className="code-block-toolbar"><span>{diff ? "diff" : resolved ?? (language === "plaintext" ? "plaintext" : "plain")}</span>
      <button type="button" aria-label={copyLabel} onClick={async () => {
        try { await navigator.clipboard.writeText(code); setCopy({ code, message: zhCN.code.copied }); }
        catch { setCopy({ code, message: zhCN.code.copyFailed }); }
      }}><Icon name="copy" /></button><span role="status">{copy?.code === code ? copy.message : ""}</span>
    </div>
    <pre tabIndex={0} aria-label={zhCN.code.original}><code>{content}</code></pre>
  </div>;
}
