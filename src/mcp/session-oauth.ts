// 会话里使用用户 MCP 凭证（docs/mcp-integration.md §13.9）。
// 在 SDK 的 adaptOAuthProvider 外面再包一层：
// - 到期前 60 秒主动刷新，避免请求先吃一次 401；
// - 同一用户同一 server 的刷新在进程内串行，并在锁里重读数据库：同一用户开着的多个会话
//   各有一个 provider 实例，SDK 只能合并同一实例内的并发 401，跨会话要靠这里；
// - 需要用户重新授权时，把 SDK 的 McpOAuthAuthorizationRequiredError 换成可读的错误。

import type { AuthProvider, McpFetch, UnauthorizedContext } from "@earendil-works/pi-mcp";
import { adaptOAuthProvider, authorizeMcp, McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import type { McpOAuthStorePort } from "../application/ports/mcp-oauth-store-port.js";
import { mcpOAuthFlowOptions, StoredMcpOAuthProvider, type McpOAuthCatalogServer } from "./oauth-provider.js";

const REFRESH_MARGIN_MS = 60_000;

/** 按 key 串行执行的进程内锁（部署是单实例，见 docs/architecture.md）。 */
export class KeyedLock {
  readonly #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => {});
    this.#tails.set(key, tail);
    void tail.then(() => { if (this.#tails.get(key) === tail) this.#tails.delete(key); });
    return result;
  }
}

export interface SessionAuthProviderOptions {
  readonly store: McpOAuthStorePort;
  readonly ownerKey: string;
  readonly server: McpOAuthCatalogServer;
  readonly redirectUrl: string;
  readonly clientName: string;
  readonly clientSecret?: string;
  readonly locks: KeyedLock;
  readonly fetch?: McpFetch;
  readonly now?: () => number;
}

export class McpReauthorizationRequiredError extends Error {
  constructor(label: string) {
    super(`${label} 授权已失效，请在 MCP 面板重新连接`);
    this.name = "McpReauthorizationRequiredError";
  }
}

export function createSessionAuthProvider(options: SessionAuthProviderOptions): AuthProvider {
  const { store, ownerKey, server, locks } = options;
  const now = options.now ?? Date.now;
  const provider = new StoredMcpOAuthProvider({
    store, ownerKey, server, redirectUrl: options.redirectUrl, clientName: options.clientName,
    ...(options.clientSecret !== undefined ? { clientSecret: options.clientSecret } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const inner = adaptOAuthProvider(provider);
  const key = JSON.stringify([ownerKey, server.name]);
  const reauthorize = () => new McpReauthorizationRequiredError(server.oauth.label);
  const credential = async () => {
    const record = await store.getCredential(ownerKey, server.name);
    return record && record.serverUrl === server.connection.url ? record : undefined;
  };
  const nearExpiry = (expiresAt: number | null) => expiresAt !== null && expiresAt - now() < REFRESH_MARGIN_MS;
  const translate = (error: unknown): never => {
    throw error instanceof McpOAuthAuthorizationRequiredError ? reauthorize() : error;
  };

  return {
    async token() {
      const current = await credential();
      if (!current) throw reauthorize();
      if (nearExpiry(current.expiresAt) && current.tokens.refresh_token) {
        await locks.run(key, async () => {
          // 别的会话可能已在锁里刷新过。
          const latest = await credential();
          if (!latest || !nearExpiry(latest.expiresAt)) return;
          try {
            await authorizeMcp(provider, { ...mcpOAuthFlowOptions(server), ...(options.fetch ? { fetch: options.fetch } : {}) });
          } catch (error) {
            if (error instanceof McpOAuthAuthorizationRequiredError) throw reauthorize();
            // 网络等临时错误：旧 token 还没过期就先用着，过期了由 401 路径再试。
          }
        });
      }
      const token = (await provider.tokens())?.access_token;
      if (token === undefined) throw reauthorize();
      return token;
    },
    async onUnauthorized(context: UnauthorizedContext) {
      await locks.run(key, async () => {
        // 拿着旧 token 的请求遇到 401 时，别的会话可能已经换了新 token：直接重试，不再刷新。
        const current = (await provider.tokens())?.access_token;
        if (current !== undefined && context.token !== undefined && current !== context.token) return;
        await inner.onUnauthorized!(context).catch(translate);
      });
    },
  };
}
