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

/** 从可选的显式工具列表构建静态策略；undefined 允许全部，[] 禁用全部。 */
export function toolPolicyFromAllowlist(
  tools?: readonly string[],
): ToolAuthorizationPolicyPort {
  return {
    resolve(): ToolGrant {
      if (tools === undefined) return { kind: "all" };
      return tools.length > 0 ? { kind: "allowlist", tools } : { kind: "disabled" };
    },
  };
}
