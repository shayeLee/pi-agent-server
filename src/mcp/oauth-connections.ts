// 用户连接 MCP server 的授权流程（docs/mcp-integration.md §13.6、§13.10）。
// 协议交给 SDK 的 authorizeMcp；这里负责：PI_PUBLIC_URL 拼回调地址、内存里的待处理授权表
// （state 一次性、10 分钟过期、绑定发起者）、回调结果、断开时尽量撤销 token。
// 任何返回值和错误信息都不含 token、code 或 state。
// 信任项目的 .pi/mcp.json 定义的 oauth server（docs/mcp-integration.md §15）也走这里：凭证和动态注册的客户端
// 存在 `project:<项目 ID>:<名称>` 下（全局名称只有字母、数字、_ 和 -，不会撞），每个项目各自授权；
// 凭证仍然只用于授权时的地址，项目文件换了地址就不再使用。

import {
  authorizeMcp, OAuthIssuerMismatchError, OAuthRegistrationError, type OAuthClientInformationMixed,
} from "@earendil-works/pi-mcp/oauth";
import type { McpFetch } from "@earendil-works/pi-mcp";
import type { McpOAuthStorePort } from "../application/ports/mcp-oauth-store-port.js";
import type { AuthProvider } from "@earendil-works/pi-mcp";
import { MCP_OAUTH_CALLBACK_PATH } from "./oauth-callback-path.js";
import { createSessionAuthProvider, KeyedLock } from "./session-oauth.js";
import { resolveMcpPlaceholders, type McpCatalog } from "./catalog.js";
import {
  isOAuthServer, mcpOAuthFlowOptions, StoredMcpOAuthProvider, type McpOAuthCatalogServer, type PendingMcpAuthorization,
} from "./oauth-provider.js";

const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING_PER_OWNER = 5;
const MAX_PENDING = 1000;
const REQUEST_TIMEOUT_MS = 15_000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 解析 PI_PUBLIC_URL：用户在浏览器里访问本服务（Web）的地址，`/v1` 由同一地址代理到服务端。
 * 只接受 http(s)，不带查询串和片段，末尾的 `/` 去掉。`insecure` 表示非 loopback 的 http：
 * 多数授权服务器按 OAuth 2.1 拒绝这种回调地址（Linear 即如此），调用方应提示配置 HTTPS。
 */
export function parsePublicUrl(value: string): { url: string; insecure: boolean } {
  if (!URL.canParse(value)) throw new Error("PI_PUBLIC_URL must be an absolute http or https URL");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("PI_PUBLIC_URL must be an absolute http or https URL");
  if (url.search || url.hash || url.username || url.password) throw new Error("PI_PUBLIC_URL must not contain credentials, a query or a fragment");
  const normalized = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return { url: normalized, insecure: url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname) };
}

export type McpConnectionView = import("../shared/project-mcp.js").McpConnection;

export type McpOAuthStartError =
  | { code: "unknown_server"; message: string }
  | { code: "registration_rejected"; message: string }
  | { code: "authorization_unavailable"; message: string };

/** 回调结果码，原样放进跳回 Web 的地址里。 */
export type McpOAuthCallbackResult =
  | { ok: true; server: string }
  | { ok: false; server?: string; reason: "expired" | "denied" | "issuer_mismatch" | "server_changed" | "exchange_failed" };

/** 项目的目录（全局 server 加上信任项目自己的 server）；不给时只看全局目录。 */
export interface McpOAuthProject {
  readonly id: string;
  readonly catalog: McpCatalog;
}

/** 项目文件定义的 server 的存储名。 */
function storageName(server: McpOAuthCatalogServer, projectId: string | undefined): string {
  return server.projectFile === "defined" && projectId !== undefined ? `project:${projectId}:${server.name}` : server.name;
}

/** 目录里的 server，以及用存储名代替名称、交给凭证存储的同一个 server。 */
interface Target {
  readonly server: McpOAuthCatalogServer;
  readonly stored: McpOAuthCatalogServer;
}

interface PendingEntry {
  readonly ownerKey: string;
  readonly serverName: string;
  readonly projectId?: string;
  readonly serverUrl: string;
  readonly pending: PendingMcpAuthorization;
  readonly expiresAt: number;
}

export interface McpOAuthConnectionsOptions {
  readonly catalog: McpCatalog;
  /** 授权回调时重新取项目的目录，确认 server 没被换掉。 */
  readonly projectCatalog?: (projectId: string) => Promise<McpCatalog | undefined>;
  readonly store: McpOAuthStorePort;
  /** parsePublicUrl 的结果。 */
  readonly publicUrl: string;
  /** 动态注册时的 client_name。 */
  readonly clientName?: string;
  readonly fetch?: McpFetch;
  readonly now?: () => number;
}

export class McpOAuthConnections {
  readonly callbackUrl: string;
  /** 回调完成后跳回的 Web 页面。 */
  readonly returnUrl: string;
  readonly #options: McpOAuthConnectionsOptions;
  readonly #now: () => number;
  /** state → 待处理授权。只在内存里：服务重启后进行中的授权失效，用户重新点一次即可。 */
  readonly #pending = new Map<string, PendingEntry>();
  /** 同一用户同一 server 的刷新跨会话串行。 */
  readonly #refreshLocks = new KeyedLock();

  constructor(options: McpOAuthConnectionsOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.callbackUrl = `${options.publicUrl}${MCP_OAUTH_CALLBACK_PATH}`;
    this.returnUrl = `${options.publicUrl}/`;
  }

  /** 目录中所有 oauth server 的连接状态；给了项目时还有项目自己的 server。 */
  async list(ownerKey: string, project?: McpOAuthProject): Promise<McpConnectionView[]> {
    const views: McpConnectionView[] = [];
    for (const { server, stored } of this.#targets(project)) {
      const credential = await this.#options.store.getCredential(ownerKey, stored.name);
      const connected = credential !== undefined && credential.serverUrl === server.connection.url;
      views.push({
        name: server.name, label: server.oauth.label, connected,
        ...(connected && credential.accountLabel ? { account: credential.accountLabel } : {}),
        ...(connected ? { connectedAt: credential.createdAt } : {}),
        ...(connected && credential.expiresAt !== null ? { expiresAt: credential.expiresAt } : {}),
      });
    }
    return views;
  }

  /** 用户已连接（且凭证对应目录当前地址）的 oauth server 名称；给了项目时按项目的目录。 */
  async connectedServers(ownerKey: string, project?: McpOAuthProject): Promise<Set<string>> {
    const credentials = new Map((await this.#options.store.listCredentials(ownerKey)).map(credential => [credential.serverName, credential]));
    const names = new Set<string>();
    for (const { server, stored } of this.#targets(project)) {
      if (credentials.get(stored.name)?.serverUrl === server.connection.url) names.add(server.name);
    }
    return names;
  }

  /** 会话里连接 oauth server 用的 AuthProvider；server 不是 oauth server 时为 undefined。 */
  sessionAuthProvider(ownerKey: string, serverName: string, project?: McpOAuthProject): AuthProvider | undefined {
    const target = this.#target(serverName, project);
    if (!target) return undefined;
    const server = target.stored;
    const secret = server.oauth.clientSecret;
    return createSessionAuthProvider({
      store: this.#options.store, ownerKey, server, redirectUrl: this.callbackUrl, locks: this.#refreshLocks,
      clientName: this.#options.clientName ?? "pi-agent-server",
      ...(secret ? { clientSecret: resolveMcpPlaceholders(secret, { projectCwd: "" }) } : {}),
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      ...(this.#options.now ? { now: this.#options.now } : {}),
    });
  }

  /** 发起授权，返回对方授权页地址。 */
  async start(ownerKey: string, serverName: string, project?: McpOAuthProject): Promise<{ authorizationUrl: string } | McpOAuthStartError> {
    const target = this.#target(serverName, project);
    if (!target) return { code: "unknown_server", message: "目录中没有这个需要授权的 MCP server" };
    const server = target.stored;
    this.#sweep();
    const pending: PendingMcpAuthorization = {};
    let authorizationUrl: URL | undefined;
    const provider = this.#provider(ownerKey, server, { pending, onRedirect: url => { authorizationUrl = url; } });
    try {
      // skipRefresh：已连接的用户再点“连接”是要重新授权，不是刷新。
      const result = await authorizeMcp(provider, { ...mcpOAuthFlowOptions(server), skipRefresh: true, ...this.#requestOptions() });
      if (result !== "REDIRECT" || !authorizationUrl || !pending.state) throw new Error("authorization did not produce a redirect");
    } catch (error) {
      return startError(error, server, this.callbackUrl);
    }
    this.#remember(pending.state, {
      ownerKey, serverName, ...(project && target.stored.name !== serverName ? { projectId: project.id } : {}),
      serverUrl: server.connection.url, pending, expiresAt: this.#now() + PENDING_TTL_MS,
    });
    return { authorizationUrl: authorizationUrl.href };
  }

  /** 处理回调。state 只有发起者本人能用，用过即作废。 */
  async complete(ownerKey: string, query: { code?: string; state?: string; iss?: string; error?: string }): Promise<McpOAuthCallbackResult> {
    this.#sweep();
    const entry = query.state ? this.#pending.get(query.state) : undefined;
    // 别人拿到 state 也用不了，也不能借此把发起者的授权作废。
    if (!entry || entry.ownerKey !== ownerKey) return { ok: false, reason: "expired" };
    this.#pending.delete(query.state!);
    const { serverName } = entry;
    if (query.error !== undefined || !query.code) return { ok: false, server: serverName, reason: "denied" };
    // 项目的 server 要重新取项目的目录：期间项目文件可能改了，或项目不再受信任。
    const catalog = entry.projectId === undefined ? undefined : await this.#options.projectCatalog?.(entry.projectId);
    const target = entry.projectId === undefined ? this.#target(serverName) : catalog ? this.#target(serverName, { id: entry.projectId, catalog }) : undefined;
    const server = target?.stored;
    if (!server || server.connection.url !== entry.serverUrl) return { ok: false, server: serverName, reason: "server_changed" };
    const provider = this.#provider(ownerKey, server, { pending: entry.pending });
    try {
      const result = await authorizeMcp(provider, {
        ...mcpOAuthFlowOptions(server), authorizationCode: query.code, ...(query.iss !== undefined ? { iss: query.iss } : {}), ...this.#requestOptions(),
      });
      return result === "AUTHORIZED" ? { ok: true, server: serverName } : { ok: false, server: serverName, reason: "exchange_failed" };
    } catch (error) {
      return { ok: false, server: serverName, reason: error instanceof OAuthIssuerMismatchError ? "issuer_mismatch" : "exchange_failed" };
    }
  }

  /** 断开：尽量在对方撤销 refresh token 与 access token（并行），然后删除本地凭证。撤销失败不阻止删除。 */
  async disconnect(ownerKey: string, serverName: string, project?: McpOAuthProject): Promise<boolean> {
    const target = this.#target(serverName, project);
    const key = target?.stored.name ?? serverName;
    const credential = await this.#options.store.getCredential(ownerKey, key);
    if (!credential) return false;
    const server = target?.stored;
    const endpoint = credential.discovery?.authorizationServerMetadata?.revocation_endpoint;
    if (server && credential.serverUrl === server.connection.url && typeof endpoint === "string" && isSecureEndpoint(endpoint)) {
      const client = await this.#provider(ownerKey, server, {}).clientInformation();
      if (client?.client_id === credential.clientId) {
        // 两个撤销互不依赖，并行发出，断开不必等两次往返。
        await Promise.all(([[credential.tokens.refresh_token, "refresh_token"], [credential.tokens.access_token, "access_token"]] as const)
          .filter(([token]) => token).map(([token, hint]) => this.#revoke(endpoint, client, token!, hint)));
      }
    }
    return this.#options.store.deleteCredential(ownerKey, key);
  }

  async #revoke(endpoint: string, client: OAuthClientInformationMixed, token: string, hint: string): Promise<void> {
    const body = new URLSearchParams({ token, token_type_hint: hint, client_id: client.client_id });
    if (client.client_secret) body.set("client_secret", client.client_secret);
    try {
      const response = await (this.#options.fetch ?? fetch)(endpoint, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await response.body?.cancel();
    } catch { /* 撤销只是尽力而为 */ }
  }

  #provider(ownerKey: string, server: McpOAuthCatalogServer, extra: { pending?: PendingMcpAuthorization; onRedirect?: (url: URL) => void }) {
    const secret = server.oauth.clientSecret;
    return new StoredMcpOAuthProvider({
      store: this.#options.store, ownerKey, server, redirectUrl: this.callbackUrl,
      clientName: this.#options.clientName ?? "pi-agent-server",
      ...(secret ? { clientSecret: resolveMcpPlaceholders(secret, { projectCwd: "" }) } : {}),
      ...(this.#options.now ? { now: this.#options.now } : {}),
      ...extra,
    });
  }

  #requestOptions() {
    return { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}) };
  }

  #targets(project?: McpOAuthProject): Target[] {
    return [...(project?.catalog ?? this.#options.catalog).servers.values()].filter(isOAuthServer)
      .map(server => this.#asTarget(server, project?.id));
  }

  #target(name: string, project?: McpOAuthProject): Target | undefined {
    const server = (project?.catalog ?? this.#options.catalog).servers.get(name);
    return server && isOAuthServer(server) ? this.#asTarget(server, project?.id) : undefined;
  }

  #asTarget(server: McpOAuthCatalogServer, projectId: string | undefined): Target {
    const name = storageName(server, projectId);
    return { server, stored: name === server.name ? server : { ...server, name } };
  }

  /** 每个用户最多保留最近 5 个、全服务最多 1000 个待处理授权，超出时丢弃最旧的。 */
  #remember(state: string, entry: PendingEntry): void {
    const own = [...this.#pending].filter(([, value]) => value.ownerKey === entry.ownerKey);
    for (const [key] of own.slice(0, Math.max(0, own.length - MAX_PENDING_PER_OWNER + 1))) this.#pending.delete(key);
    while (this.#pending.size >= MAX_PENDING) this.#pending.delete(this.#pending.keys().next().value!);
    this.#pending.set(state, entry);
  }

  #sweep(): void {
    const now = this.#now();
    for (const [state, entry] of this.#pending) if (entry.expiresAt <= now) this.#pending.delete(state);
  }
}

function isSecureEndpoint(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
}

function startError(error: unknown, server: McpOAuthCatalogServer, callbackUrl: string): McpOAuthStartError {
  if (error instanceof OAuthRegistrationError) {
    const insecure = parsePublicUrl(callbackUrl.slice(0, -MCP_OAUTH_CALLBACK_PATH.length)).insecure;
    if (/redirect_uri/i.test(error.body) && insecure) {
      return { code: "registration_rejected", message: `${server.oauth.label} 只接受 HTTPS 回调地址，请为本服务配置 HTTPS 后把 PI_PUBLIC_URL 改成 https 地址` };
    }
    return { code: "registration_rejected", message: `${server.oauth.label} 拒绝了客户端注册（HTTP ${error.status}）` };
  }
  if (error instanceof Error && /registration/i.test(error.message)) {
    return { code: "authorization_unavailable", message: `${server.oauth.label} 不支持自动注册，需要管理员在目录里配置 clientId` };
  }
  return { code: "authorization_unavailable", message: `暂时无法连接 ${server.oauth.label} 的授权服务，请稍后再试` };
}
