// 工具授权策略端口：application 层只描述「允许哪些工具」，不感知 Pi SDK 的 noTools/tools 形态。
// cwd（项目存储）、模型（会话配置）、配额（ConcurrencyController）已由各自组件承载，本端口只聚焦工具授权。

/** 工具授权结果：默认只读，或显式白名单。 */
export type ToolGrant =
  | { kind: "disabled" }
  | { kind: "allowlist"; tools: readonly string[] };

export interface ToolAuthorizationPolicyPort {
  /** 解析当前会话可用的工具白名单；未配置时默认只读工具。 */
  resolve(): ToolGrant;
}

/** 默认只读工具集：可读文件/列目录/查找/搜索，不含写与执行。 */
export const DEFAULT_READONLY_TOOLS = ["read", "ls", "find", "grep"] as const;

/** 从可选的显式工具列表构建静态策略（未配置时默认只读工具集）。 */
export function toolPolicyFromAllowlist(
  tools?: readonly string[],
): ToolAuthorizationPolicyPort {
  return {
    resolve(): ToolGrant {
      if (tools === undefined) return { kind: "allowlist", tools: [...DEFAULT_READONLY_TOOLS] };
      return tools.length > 0 ? { kind: "allowlist", tools } : { kind: "disabled" };
    },
  };
}
