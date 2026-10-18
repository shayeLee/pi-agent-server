// 按用户 MCP OAuth 的存储（docs/mcp-integration.md §13.5、§13.8）。
// 实现负责加密：调用方只见明文记录，数据库里只有密文。解不开的行（换了密钥、被挪到别的行）按不存在处理。
import type { OAuthClientInformationMixed, OAuthDiscoveryState, OAuthTokens } from "@earendil-works/pi-mcp/oauth";

/** 动态注册的客户端，属于部署，每个目录 server 一个。 */
export interface McpOAuthClientRecord {
  readonly serverName: string;
  /** 注册时的 server 地址与回调地址；任一变化后这条记录不再使用。 */
  readonly serverUrl: string;
  readonly redirectUrl: string;
  readonly client: OAuthClientInformationMixed;
  readonly registeredAt: number;
}

/** 一个用户对一个目录 server 的授权。 */
export interface UserMcpCredentialRecord {
  readonly ownerKey: string;
  readonly serverName: string;
  /** 授权时的 server 地址；目录里地址变了，这条凭证不再使用。 */
  readonly serverUrl: string;
  /** 换 token 时用的客户端，刷新必须用同一个。 */
  readonly clientId: string;
  readonly accountLabel: string | null;
  readonly tokens: OAuthTokens;
  /** access token 过期时间（毫秒）；服务端没给有效期时为 null。 */
  readonly expiresAt: number | null;
  readonly scope: string | null;
  readonly discovery: OAuthDiscoveryState | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface McpOAuthStorePort {
  getClient(serverName: string): Promise<McpOAuthClientRecord | undefined>;
  putClient(record: McpOAuthClientRecord): Promise<void>;
  deleteClient(serverName: string): Promise<void>;
  getCredential(ownerKey: string, serverName: string): Promise<UserMcpCredentialRecord | undefined>;
  /** 新增或替换。 */
  putCredential(record: UserMcpCredentialRecord): Promise<void>;
  /** 返回是否删掉了一行。 */
  deleteCredential(ownerKey: string, serverName: string): Promise<boolean>;
  /** 用户的全部凭证（含目录里已删除 server 的行），按 server 名排序。 */
  listCredentials(ownerKey: string): Promise<UserMcpCredentialRecord[]>;
}
