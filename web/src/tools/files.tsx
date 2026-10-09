import { CodeBlock, codeLanguage, fileCodeLanguage } from "../components/CodeBlock.js";
import { ParameterFields, Parameters, Result } from "./generic.js";
import { record } from "./summary-data.js";
import { DiffBlock } from "../components/DiffBlock.js";
import type { ArgumentsProps, ResultProps } from "./contract.js";

function argumentLanguage(value: unknown): string | undefined {
  const args = record(value);
  return typeof args.language === "string" ? codeLanguage(args.language) : typeof args.path === "string" ? fileCodeLanguage(args.path) : undefined;
}
export function WriteArguments({ value }: ArgumentsProps) {
  const args = record(value);
  if (typeof args.path !== "string" || typeof args.content !== "string") return <Parameters value={value} />;
  const extra = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "path" && key !== "content"));
  return <section className="json-block" aria-label="参数">
    <CodeBlock code={args.content} language={argumentLanguage(value) ?? "plaintext"} />
    {Object.keys(extra).length > 0 && <ParameterFields value={extra} />}
  </section>;
}
export function EditArguments({ value }: ArgumentsProps) {
  const args = record(value);
  const isEdit = (item: unknown): item is Record<string, unknown> & { oldText: string; newText: string } =>
    item !== null && typeof item === "object" && !Array.isArray(item)
    && typeof record(item).oldText === "string" && typeof record(item).newText === "string";
  const batch = Array.isArray(args.edits) && args.edits.length > 0 && args.edits.every(isEdit);
  const single = isEdit(value) && !("edits" in args);
  // Malformed batches stay generic in full; no invalid item or field is discarded.
  if ((!batch && !single) || typeof args.path !== "string") return <Parameters value={value} />;
  const edits = batch ? args.edits as (Record<string, unknown> & { oldText: string; newText: string })[] : [args as Record<string, unknown> & { oldText: string; newText: string }];
  const extra = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "path" && (batch ? key !== "edits" : key !== "oldText" && key !== "newText")));
  const extraFields = (fields: Record<string, unknown>) => Object.keys(fields).length > 0 ? <ParameterFields value={fields} /> : null;
  return <section className="json-block" aria-label="参数">
    {edits.map((edit, index) => <div key={index}>
      <DiffBlock oldText={edit.oldText} newText={edit.newText} language={argumentLanguage(value)} />
      {batch && extraFields(Object.fromEntries(Object.entries(edit).filter(([key]) => key !== "oldText" && key !== "newText")))}
    </div>)}
    {extraFields(extra)}
  </section>;
}
export function ReadResult(props: ResultProps) {
  const args = record(props.args);
  return <Result {...props} language={text => typeof args.language === "string" ? codeLanguage(args.language)
    : argumentLanguage(props.args) ?? (/^\s*(?:<!doctype\s+html\b[^>]*>\s*)?<html(?:\s|>)/i.test(text) ? "html" : undefined)} />;
}
