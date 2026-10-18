// 测试用的最小 OAuth 授权服务器（以 fetch 函数的形式注入 SDK）：发现、动态注册、
// 授权码换 token、刷新（轮换 refresh token）、撤销。只在内存里，不监听端口。

export const MCP = "https://mcp.example.test/mcp";
export const ISSUER = "https://auth.example.test";

export class FakeAuthorizationServer {
  /** 像 Linear 一样只接受 https 或 loopback 的 http 回调地址。 */
  rejectPlainHttpRedirects = false;
  registrations: Array<Record<string, unknown>> = [];
  revocations: URLSearchParams[] = [];
  tokenRequests: URLSearchParams[] = [];
  codes = new Map<string, { clientId: string }>();
  refreshTokens = new Map<string, number>();
  issued = 0;

  idToken(claims: Record<string, unknown>) {
    return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  }

  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.href === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") {
      return json({ resource: MCP, authorization_servers: [ISSUER], scopes_supported: ["read", "write"] });
    }
    if (url.href === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        authorization_response_iss_parameter_supported: true, revocation_endpoint: `${ISSUER}/revoke`,
      });
    }
    if (url.href === `${ISSUER}/register` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const plainHttp = (body.redirect_uris as string[]).some(uri => uri.startsWith("http://") && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri));
      if (this.rejectPlainHttpRedirects && plainHttp) return json({ error: "invalid_redirect_uri", error_description: "plaintext HTTP is allowed only for loopback addresses" }, 400);
      this.registrations.push(body);
      return json({ ...body, client_id: `dcr-${this.registrations.length}` }, 201);
    }
    if (url.href === `${ISSUER}/token` && init?.method === "POST") {
      const params = new URLSearchParams(String(init.body));
      this.tokenRequests.push(params);
      if (params.get("grant_type") === "authorization_code") {
        const code = this.codes.get(params.get("code") ?? "");
        if (!code || code.clientId !== params.get("client_id")) return json({ error: "invalid_grant", error_description: "bad code" }, 400);
        return json(this.#tokens({ id_token: this.idToken({ email: "someone@example.com" }) }));
      }
      if (params.get("grant_type") === "refresh_token") {
        const refresh = params.get("refresh_token") ?? "";
        if (!this.refreshTokens.delete(refresh)) return json({ error: "invalid_grant", error_description: "revoked" }, 400);
        return json(this.#tokens());
      }
    }
    if (url.href === `${ISSUER}/revoke` && init?.method === "POST") {
      const params = new URLSearchParams(String(init.body));
      this.revocations.push(params);
      this.refreshTokens.delete(params.get("token") ?? "");
      return new Response(null, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  #tokens(extra: Record<string, unknown> = {}) {
    this.issued++;
    const refresh = `rt-${this.issued}`;
    this.refreshTokens.set(refresh, this.issued);
    return { access_token: `at-${this.issued}`, token_type: "bearer", expires_in: 3600, refresh_token: refresh, ...extra };
  }
}

