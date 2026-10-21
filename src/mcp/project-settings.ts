// 项目级 MCP 设置（docs/mcp-integration.md §4.2–4.5）：只能引用目录里的 server，只能收紧。

import { createHash } from "node:crypto";
import type { McpServerConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";
import { exposureRank, MCP_EXPOSURES, type McpCatalog, type McpCatalogServer, type McpExposure } from "./catalog.js";

/** 项目对某个目录 server 的设置（数据库一行）。 */
export interface ProjectMcpServerSetting {
  readonly serverName: string;
  readonly enabled: boolean;
  /** 覆盖目录默认 exposure，不超过 maxExposure。 */
  readonly exposure: McpExposure | null;
  /** 按工具名（server 提供的原名，精确匹配）隐藏工具；只能收紧，所以值固定为 hidden。 */
  readonly hiddenTools: readonly string[];
  readonly updatedAt: number;
  readonly updatedBy: string;
  /** 设置时 server 的身份（mcpServerIdentity）；v6 之前写入的行为 null，按一致处理。 */
  readonly serverIdentity: string | null;
}

export interface ProjectMcpSettingInput {
  readonly enabled: boolean;
  readonly exposure?: McpExposure | null;
  readonly hiddenTools?: readonly string[];
}

export type ProjectMcpSettingError =
  | { readonly code: "unknown_server" }
  | { readonly code: "admin_only" }
  | { readonly code: "invalid"; readonly message: string };

const TOOL_NAME = /^[^*\s]{1,128}$/;
const MAX_HIDDEN_TOOLS = 256;

/** 校验一次项目设置变更；admin 才能启用 adminOnly server（停用不受限，任何 owner 都能关）。 */
export function validateProjectMcpSetting(
  catalog: McpCatalog, serverName: string, input: ProjectMcpSettingInput, isAdmin: boolean,
): ProjectMcpSettingError | null {
  const server = catalog.servers.get(serverName);
  if (!server) return { code: "unknown_server" };
  if (server.adminOnly && input.enabled && !isAdmin) return { code: "admin_only" };
  const exposure = input.exposure ?? null;
  if (exposure !== null) {
    if (!(MCP_EXPOSURES as readonly string[]).includes(exposure)) return { code: "invalid", message: "exposure 取值非法" };
    if (exposureRank(exposure) > exposureRank(server.maxExposure)) {
      return { code: "invalid", message: `exposure 不能高于目录上限 ${server.maxExposure}` };
    }
  }
  const hidden = input.hiddenTools ?? [];
  if (hidden.length > MAX_HIDDEN_TOOLS) return { code: "invalid", message: `hiddenTools 最多 ${MAX_HIDDEN_TOOLS} 项` };
  if (!hidden.every(name => typeof name === "string" && TOOL_NAME.test(name))) {
    return { code: "invalid", message: "hiddenTools 只接受精确工具名（不含空白与 *）" };
  }
  return null;
}

/**
 * server 的身份：HTTP 是地址，stdio 是命令、参数和 cwd（§14.3）。mcp.json 里同名的一项换成别的地址或命令时，
 * 项目之前的设置不再生效，要 owner 重新确认；只改 header、env、说明等不算换了 server。存哈希，不存原文。
 */
export function mcpServerIdentity(server: McpCatalogServer): string {
  const connection = server.connection;
  const parts = connection.type === "http"
    // 项目文件里的 oauth 设置也算：换授权服务器或客户端要 owner 重新确认。
    ? ["http", connection.url, ...(server.projectFile === "defined" ? [server.oauth ?? null] : [])]
    : ["stdio", connection.command, connection.args ?? [], connection.cwd ?? null,
      // 项目 .pi/mcp.json 里的 server 连 env 也算：模型能改这个文件，改 env（如 NODE_OPTIONS）同样能换掉运行的代码。
      ...(server.projectFile === "defined" ? [connection.env ?? {}] : [])];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** 设置是为另一个同名 server 做的。 */
function isStale(server: McpCatalogServer, setting: ProjectMcpServerSetting | undefined): boolean {
  return setting?.serverIdentity != null && setting.serverIdentity !== mcpServerIdentity(server);
}

/** 设置过期时一律不启用，连 defaultEnabled 也不算：换过的 server 要 owner 重新确认。 */
function isEnabled(server: McpCatalogServer, setting: ProjectMcpServerSetting | undefined): boolean {
  if (isStale(server, setting)) return false;
  return setting ? setting.enabled : server.defaultEnabled;
}

/** 把较宽的 exposure 收紧到 limit；hidden 不受影响。codemode 与 deferred 同级，保持原值。 */
function clamp(exposure: McpExposure, limit: McpExposure): McpExposure {
  return exposureRank(exposure) > exposureRank(limit) ? limit : exposure;
}

/** 目录 + 项目设置 → 交给 SDK 的 server 配置；只含已启用的 server。占位符原样保留。 */
/**
 * 会话快照的 MCP server：目录 ∩ 项目设置。有 `oauth` 的 server 还要求会话 owner 已连接
 * （`connectedOAuth` 里有它）；没连接或共享会话里，模型看不到它的工具（§13.9）。
 */
export function effectiveMcpServerEntries(
  catalog: McpCatalog, settings: readonly ProjectMcpServerSetting[], connectedOAuth: ReadonlySet<string> = new Set(),
): McpServerEntry[] {
  const byName = new Map(settings.map(setting => [setting.serverName, setting]));
  const entries: McpServerEntry[] = [];
  for (const server of catalog.servers.values()) {
    const setting = byName.get(server.name);
    if (!isEnabled(server, setting)) continue;
    if (server.oauth && !connectedOAuth.has(server.name)) continue;
    // 项目选的 server 级 exposure 同时是目录工具级覆盖的上限，所以“整体收紧”不会被单个工具放宽。
    const exposure = setting?.exposure ?? server.exposure;
    const limit = setting?.exposure ?? server.maxExposure;
    const toolExposure: Record<string, McpExposure> = {};
    for (const [tool, value] of Object.entries(server.toolExposure)) toolExposure[tool] = clamp(value, limit);
    for (const tool of setting?.hiddenTools ?? []) toolExposure[tool] = "hidden";
    const config = {
      ...server.connection,
      // mcp.json 里可以不写说明，这时交给 SDK 用 server 自己的 instructions。
      ...(server.description ? { description: server.description } : {}),
      exposure,
      ...(Object.keys(toolExposure).length > 0 ? { toolExposure } : {}),
      ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
    } as McpServerConfig;
    entries.push({ name: server.name, config, source: "pi-agent-server MCP catalog", scope: server.projectFile === "defined" ? "project" : "global" });
  }
  return entries;
}

/** API 视图：目录中的每个 server 及项目设置；目录里已删除的 server 标记为 missing。 */
export type ProjectMcpServerView = import("../shared/project-mcp.js").ProjectMcpServer;

export function projectMcpServerViews(
  catalog: McpCatalog, settings: readonly ProjectMcpServerSetting[],
): ProjectMcpServerView[] {
  const byName = new Map(settings.map(setting => [setting.serverName, setting]));
  const views: ProjectMcpServerView[] = [...catalog.servers.values()].map(server => {
    const setting = byName.get(server.name);
    return {
      name: server.name, status: "available", description: server.description, transport: server.connection.type,
      enabled: isEnabled(server, setting), exposure: setting?.exposure ?? server.exposure,
      defaultExposure: server.exposure, maxExposure: server.maxExposure,
      hiddenTools: setting?.hiddenTools ?? [], adminOnly: server.adminOnly, updatedAt: setting?.updatedAt ?? null,
      ...(isStale(server, setting) ? { changed: true } : {}),
      ...(server.oauth ? { oauthLabel: server.oauth.label } : {}),
      ...(server.projectFile ? { projectFile: server.projectFile } : {}),
    };
  });
  for (const setting of settings) {
    if (catalog.servers.has(setting.serverName)) continue;
    views.push({ name: setting.serverName, status: "missing", enabled: false, hiddenTools: setting.hiddenTools, updatedAt: setting.updatedAt });
  }
  return views;
}
