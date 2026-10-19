// 项目 MCP 设置（GET/PUT /v1/projects/:id/mcp）与用户 MCP 连接（/v1/mcp/connections）的公开 DTO，服务端与 Web 共用。

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
  /** 需要每个用户用自己的账号授权时，是授权按钮上的名字（“连接 Linear”）；共享凭证的 server 没有。 */
  readonly oauthLabel?: string;
  /** 调用者能否启用它：adminOnly server 只有 admin 能启用；停用不受此限。 */
  readonly canEnable?: boolean;
  /** 项目尚未设置时为 null，表示沿用目录默认值。 */
  readonly updatedAt: number | null;
  /** 项目的设置是为之前同名的另一个 server（地址或命令不同）做的，现在不生效，要重新启用。 */
  readonly changed?: boolean;
}

export interface ProjectMcpSettings {
  /** 始终为 true，只为兼容旧客户端保留。 */
  readonly configured: boolean;
  readonly canEdit: boolean;
  readonly servers: readonly ProjectMcpServer[];
}

export interface ProjectMcpServerInput {
  readonly enabled: boolean;
  readonly exposure?: McpExposure | null;
  readonly hiddenTools?: readonly string[];
}

/** 调用者对一个需要用户授权的目录 server 的连接状态（docs/mcp-integration.md §13.10）。 */
export interface McpConnection {
  readonly name: string;
  /** 面板按钮上的名字（“连接 Linear”）。 */
  readonly label: string;
  readonly connected: boolean;
  /** 外部账号名；授权服务器不提供时缺省，界面改为显示连接时间。 */
  readonly account?: string;
  readonly connectedAt?: number;
  /** access token 过期时间；会自动刷新，只用于显示。 */
  readonly expiresAt?: number;
}
