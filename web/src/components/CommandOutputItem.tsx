import { zhCN } from "../i18n/zh-CN.js";
import type { TimelineItem } from "pi-agent-server/client";

/** An extension command run from the composer: the command as typed, then each line it showed. */
export function CommandOutputItem({ item }: { item: Extract<TimelineItem, { kind: "command" }> }) {
  const typed = `/${item.name}${item.args ? ` ${item.args}` : ""}`;
  return <section className="command-output" data-testid="command-output" data-failed={item.failed || undefined} aria-label={zhCN.commandOutput.label(typed)}>
    <div className="command-output-head">{typed}</div>
    {item.output.length === 0
      ? <p className="command-output-empty">{zhCN.commandOutput.empty}</p>
      : item.output.map((line, index) => <pre key={index} className={`command-output-line is-${line.level}`}>{line.text}</pre>)}
  </section>;
}
