// 共享 MCP（GET/PUT/DELETE /v1/mcp/shared，docs/mcp-integration.md §14.3）的公开 DTO，服务端与 Web 共用。
// 共享 MCP 就是 Pi 的全局 mcp.json；admin 能在 Web 上增删改，其他人只能看列表。

import type { McpExposure } from "./project-mcp.js";

/** header 与 env 的值在 API 里打码成这个样子；保存时原样传回表示不改。 */
export const SHARED_MCP_MASK = "••••••";

/** 表单里能改的字段；mcp.json 里的其他字段（toolExposure 等）保存时原样保留。 */
export interface SharedMcpServerConfig {
  readonly transport: "http" | "stdio";
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly description?: string;
  /** 默认提供方式；不写时是 codemode。 */
  readonly exposure?: McpExposure;
  /** 项目最多能放宽到哪一档；不写时取 exposure 与工具级设置里最宽的那个。 */
  readonly maxExposure?: McpExposure;
  readonly adminOnly?: boolean;
  readonly defaultEnabled?: boolean;
  /** 单次请求超时（秒）。 */
  readonly timeout?: number;
  /** false：所有项目都不连，Pi TUI 里也停用。 */
  readonly enabled?: boolean;
  /** 每个用户用自己的账号授权（只有 HTTP）；null 或缺省表示不用。 */
  readonly oauth?: { readonly scope?: string } | null;
}

export interface SharedMcpServer {
  readonly name: string;
  /** unavailable：这一项进不了会话，reason 说明原因（只给 admin）。 */
  readonly status: "available" | "unavailable";
  readonly reason?: string;
  readonly transport?: "http" | "stdio";
  readonly description?: string;
  readonly exposure?: McpExposure;
  readonly adminOnly?: boolean;
  /** 需要每个用户自己授权。 */
  readonly oauth?: boolean;
  /** 只给 admin：表单内容，header 与 env 的值已打码。 */
  readonly config?: SharedMcpServerConfig;
  /** 只给 admin：表单管不到、保存时保留的字段名，例如 toolExposure。 */
  readonly otherFields?: readonly string[];
}

export interface SharedMcpList {
  readonly canEdit: boolean;
  readonly servers: readonly SharedMcpServer[];
  /** 只给 admin。 */
  readonly file?: {
    readonly path: string;
    /** 保存和删除时带上；文件在别处被改过就会对不上，返回 409。 */
    readonly hash: string;
    /** 文件读不了或不是有效的 JSON；会话继续用上一次读成功的内容。 */
    readonly error?: string;
  };
}

export interface SharedMcpServerInput {
  readonly hash: string;
  readonly server: SharedMcpServerConfig;
}
