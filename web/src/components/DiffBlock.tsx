import { zhCN } from "../i18n/zh-CN.js";
import { useMemo, useState } from "react";
import { Modal } from "./Modal.js";
import { CodeBlock } from "./CodeBlock.js";

export type DiffLine = { kind: "context" | "delete" | "add"; text: string };
// Include line endings in comparisons, so final-newline and CRLF changes are real changes.
function lines(text: string): string[] { return text.match(/[^\n]*\n|[^\n]+$/g) ?? []; }
export function fragmentDiff(oldText: string, newText: string): DiffLine[] | null {
  if (oldText.length + newText.length > 100_000) return null;
  const a = lines(oldText), b = lines(newText);
  if ((a.length + 1) * (b.length + 1) > 250_000) return null;
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    table[i * width + j] = a[i] === b[j] ? 1 + table[(i + 1) * width + j + 1] : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  }
  const result: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) result.push({ kind: "context", text: a[i++] }), j++;
    else if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) result.push({ kind: "delete", text: a[i++] });
    else result.push({ kind: "add", text: b[j++] });
  }
  return result;
}

export function DiffBlock({ oldText, newText, language }: { oldText: string; newText: string; language?: string }) {
  const diff = useMemo(() => fragmentDiff(oldText, newText), [oldText, newText]);
  const [rawOpen, setRawOpen] = useState(false);
  return <div className="diff-block" aria-label={zhCN.diff.scope}>
    {diff === null ? <><p role="status">{zhCN.diff.tooLarge}</p><button type="button" className="tool-raw-link" onClick={() => setRawOpen(true)}>{zhCN.diff.showOriginal}</button></> : <>
      {oldText === newText && <p className="diff-status">{zhCN.diff.identical}</p>}
      {diff.length > 0 && <pre className="diff-lines" tabIndex={0} aria-label={zhCN.diff.legend}><code>{diff.map((line, index) => <span key={index} className={`diff-line diff-${line.kind}`}><span aria-hidden="true">{line.kind === "delete" ? "-" : line.kind === "add" ? "+" : " "} </span>{line.text.endsWith("\n") ? line.text : <>{line.text}{"\n"}</>}</span>)}</code></pre>}
    </>}
    {diff === null && <Modal open={rawOpen} onClose={() => setRawOpen(false)} title={zhCN.diff.original}>
      <div className="json-label">oldText</div>
      <CodeBlock code={oldText} language={language} copyLabel={zhCN.diff.copyBefore} />
      <div className="json-label">newText</div>
      <CodeBlock code={newText} language={language} copyLabel={zhCN.diff.copyAfter} />
    </Modal>}
  </div>;
}
