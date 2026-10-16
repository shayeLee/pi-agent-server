import { validateToolSelection } from "../application/ports/tool-authorization-policy-port.js";

/** Translate the host's resolved policy using only public SDK options.
 * In default mode, seed the host SettingsManager.inMemory() defaults rather than Pi 1.3's
 * process-global settings. Modifiers leave custom/extension tools and dynamic activation
 * unrestricted; noTools:'builtin' prevents the SDK from adding its own defaults.
 * This is a session-creation snapshot: SDK defaultTools reload increments are not followed.
 */
export function resolveSdkToolConfig(
  config: { readonly tools?: readonly string[]; readonly noTools?: "all" | "builtin" },
  defaultTools: readonly string[] | undefined,
): { tools?: string[]; noTools?: "all" | "builtin" } {
  validateResolvedToolSelection(config.tools);
  if (config.tools === undefined && config.noTools === undefined) {
    const names = defaultTools ?? ["read", "bash", "edit", "write"];
    // An empty exact list would become a whitelist; keep modifier mode even with no defaults.
    return { noTools: "builtin", tools: names.length ? names.map(name => `+${name}`) : ["-read"] };
  }
  return {
    ...(config.tools !== undefined ? { tools: [...config.tools] } : {}),
    ...(config.noTools !== undefined ? { noTools: config.noTools } : {}),
  };
}

/** Host-facing resolved names are exact, never another modifier expression. */
export function validateResolvedToolSelection(tools: readonly string[] | undefined): void {
  if (tools?.some(name => name.startsWith("+") || name.startsWith("-"))) {
    throw new Error("Invalid resolved tools option: exact tool names cannot start with + or -");
  }
}

/** Host modifier selection semantics, frozen as the host's SDK allowlist.
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
