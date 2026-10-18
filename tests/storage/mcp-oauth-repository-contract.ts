// KyselyMcpOAuthRepository 的行为契约，SQLite（tests/storage）与 PostgreSQL（tests/postgres）各注册一次。
import { describe, expect, it } from "vitest";
import type { McpOAuthStorePort, UserMcpCredentialRecord } from "../../src/application/ports/mcp-oauth-store-port.js";

export interface McpOAuthRepositoryContractStorage {
  readonly store: McpOAuthStorePort;
  /** 同一个库，换一把密钥的仓储。 */
  readonly otherKeyStore: McpOAuthStorePort;
  /** 两张表的全部原始行（序列化后检查有无明文）。 */
  rawRows(): Promise<unknown>;
  /** 把 from 用户那行的 tokens 密文原样复制到 to 用户那行。 */
  copyTokensCiphertext(fromOwner: string, toOwner: string, serverName: string): Promise<void>;
  close(): Promise<void>;
}

export const credential = (patch: Partial<UserMcpCredentialRecord> = {}): UserMcpCredentialRecord => ({
  ownerKey: "ip:10.0.0.1", serverName: "linear", serverUrl: "https://mcp.linear.app/mcp", clientId: "client-1",
  accountLabel: null, tokens: { access_token: "access-secret", token_type: "bearer", refresh_token: "refresh-secret", expires_in: 86100 },
  // 超过 32 位整数的毫秒时间戳，PostgreSQL 的 BIGINT 必须原样读回 number。
  expiresAt: 1_792_300_000_000, scope: "read", discovery: { authorizationServerUrl: "https://mcp.linear.app" }, createdAt: 1_792_200_000_000, updatedAt: 1_792_200_000_000,
  ...patch,
});

export function defineMcpOAuthRepositoryContract(name: string, setup: () => Promise<McpOAuthRepositoryContractStorage>): void {
  describe(name, () => {
    async function withStorage(run: (storage: McpOAuthRepositoryContractStorage) => Promise<void>): Promise<void> {
      const storage = await setup();
      try { await run(storage); } finally { await storage.close(); }
    }

    it("stores one dynamically registered client per server", () => withStorage(async ({ store }) => {
      expect(await store.getClient("linear")).toBeUndefined();
      await store.putClient({ serverName: "linear", serverUrl: "https://mcp.linear.app/mcp", redirectUrl: "https://a/cb", client: { client_id: "c1" }, registeredAt: 1 });
      await store.putClient({ serverName: "linear", serverUrl: "https://mcp.linear.app/mcp", redirectUrl: "https://b/cb", client: { client_id: "c2", client_secret: "s2" }, registeredAt: 1_792_200_000_000 });
      expect(await store.getClient("linear")).toEqual({
        serverName: "linear", serverUrl: "https://mcp.linear.app/mcp", redirectUrl: "https://b/cb", client: { client_id: "c2", client_secret: "s2" }, registeredAt: 1_792_200_000_000,
      });
      await store.deleteClient("linear");
      expect(await store.getClient("linear")).toBeUndefined();
    }));

    it("keeps one credential per caller and server, and keeps the first connection time on replace", () => withStorage(async ({ store }) => {
      await store.putCredential(credential());
      await store.putCredential(credential({ ownerKey: "ip:10.0.0.2", accountLabel: "b@example.com" }));
      const replaced = credential({ tokens: { access_token: "access-2", token_type: "bearer" }, expiresAt: null, createdAt: 1_792_250_000_000, updatedAt: 1_792_250_000_000 });
      await store.putCredential(replaced);
      expect(await store.getCredential("ip:10.0.0.1", "linear")).toEqual({ ...replaced, createdAt: credential().createdAt });
      expect((await store.listCredentials("ip:10.0.0.2")).map(row => row.accountLabel)).toEqual(["b@example.com"]);
      expect(await store.deleteCredential("ip:10.0.0.1", "linear")).toBe(true);
      expect(await store.deleteCredential("ip:10.0.0.1", "linear")).toBe(false);
      expect(await store.listCredentials("ip:10.0.0.1")).toEqual([]);
    }));

    it("writes only ciphertext for tokens and client secrets", () => withStorage(async ({ store, rawRows }) => {
      await store.putCredential(credential());
      await store.putClient({ serverName: "linear", serverUrl: "https://mcp.linear.app/mcp", redirectUrl: "https://a/cb", client: { client_id: "c1", client_secret: "client-secret" }, registeredAt: 1 });
      const dump = JSON.stringify(await rawRows());
      for (const secret of ["access-secret", "refresh-secret", "client-secret"]) expect(dump).not.toContain(secret);
    }));

    it("treats ciphertext copied to another row, or read with another key, as missing", () => withStorage(async ({ store, otherKeyStore, copyTokensCiphertext }) => {
      await store.putCredential(credential());
      await store.putCredential(credential({ ownerKey: "ip:10.0.0.2", tokens: { access_token: "other", token_type: "bearer" } }));
      await copyTokensCiphertext("ip:10.0.0.1", "ip:10.0.0.2", "linear");
      expect(await store.getCredential("ip:10.0.0.2", "linear")).toBeUndefined();
      expect(await store.listCredentials("ip:10.0.0.2")).toEqual([]);
      expect(await store.getCredential("ip:10.0.0.1", "linear")).toBeDefined();
      expect(await otherKeyStore.getCredential("ip:10.0.0.1", "linear")).toBeUndefined();
    }));
  });
}
