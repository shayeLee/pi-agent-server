// 工具授权策略端口：application 层只描述「允许哪些工具」，不感知 Pi SDK 的 noTools/tools 形态。
// cwd（项目存储）、模型（会话配置）、配额（ConcurrencyController）已由各自组件承载，本端口只聚焦工具授权。

/** 工具授权结果：默认全禁，或显式白名单。 */
export type ToolGrant =
  | { kind: "disabled" }
  | { kind: "allowlist"; tools: readonly string[] };

export interface ToolAuthorizationPolicyPort {
  /** 解析当前会话可用的工具白名单；默认拒绝所有工具。 */
  resolve(): ToolGrant;
}

/** 从可选的显式工具列表构建静态策略（默认全禁）。 */
export function toolPolicyFromAllowlist(
  tools?: readonly string[],
): ToolAuthorizationPolicyPort {
  return {
    resolve(): ToolGrant {
      return tools && tools.length > 0 ? { kind: "allowlist", tools } : { kind: "disabled" };
    },
  };
}
