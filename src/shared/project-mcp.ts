// 项目 MCP 设置的公开 DTO（GET/PUT /v1/projects/:id/mcp），服务端与 Web 共用。

export type McpExposure = "direct" | "codemode" | "deferred" | "hidden";

/** 目录中的一个 server 及项目对它的设置；目录里已删除的 server 标记为 missing。 */
export interface ProjectMcpServer {
  readonly name: string;
  readonly status: "available" | "missing";
  readonly description?: string;
  readonly transport?: "stdio" | "http";
  readonly enabled: boolean;
  readonly exposure?: McpExposure;
  readonly defaultExposure?: McpExposure;
  readonly maxExposure?: McpExposure;
  readonly hiddenTools: readonly string[];
  readonly adminOnly?: boolean;
  /** 调用者能否启用它：adminOnly server 只有 admin 能启用；停用不受此限。 */
  readonly canEnable?: boolean;
  /** 项目尚未设置时为 null，表示沿用目录默认值。 */
  readonly updatedAt: number | null;
}

export interface ProjectMcpSettings {
  /** 服务未配置 PI_MCP_CATALOG_FILE 时为 false。 */
  readonly configured: boolean;
  readonly canEdit: boolean;
  readonly servers: readonly ProjectMcpServer[];
}

export interface ProjectMcpServerInput {
  readonly enabled: boolean;
  readonly exposure?: McpExposure | null;
  readonly hiddenTools?: readonly string[];
}
