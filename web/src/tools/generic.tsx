import { zhCN } from "../i18n/zh-CN.js";
import type { ReactNode } from "react";
import type { ResultProps } from "./contract.js";
import { stringify } from "./raw.js";
import { CodeBlock, codeLanguage } from "../components/CodeBlock.js";
import { record } from "./summary-data.js";
import { DiffBlock } from "../components/DiffBlock.js";
import { ToolResultText, type ToolTextFormat } from "../components/ToolResultText.js";

export type ParameterPolicy = { command?: boolean; taskList?: boolean; renderObject?: (value: object) => ReactNode };
function ReadableText({ text, language }: { text: string; language?: string }) {
  return language ? <CodeBlock code={text} language={language} /> : <pre className="tool-readable-value">{text}</pre>;
}

function isSimpleArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every(item => item === null || ["string", "number", "boolean"].includes(typeof item));
}

// Code context applies only to root write/edit args and direct edit batch items.
export function ParameterFields({ value, policy = {}, writeLanguage, editLanguage, editRoot = false }: { value: object; policy?: ParameterPolicy; writeLanguage?: string; editLanguage?: string; editRoot?: boolean }) {
  if (policy.renderObject) { const specialized = policy.renderObject(value); if (specialized) return specialized; }
  if (Object.keys(value).length === 0) return <span className="tool-empty-parameters">{zhCN.toolParameters.empty}</span>;
  const fields = value as Record<string, unknown>;
  const hasDiff = editLanguage !== undefined && typeof fields.oldText === "string" && typeof fields.newText === "string";
  const firstDiffKey = Object.keys(value).find(name => name === "oldText" || name === "newText");
  return <dl className="tool-parameters">
    {Object.entries(value).map(([name, field]) => hasDiff && (name === "oldText" || name === "newText") ? (
      name === firstDiffKey ? <div key={name} className="tool-field-wide"><dt>{zhCN.toolParameters.diff}</dt><dd><DiffBlock oldText={fields.oldText as string} newText={fields.newText as string} language={editLanguage} /></dd></div> : null
    ) : (
      <div key={name} className={field !== null && typeof field === "object" && !isSimpleArray(field) || typeof field === "string" && (field.length > 90 || field.includes("\n") || policy.command && name === "command" || writeLanguage !== undefined && name === "content" || editLanguage !== undefined && (name === "oldText" || name === "newText")) ? "tool-field-wide" : "tool-field-inline"}><dt>{name}</dt><dd>
        {isSimpleArray(field) ? <ReadableText text={JSON.stringify(field)} /> : Array.isArray(field) && field.length > 0 ? (
          <ol className={`tool-parameter-items${policy.taskList && name === "tasks" ? " tool-subagent-task-list" : ""}`} aria-label={zhCN.toolParameters.items(name)}>
            {field.map((item: unknown, index: number) => <li key={index}>
              {item !== null && typeof item === "object" && !Array.isArray(item)
                ? <ParameterFields value={item} policy={policy} editLanguage={editRoot && name === "edits" ? editLanguage : undefined} />
                : <ReadableText text={stringify(item)} />}
            </li>)}
          </ol>
        ) : field !== null && typeof field === "object" && !Array.isArray(field) ? <ParameterFields value={field} policy={policy} /> : writeLanguage !== undefined && name === "content" && typeof field === "string" ? <CodeBlock code={field} language={writeLanguage} /> : editLanguage !== undefined && (name === "oldText" || name === "newText") && typeof field === "string" ? <CodeBlock code={field} language={editLanguage} copyLabel={name === "oldText" ? zhCN.toolParameters.copyBefore : zhCN.toolParameters.copyAfter} /> : <ReadableText text={stringify(field)} language={policy.command && name === "command" ? "bash" : undefined} />}
      </dd></div>
    ))}
  </dl>;
}

export function Parameters({ value, policy = {}, writeLanguage, editLanguage }: { value: unknown; policy?: ParameterPolicy; writeLanguage?: string; editLanguage?: string }) {
  if (value == null || typeof value === "object" && Object.keys(value).length === 0) return null;
  return <section className="json-block" aria-label={zhCN.toolParameters.label}>
    {typeof value === "object" && !Array.isArray(value)
      ? <ParameterFields value={value} policy={policy} writeLanguage={writeLanguage} editLanguage={editLanguage} editRoot={editLanguage !== undefined} />
      : <pre className="tool-readable-value">{stringify(value)}</pre>}
  </section>;
}

export function Result({ label, value, language, log, initialFormat }: ResultProps & { language?: (text: string) => string | undefined; log?: boolean; initialFormat?: ToolTextFormat }) {
  if (value === undefined) return <div className="json-label">{zhCN.toolParameters.missing}{label}</div>;
  const content = value !== null && typeof value === "object" && "content" in value
    && Array.isArray(value.content) ? value.content : null;
  return (
    <section className="json-block" aria-label={label}>
      <div className="tool-result-text" data-testid="tool-result-text">
        {typeof value === "string" ? <ToolResultText key={0} text={value} language={language?.(value)} log={log} initialFormat={initialFormat} /> : content ? (
          content.map((block: unknown, index: number) => {
            if (block !== null && typeof block === "object" && "type" in block && block.type === "text"
              && "text" in block && typeof block.text === "string") {
              return <ToolResultText key={index} text={block.text} language={language?.(block.text)} log={log} initialFormat={initialFormat} />;
            }
            return <div className="json-label" key={index}>{zhCN.toolParameters.unknownContent}</div>;
          })
        ) : <ReadableText text={stringify(value)} />}
      </div>
    </section>
  );
}

export function GenericArguments({ value }: { value: unknown }) { return <Parameters value={value} />; }
/** Explicit language applies to all text results, independent of tool name. */
export function GenericResult(props: ResultProps & { initialFormat?: ToolTextFormat }) {
  const args = record(props.args);
  return <Result {...props} language={() => typeof args.language === "string" ? codeLanguage(args.language) : undefined} />;
}
