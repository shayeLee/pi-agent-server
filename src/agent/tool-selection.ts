import { validateToolSelection } from "../application/ports/tool-authorization-policy-port.js";

/** SDK-facing names are exact, never another modifier expression. */
export function validateResolvedToolSelection(tools: readonly string[] | undefined): void {
  if (tools?.some(name => name.startsWith("+") || name.startsWith("-"))) {
    throw new Error("Invalid resolved tools option: exact tool names cannot start with + or -");
  }
}

/** Pi 1.1 default selection semantics, frozen as the host's SDK allowlist.
 * SDK helpers are internal, not public exports. Keep this in sync with settings-manager.
 */
export function resolveHostToolSelection(
  tools: readonly string[] | undefined,
  defaultTools: readonly string[] | undefined,
  noTools?: "all" | "builtin",
): string[] | undefined {
  validateToolSelection(tools);
  if (!tools) return undefined; // existing host all contract
  if (!tools.some(name => name.startsWith("+") || name.startsWith("-"))) return [...tools];
  const selected = [...(noTools ? [] : defaultTools ?? ["read", "bash", "edit", "write"])];
  for (const entry of tools) {
    const name = entry.slice(1);
    const index = selected.indexOf(name);
    if (entry.startsWith("+") && index === -1 && name) selected.push(name);
    else if (entry.startsWith("-") && index !== -1) selected.splice(index, 1);
  }
  validateResolvedToolSelection(selected);
  return selected;
}
