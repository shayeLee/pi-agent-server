// 按用户 MCP OAuth 的 Kysely 实现（SQLite 与 PostgreSQL 共用）。客户端信息与 token 以 JSON 明文
// 交给 McpTokenCipher 加密后入库，附加数据绑定表名与主键。解不开或形状不对的行按不存在处理。
import type { Kysely } from "kysely";
import type { OAuthClientInformationMixed, OAuthDiscoveryState, OAuthTokens } from "@earendil-works/pi-mcp/oauth";
import type { DatabaseSchema } from "./db-schema.js";
import type { McpOAuthClientRecord, McpOAuthStorePort, UserMcpCredentialRecord } from "../application/ports/mcp-oauth-store-port.js";
import type { McpTokenCipher } from "../mcp/token-cipher.js";

const clientAad = (serverName: string) => JSON.stringify(["mcp_oauth_clients", serverName]);
const credentialAad = (ownerKey: string, serverName: string) => JSON.stringify(["user_mcp_credentials", ownerKey, serverName]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

const nullableNumber = (value: unknown) => value === null || value === undefined ? null : Number(value);

export class KyselyMcpOAuthRepository implements McpOAuthStorePort {
  constructor(private readonly db: Kysely<DatabaseSchema>, private readonly cipher: McpTokenCipher) {}

  async getClient(serverName: string): Promise<McpOAuthClientRecord | undefined> {
    const row = await this.db.selectFrom("mcp_oauth_clients").selectAll().where("server_name", "=", serverName).executeTakeFirst();
    if (!row) return undefined;
    const client = this.open(row.client, clientAad(serverName));
    if (!isRecord(client) || typeof client.client_id !== "string") return undefined;
    return {
      serverName: row.server_name, serverUrl: row.server_url, redirectUrl: row.redirect_url,
      client: client as unknown as OAuthClientInformationMixed, registeredAt: Number(row.registered_at),
    };
  }

  async putClient(record: McpOAuthClientRecord): Promise<void> {
    const values = {
      server_url: record.serverUrl,
      redirect_url: record.redirectUrl,
      client: this.cipher.encrypt(JSON.stringify(record.client), clientAad(record.serverName)),
      registered_at: record.registeredAt,
    };
    await this.db.insertInto("mcp_oauth_clients").values({ server_name: record.serverName, ...values })
      .onConflict(conflict => conflict.column("server_name").doUpdateSet(values)).execute();
  }

  async deleteClient(serverName: string): Promise<void> {
    await this.db.deleteFrom("mcp_oauth_clients").where("server_name", "=", serverName).execute();
  }

  async getCredential(ownerKey: string, serverName: string): Promise<UserMcpCredentialRecord | undefined> {
    const row = await this.db.selectFrom("user_mcp_credentials").selectAll()
      .where("owner_key", "=", ownerKey).where("server_name", "=", serverName).executeTakeFirst();
    return row ? this.toCredential(row) : undefined;
  }

  async putCredential(record: UserMcpCredentialRecord): Promise<void> {
    const values = {
      server_url: record.serverUrl,
      client_id: record.clientId,
      account_label: record.accountLabel,
      tokens: this.cipher.encrypt(JSON.stringify(record.tokens), credentialAad(record.ownerKey, record.serverName)),
      expires_at: record.expiresAt,
      scope: record.scope,
      discovery: record.discovery === null ? null : JSON.stringify(record.discovery),
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
    // 替换时保留最初的连接时间。
    const { created_at: _createdAt, ...update } = values;
    await this.db.insertInto("user_mcp_credentials").values({ owner_key: record.ownerKey, server_name: record.serverName, ...values })
      .onConflict(conflict => conflict.columns(["owner_key", "server_name"]).doUpdateSet(update)).execute();
  }

  async deleteCredential(ownerKey: string, serverName: string): Promise<boolean> {
    const result = await this.db.deleteFrom("user_mcp_credentials")
      .where("owner_key", "=", ownerKey).where("server_name", "=", serverName).executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  async listCredentials(ownerKey: string): Promise<UserMcpCredentialRecord[]> {
    const rows = await this.db.selectFrom("user_mcp_credentials").selectAll()
      .where("owner_key", "=", ownerKey).orderBy("server_name").execute();
    return rows.map(row => this.toCredential(row)).filter((record): record is UserMcpCredentialRecord => record !== undefined);
  }

  private toCredential(row: {
    owner_key: string; server_name: string; server_url: string; client_id: string; account_label: string | null; tokens: string;
    expires_at: unknown; scope: string | null; discovery: string | null; created_at: unknown; updated_at: unknown;
  }): UserMcpCredentialRecord | undefined {
    const tokens = this.open(row.tokens, credentialAad(row.owner_key, row.server_name));
    if (!isRecord(tokens) || typeof tokens.access_token !== "string" || typeof tokens.token_type !== "string") return undefined;
    const discovery = row.discovery === null ? null : parseJson(row.discovery);
    return {
      ownerKey: row.owner_key, serverName: row.server_name, serverUrl: row.server_url, clientId: row.client_id,
      accountLabel: row.account_label, tokens: tokens as unknown as OAuthTokens,
      expiresAt: nullableNumber(row.expires_at), scope: row.scope,
      // 发现结果只是缓存，形状不对时丢弃，下次重新发现。
      discovery: isRecord(discovery) && typeof discovery.authorizationServerUrl === "string" ? discovery as unknown as OAuthDiscoveryState : null,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }

  private open(ciphertext: string, aad: string): unknown {
    try { return parseJson(this.cipher.decrypt(ciphertext, aad)); } catch { return undefined; }
  }
}
