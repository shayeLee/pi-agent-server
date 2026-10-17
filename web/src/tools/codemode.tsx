import { zhCN } from "../i18n/zh-CN.js";
import { CodeBlock } from "../components/CodeBlock.js";
import { Icon } from "../components/Icon.js";
import { ParameterFields } from "./generic.js";
import { record } from "./summary-data.js";
import type { ArgumentsProps } from "./contract.js";

/** codemode 的脚本默认折叠，展开后按 JavaScript 高亮；其余参数照常列出。 */
export function CodemodeArguments({ value }: ArgumentsProps) {
  const { code, ...rest } = record(value);
  return <section className="json-block" aria-label={zhCN.toolParameters.label}>
    {typeof code === "string" && <details className="codemode-script" data-testid="codemode-script">
      <summary className="chevron-trigger"><Icon name="chevron" className="details-chevron disclosure-chevron" />{zhCN.nestedCalls.script}</summary>
      <CodeBlock code={code} language="javascript" />
    </details>}
    {Object.keys(rest).length > 0 && <ParameterFields value={rest} />}
  </section>;
}
