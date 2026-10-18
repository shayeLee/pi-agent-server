// 按“用户 × 目录 server”存取 OAuth 状态的 provider（docs/mcp-integration.md §13.5–§13.9）。
// 协议流程全部交给 SDK（authorizeMcp / adaptOAuthProvider），这里只负责把客户端与 token 存进数据库：
// - 授权进行中的 state、PKCE verifier、发现结果放在调用方给的 `pending` 里（P3-2 的内存待处理表）；
// - 会话里不传 `pending` 和 `onRedirect`：需要用户重新授权时抛 McpOAuthAuthorizationRequiredError。

import { randomBytes } from "node:crypto";
import {
  McpOAuthAuthorizationRequiredError,
  type OAuthClientInformationMixed, type OAuthClientMetadata, type OAuthClientProvider, type OAuthDiscoveryState,
  type OAuthFlowOptions, type OAuthTokens,
} from "@earendil-works/pi-mcp/oauth";
import type { McpOAuthStorePort, UserMcpCredentialRecord } from "../application/ports/mcp-oauth-store-port.js";
import type { McpCatalogOAuth, McpCatalogServer } from "./catalog.js";

/** 有 `oauth` 的 HTTP 目录 server。 */
export type McpOAuthCatalogServer = McpCatalogServer & {
  readonly oauth: McpCatalogOAuth;
  readonly connection: { readonly type: "http"; readonly url: string };
};

export function isOAuthServer(server: McpCatalogServer): server is McpOAuthCatalogServer {
  return server.oauth !== undefined && server.connection.type === "http";
}

/** 一次授权（start 到 callback）期间的临时状态，不落库。 */
export interface PendingMcpAuthorization {
  state?: string;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
}

export interface StoredMcpOAuthProviderOptions {
  readonly store: McpOAuthStorePort;
  readonly ownerKey: string;
  readonly server: McpOAuthCatalogServer;
  /** `<PI_PUBLIC_URL>/v1/mcp/oauth/callback`。 */
  readonly redirectUrl: string;
  /** 动态注册时的 client_name，对方授权页上显示。 */
  readonly clientName: string;
  /** 目录 `oauth.clientSecret` 替换后的值；只用于预注册客户端。 */
  readonly clientSecret?: string;
  /** 授权进行中时传入；会话里不传。 */
  readonly pending?: PendingMcpAuthorization;
  /** 截下授权地址；会话里不传。 */
  readonly onRedirect?: (url: URL) => void | Promise<void>;
  readonly now?: () => number;
}

/** SDK 流程选项：server 地址、目录 scope 与可选的授权服务器元数据地址。 */
export function mcpOAuthFlowOptions(server: McpOAuthCatalogServer): Pick<OAuthFlowOptions, "serverUrl" | "scope" | "authorizationServerMetadataUrl"> {
  return {
    serverUrl: server.connection.url,
    ...(server.oauth.scope ? { scope: server.oauth.scope } : {}),
    ...(server.oauth.authorizationServerMetadataUrl ? { authorizationServerMetadataUrl: new URL(server.oauth.authorizationServerMetadataUrl) } : {}),
  };
}

/**
 * 显示用账号名：id_token 里的 email / name / preferred_username。只用于显示，不做身份判断，
 * 所以不校验签名（它来自直连的 token 接口）。
 */
export function accountLabelFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims !== "object" || claims === null) return null;
    for (const key of ["email", "name", "preferred_username"]) {
      const value = (claims as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 200);
    }
  } catch { /* 不是 JWT，忽略 */ }
  return null;
}

export class StoredMcpOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  readonly #options: StoredMcpOAuthProviderOptions;
  readonly #configuredClient: OAuthClientInformationMixed | undefined;
  readonly #now: () => number;

  constructor(options: StoredMcpOAuthProviderOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.redirectUrl = options.redirectUrl;
    const { clientId } = options.server.oauth;
    this.#configuredClient = clientId
      ? { client_id: clientId, ...(options.clientSecret !== undefined ? { client_secret: options.clientSecret } : {}) }
      : undefined;
    this.clientMetadata = {
      client_name: options.clientName,
      redirect_uris: [options.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.#configuredClient?.client_secret !== undefined ? "client_secret_post" : "none",
      ...(options.server.oauth.scope ? { scope: options.server.oauth.scope } : {}),
    };
  }

  get #serverName() { return this.#options.server.name; }
  get #serverUrl() { return this.#options.server.connection.url; }

  async state(): Promise<string> {
    const pending = this.#options.pending;
    if (!pending) return randomBytes(32).toString("hex");
    pending.state ??= randomBytes(32).toString("hex");
    return pending.state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.#configuredClient) return this.#configuredClient;
    const record = await this.#options.store.getClient(this.#serverName);
    if (!record || record.serverUrl !== this.#serverUrl) return undefined;
    // 回调地址只在授权码流程里用到：PI_PUBLIC_URL 变了就重新注册；刷新时沿用原客户端。
    if (this.#options.pending && record.redirectUrl !== this.redirectUrl) return undefined;
    return record.client;
  }

  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    if (this.#configuredClient) return;
    await this.#options.store.putClient({
      serverName: this.#serverName, serverUrl: this.#serverUrl, redirectUrl: this.redirectUrl, client, registeredAt: this.#now(),
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.#credential())?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const existing = await this.#credential();
    const client = await this.clientInformation();
    const clientId = client?.client_id ?? existing?.clientId;
    if (clientId === undefined) throw new Error("OAuth client information is missing while saving tokens");
    const now = this.#now();
    // id_token 只用来取账号名，不保存。
    const { id_token: idToken, ...stored } = tokens;
    await this.#options.store.putCredential({
      ownerKey: this.#options.ownerKey,
      serverName: this.#serverName,
      serverUrl: this.#serverUrl,
      clientId,
      accountLabel: accountLabelFromIdToken(idToken) ?? existing?.accountLabel ?? null,
      tokens: stored,
      expiresAt: tokens.expires_in === undefined ? null : now + tokens.expires_in * 1000,
      scope: tokens.scope ?? existing?.scope ?? null,
      discovery: this.#options.pending?.discovery ?? existing?.discovery ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.#options.onRedirect) throw new McpOAuthAuthorizationRequiredError();
    await this.#options.onRedirect(url);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    if (this.#options.pending) this.#options.pending.codeVerifier = verifier;
  }

  async codeVerifier(): Promise<string> {
    const verifier = this.#options.pending?.codeVerifier;
    if (verifier === undefined) throw new Error("OAuth code verifier is missing");
    return verifier;
  }

  async invalidateCredentials(kind: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const { store, ownerKey, pending } = this.#options;
    if (kind === "all" || kind === "tokens") await store.deleteCredential(ownerKey, this.#serverName);
    // 动态注册的客户端被对方清理（invalid_client）时删掉，下次授权重新注册。
    if ((kind === "all" || kind === "client") && !this.#configuredClient) await store.deleteClient(this.#serverName);
    if ((kind === "all" || kind === "verifier") && pending) delete pending.codeVerifier;
    if (kind === "all" || kind === "discovery") {
      if (pending) delete pending.discovery;
      if (kind === "discovery") {
        const existing = await this.#credential();
        if (existing?.discovery) await store.putCredential({ ...existing, discovery: null, updatedAt: this.#now() });
      }
    }
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    if (this.#options.pending) {
      this.#options.pending.discovery = discovery;
      return;
    }
    // 刷新时 SDK 每次都会回写发现结果；没变就不写库。
    const existing = await this.#credential();
    if (existing && JSON.stringify(existing.discovery) !== JSON.stringify(discovery)) {
      await this.#options.store.putCredential({ ...existing, discovery, updatedAt: this.#now() });
    }
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    if (this.#options.pending) return this.#options.pending.discovery;
    return (await this.#credential())?.discovery ?? undefined;
  }

  /** 目录里 server 地址变了，旧凭证不再使用。 */
  async #credential(): Promise<UserMcpCredentialRecord | undefined> {
    const record = await this.#options.store.getCredential(this.#options.ownerKey, this.#serverName);
    return record && record.serverUrl === this.#serverUrl ? record : undefined;
  }
}
