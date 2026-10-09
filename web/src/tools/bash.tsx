import { Parameters, Result } from "./generic.js";
import { record } from "./summary-data.js";
import { codeLanguage } from "../components/CodeBlock.js";
import type { ArgumentsProps, ResultProps } from "./contract.js";

export function BashArguments({ value }: ArgumentsProps) { return <Parameters value={value} policy={{ command: true }} />; }
export function BashResult(props: ResultProps) {
  const args = record(props.args);
  return <Result {...props} log language={() => typeof args.language === "string" ? codeLanguage(args.language) : undefined} />;
}
