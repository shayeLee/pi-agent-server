import type { ToolCall } from "pi-agent-server/client";
import type { ToolPresentation, ToolRenderers } from "./contract.js";
import { isFileAcknowledgement } from "./file-data.js";
import { toolHeader } from "./metadata.js";
import { GenericArguments, GenericResult } from "./generic.js";
import { ReadArguments, ReadResult, WriteArguments, EditArguments } from "./files.js";
import { BashArguments, BashResult } from "./bash.js";
import { SubagentArguments, SubagentResult } from "./subagent.js";

const generic: ToolRenderers = { Arguments: GenericArguments, Result: GenericResult };
const registry: Readonly<Record<string, ToolRenderers>> = {
  bash: { Arguments: BashArguments, Result: BashResult },
  subagent: { Arguments: SubagentArguments, Result: SubagentResult },
  subagent_wait: { Arguments: GenericArguments, Result: SubagentResult },
  read: { Arguments: ReadArguments, Result: ReadResult },
  write: { Arguments: WriteArguments, Result: GenericResult },
  edit: { Arguments: EditArguments, Result: GenericResult },
};
export function toolPresentation(call: ToolCall): ToolPresentation {
  const renderers = Object.hasOwn(registry, call.toolName) ? registry[call.toolName] : generic;
  return { ...renderers, ...(isFileAcknowledgement(call) ? { Result: () => null } : {}), header: toolHeader(call) };
}
