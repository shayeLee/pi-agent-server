import { Parameters, Result } from "./generic.js";
import { record } from "./summary-data.js";
import { shortenCommand } from "./chrome.js";
import { codeLanguage } from "../components/CodeBlock.js";
import type { ArgumentsProps, ResultProps } from "./contract.js";

export function BashArguments({ value }: ArgumentsProps) {
  const command = record(value).command;
  const shown = typeof command === "string" ? shortenCommand(command) : "";
  return <>
    {shown ? <div className="tool-command-display">$ {shown}</div> : null}
    <div className="tool-command-source"><Parameters value={value} policy={{ command: true }} /></div>
  </>;
}
export function BashResult(props: ResultProps) {
  const args = record(props.args);
  return <Result {...props} log language={() => typeof args.language === "string" ? codeLanguage(args.language) : undefined} />;
}
