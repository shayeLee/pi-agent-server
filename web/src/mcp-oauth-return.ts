// MCP OAuth 授权完成后，服务端把浏览器送回 Web 首页并带上 `?mcp_oauth=<结果>&mcp_server=<名称>`
// （docs/mcp-integration.md §13.6）。在路由读取地址之前处理：去掉这两个参数，回到点“连接”时
// 所在的页面，并留下结果给 MCP 面板显示。

const RETURN_PATH_KEY = "pi.mcpOAuthReturnPath";

export type McpOAuthReturn = { readonly result: string; readonly server: string | null };

let pending: McpOAuthReturn | null = null;

/** 只接受本站的 `/` 或 `/p/...` 路径，避免把用户带去别处。 */
function safePath(path: string | null): string | null {
  return path !== null && (path === "/" || /^\/p\/[^?#\\]*$/.test(path)) && !path.startsWith("//") ? path : null;
}

/** 跳去授权页之前调用，记下现在的页面。 */
export function rememberMcpOAuthReturnPath(): void {
  try { window.sessionStorage.setItem(RETURN_PATH_KEY, window.location.pathname); } catch { /* 存不了就回首页 */ }
}

/** 应用启动时、路由读取地址之前调用一次。 */
export function captureMcpOAuthReturn(): void {
  const params = new URLSearchParams(window.location.search);
  const result = params.get("mcp_oauth");
  if (result === null) return;
  pending = { result, server: params.get("mcp_server") };
  let path: string | null = null;
  try {
    path = safePath(window.sessionStorage.getItem(RETURN_PATH_KEY));
    window.sessionStorage.removeItem(RETURN_PATH_KEY);
  } catch { /* 读不了就留在首页 */ }
  params.delete("mcp_oauth");
  params.delete("mcp_server");
  const rest = params.toString();
  window.history.replaceState(null, "", `${path ?? window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
}

export function peekMcpOAuthReturn(): McpOAuthReturn | null {
  return pending;
}

export function clearMcpOAuthReturn(): void {
  pending = null;
}
