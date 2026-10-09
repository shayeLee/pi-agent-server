// 工具授权策略端口：application 层只描述「允许哪些工具」，不感知 Pi SDK 的 noTools/tools 形态。
// cwd（项目存储）、模型（会话配置）、配额（ConcurrencyController）已由各自组件承载，本端口只聚焦工具授权。

/** 工具授权结果：默认允许全部，或显式白名单/禁用。 */
export type ToolGrant =
  | { kind: "all" }
  | { kind: "disabled" }
  | { kind: "allowlist"; tools: readonly string[] };

export interface ToolAuthorizationPolicyPort {
  /** 解析当前会话可用的工具范围；未配置时允许全部工具。 */
  resolve(): ToolGrant;
}

/** Validate trusted host selection using Pi 1.1's tools-option rules. */
export function validateToolSelection(tools?: readonly string[]): void {
  if (!tools) return;
  const modifiers = tools.filter(name => name.startsWith("+") || name.startsWith("-"));
  if (modifiers.length === 0) return;
  if (modifiers.length !== tools.length) throw new Error("Invalid tools option: tool names cannot be mixed with +name or -name entries");
  const repeated = modifiers.find(name => /^[+-]{2}/.test(name));
  if (repeated) throw new Error(`Invalid tools option: repeated modifier prefix: ${repeated}`);
  const pattern = modifiers.find(name => name.includes("*"));
  if (pattern) throw new Error(`Invalid tools option: +name and -name entries take exact tool names, not patterns: ${pattern}`);
}

/** Trusted host selection; modifiers are resolved at the composition boundary.
 * Unknown exact names retain the SDK's existing unavailable/ignored behavior.
 */
export function toolPolicyFromAllowlist(
  tools?: readonly string[],
): ToolAuthorizationPolicyPort {
  validateToolSelection(tools);
  return {
    resolve(): ToolGrant {
      if (tools === undefined) return { kind: "all" };
      return tools.length > 0 ? { kind: "allowlist", tools } : { kind: "disabled" };
    },
  };
}
