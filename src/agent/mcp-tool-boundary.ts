// MCP 工具授权边界（docs/mcp-integration.md §6）。
// SDK 白名单默认让 MCP 工具保持注册，供 codemode / tool_search 调用；只有白名单含 `mcp__` 条目时才过滤。
// 宿主收紧为：白名单模式下只有以 `mcp__` 开头的条目（或精确列出的资源工具）授权 MCP。
// SDK 内部的 isMcpToolName / createToolNameMatcher 不是公开导出，这里按相同规则镜像。

import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const MCP_RESOURCE_TOOLS: readonly string[] = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

/** MCP 来源的工具：server 工具（`mcp__<server>__<tool>`）或资源工具。 */
export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__") || MCP_RESOURCE_TOOLS.includes(name);
}

/** 精确名或 `*` 通配模式，与 SDK 的 tools / excludeTools 匹配语义一致。 */
function toolNameMatcher(entries: readonly string[]): (name: string) => boolean {
  const names = new Set(entries.filter(entry => !entry.includes("*")));
  const patterns = entries.filter(entry => entry.includes("*")).map(pattern => new RegExp(`^${
    pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")
  }$`));
  return name => names.has(name) || patterns.some(regexp => regexp.test(name));
}

/**
 * 白名单不含 `mcp__` 条目时需要追加的 excludeTools；否则交给 SDK 自身的 MCP 过滤。
 * 精确列出的资源工具保留。`*` 之类不以 `mcp__` 开头的模式不授权 MCP。
 */
export function mcpExcludeTools(tools: readonly string[]): string[] | undefined {
  if (tools.length === 0 || tools.some(entry => entry.startsWith("mcp__"))) return undefined;
  return ["mcp__*", ...MCP_RESOURCE_TOOLS.filter(name => !tools.includes(name))];
}

/** 白名单下某个 MCP 工具是否获授权；与 SDK 注册结果 + mcpExcludeTools 保持一致。非 MCP 工具不在此判断。 */
export function isMcpToolAuthorized(tools: readonly string[], name: string): boolean {
  if (!isMcpToolName(name)) return true;
  if (tools.some(entry => entry.startsWith("mcp__"))) return toolNameMatcher(tools)(name);
  return tools.includes(name) && !name.startsWith("mcp__");
}

/**
 * 纵深防御：tool_call hook 拦截未授权的 MCP 调用。codemode 等工具发起的嵌套调用同样经过此 hook，
 * 即使 SDK 以后调整白名单的注册语义，边界也不会被打开。all 模式不安装。
 */
export function createMcpToolBoundaryExtension(tools: readonly string[]): Extract<InlineExtension, { factory: unknown }> {
  const allowlist = [...tools];
  return {
    name: "pi-agent-server-mcp-tool-boundary",
    factory: pi => {
      pi.on("tool_call", event => isMcpToolAuthorized(allowlist, event.toolName)
        ? undefined
        : { block: true, reason: `MCP tool ${event.toolName} is not allowed by the server tool allowlist` });
    },
  };
}
