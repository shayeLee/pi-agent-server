// WP5D-2 buildApp 全局网络准入（HTTP 层，真实 buildApp + inject/真实 listen）：
// - 所有路由（/health /readyz /metrics /v1）先过 CIDR/disabled gate；CIDR 外 / disabled → 403；
// - 身份 = 直接 socket IP（canonical，IPv4-mapped 归一 v4；X-Forwarded-For 一律无效）；
// - /v1 且 tokenRequired：缺失/错误 token → 401；token off 忽略 Bearer；
// - 探针仅 IP gate（不要求 token）；token 不能绕过 CIDR；unknown socket IP failclosed 403；
// - 401/403 响应体不含原始 IP/token/path 值；ownerKey = ip:canonical。

import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import {
  makePolicy,
  makeTestIpAccess,
  OUTSIDE_IP,
  USER_IP_A,
  USER_IP_B,
} from "../helpers/ip-access.js";

async function makeApp(ipAccess = makeTestIpAccess()): Promise<FastifyInstance> {
  const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
  const app = buildApp({
    sessions,
    projects,
    defaultProjectCwd: "/tmp/default-project",
    ipAccess,
    createAdapter: async () => new MockAgentAdapter(),
  });
  return app;
}

const JSON_HEADERS = { "content-type": "application/json" };

describe("WP5D-2 全局准入（buildApp + inject）", () => {
  it("CIDR 内未登记 IP：无 token 创建会话，ownerKey = ip:canonical", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        remoteAddress: USER_IP_A,
        headers: JSON_HEADERS,
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().ownerKey).toBe(`ip:${USER_IP_A}`);
    } finally {
      await app.close();
    }
  });

  it("IPv4-mapped socket IP：ownerKey 用 canonical v4（::ffff:10.0.0.1 → ip:10.0.0.1）", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        remoteAddress: "::ffff:10.0.0.1",
        headers: JSON_HEADERS,
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().ownerKey).toBe("ip:10.0.0.1");
    } finally {
      await app.close();
    }
  });

  it("CIDR 外 → 403：/v1 与 /health /readyz /metrics 探针全部拦截", async () => {
    const app = await makeApp();
    try {
      for (const url of ["/v1/sessions", "/v1/models", "/health", "/readyz", "/metrics"]) {
        const res = await app.inject({ method: "GET", url, remoteAddress: OUTSIDE_IP });
        expect(res.statusCode, url).toBe(403);
        const body = JSON.stringify(res.json());
        expect(body).not.toContain(OUTSIDE_IP);
        expect(body).not.toContain(url);
      }
    } finally {
      await app.close();
    }
  });

  it("CIDR 外 + 有效策略 token → 仍 403（token 不能绕过 CIDR）", async () => {
    // 用「在 CIDR 内登记的 token」由 CIDR 外来源出示，验证 token 无法把 CIDR 外来源拉回准入。
    const policyIn = makePolicy([{ ip: USER_IP_A, tokenRequired: true, tokens: ["valid-token"] }]);
    const app = await makeApp(makeTestIpAccess({ policy: policyIn }));
    try {
      const res = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: OUTSIDE_IP,
        headers: { authorization: "Bearer valid-token" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain("valid-token");
      expect(res.body).not.toContain(OUTSIDE_IP);
    } finally {
      await app.close();
    }
  });

  it("X-Forwarded-For 不影响身份：外网对端伪造内网 XFF → 403；内网对端携带 XFF → 仍按对端 IP", async () => {
    const app = await makeApp();
    try {
      const forged = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: OUTSIDE_IP,
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      expect(forged.statusCode).toBe(403);

      const inside = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: USER_IP_A,
        headers: { "x-forwarded-for": "203.0.113.9" },
      });
      expect(inside.statusCode).toBe(200);
      // 身份 = 直接 socket IP（10.0.0.1），列表可见（ownerKey ip:10.0.0.1）
      const sessions = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        remoteAddress: USER_IP_A,
        headers: { ...JSON_HEADERS, "x-forwarded-for": "203.0.113.9" },
        payload: JSON.stringify({}),
      });
      expect(sessions.statusCode).toBe(201);
      expect(sessions.json().ownerKey).toBe(`ip:${USER_IP_A}`);
    } finally {
      await app.close();
    }
  });

  it("unknown socket IP（不可解析文本）→ failclosed 403，无泄漏", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: "not-an-ip" });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain("not-an-ip");
    } finally {
      await app.close();
    }
  });

  it("disabled 策略条目 → 403：/v1 与探针都拦截，出示 token 也不放行", async () => {
    const policy = makePolicy([{ ip: USER_IP_A, disabled: true }]);
    const app = await makeApp(makeTestIpAccess({ policy }));
    try {
      for (const url of ["/v1/sessions", "/health", "/readyz", "/metrics"]) {
        const res = await app.inject({
          method: "GET",
          url,
          remoteAddress: USER_IP_A,
          headers: { authorization: "Bearer whatever" },
        });
        expect(res.statusCode, url).toBe(403);
        expect(res.body).not.toContain("whatever");
      }
    } finally {
      await app.close();
    }
  });

  it("/v1 与 /metrics tokenRequired：缺失/错误 → 401；正确 → 200；/health、/readyz 免 token（仅 IP gate）", async () => {
    // WP5D-3：/metrics 仅 admin/operator，且其画像 tokenRequired 时实际 GET 仍须出示 token
    // （/health、/readyz 存活/就绪探针任意 admitted 且免 token）。
    const policy = makePolicy([{ ip: USER_IP_A, role: "admin", tokenRequired: true, tokens: ["secret"] }]);
    const app = await makeApp(makeTestIpAccess({ policy }));
    try {
      const missing = await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: USER_IP_A });
      expect(missing.statusCode).toBe(401);
      expect(missing.body).not.toContain(USER_IP_A);
      expect(missing.body).not.toContain("/v1/sessions");

      const wrong = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: USER_IP_A,
        headers: { authorization: "Bearer wrong" },
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.body).not.toContain("wrong");

      const ok = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: USER_IP_A,
        headers: { authorization: "Bearer secret" },
      });
      expect(ok.statusCode).toBe(200);

      // /metrics：tokenRequired 画像的实际 GET 仍要求 token（缺 401、正确 200）——role gate 不参与 token 判定。
      const metricsMissing = await app.inject({ method: "GET", url: "/metrics", remoteAddress: USER_IP_A });
      expect(metricsMissing.statusCode).toBe(401);
      expect(metricsMissing.body).not.toContain("secret");
      const metricsOk = await app.inject({
        method: "GET",
        url: "/metrics",
        remoteAddress: USER_IP_A,
        headers: { authorization: "Bearer secret" },
      });
      expect(metricsOk.statusCode).toBe(200);

      // /health：任意 admitted role 且免 token（存活探针不被 token 卡死）。
      const health = await app.inject({ method: "GET", url: "/health", remoteAddress: USER_IP_A });
      expect(health.statusCode).toBe(200);
      // /readyz 未注入 ops → 缺省对象恒未就绪 503（与准入无关：不被 token gate 拦成 401/403）
      const readyz = await app.inject({ method: "GET", url: "/readyz", remoteAddress: USER_IP_A });
      expect(readyz.statusCode).toBe(503);
      expect(readyz.body).not.toContain(USER_IP_A);
    } finally {
      await app.close();
    }
  });

  it("token off（未登记默认画像）：出示任意 Bearer 被忽略 → 200", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: USER_IP_A,
        headers: { authorization: "Bearer any" },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("策略 token 绑定精确 IP：其他 CIDR 内 IP 出示 → 401（token 不换绑）", async () => {
    const policy = makePolicy([
      { ip: USER_IP_A, tokenRequired: true, tokens: ["bound"] },
      { ip: "10.0.0.9", tokenRequired: true, tokens: ["other"] },
    ]);
    const app = await makeApp(makeTestIpAccess({ policy }));
    try {
      const res = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: "10.0.0.9",
        headers: { authorization: "Bearer bound" },
      });
      expect(res.statusCode).toBe(401);
      // 自己的 token 正常放行
      const ok = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: "10.0.0.9",
        headers: { authorization: "Bearer other" },
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("WP5D-2 真实 listen：remote address = TCP 对端", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close().catch(() => {})));
  });

  async function makeListeningApp(ipAccess = makeTestIpAccess()) {
    const app = await makeApp(ipAccess);
    await app.listen({ port: 0, host: "127.0.0.1" });
    apps.push(app);
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { app, port };
  }

  it("真实 TCP 连接：来源 127.0.0.1 → 身份 ip:127.0.0.1（ownerKey canonical）", async () => {
    const { app, port } = await makeListeningApp();
    // 经 inject 预置对端 127.0.0.1 的会话（与真实连接同一身份）
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      remoteAddress: "127.0.0.1",
      headers: JSON_HEADERS,
      payload: JSON.stringify({ title: "loopback" }),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().ownerKey).toBe("ip:127.0.0.1");

    // 真实 socket 连接（127.0.0.1）：health 可达、会话可读（同一 owner）
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    const list = await fetch(`http://127.0.0.1:${port}/v1/sessions`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as Array<{ title: string }>;
    expect(body.some((s) => s.title === "loopback")).toBe(true);
  });

  it("真实连接上的 X-Forwarded-For 不影响身份（仍按 TCP 对端 127.0.0.1）", async () => {
    const { app, port } = await makeListeningApp();
    await app.inject({
      method: "POST",
      url: "/v1/sessions",
      remoteAddress: "127.0.0.1",
      headers: JSON_HEADERS,
      payload: JSON.stringify({ title: "xff-ignored" }),
    });
    // 真实连接携带伪造 XFF（外网 IP）：身份仍为 127.0.0.1，能读到自己的会话
    const list = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      headers: { "x-forwarded-for": OUTSIDE_IP },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as Array<{ title: string }>;
    expect(body.some((s) => s.title === "xff-ignored")).toBe(true);
  });

  it("真实 TCP 上 tokenRequired 的 browser semantics：预检免 token，实际请求仍要求 token", async () => {
    process.env.CORS_ORIGINS = "https://app.example.com";
    const policy = makePolicy([{ ip: "127.0.0.1", tokenRequired: true, tokens: ["browser-secret"] }]);
    try {
      const { app, port } = await makeListeningApp(makeTestIpAccess({ policy }));
      const preflight = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
          "access-control-request-method": "GET",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.example.com");

      const noToken = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { origin: "https://app.example.com" },
      });
      expect(noToken.status).toBe(401);

      const withToken = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { origin: "https://app.example.com", authorization: "Bearer browser-secret" },
      });
      expect(withToken.status).toBe(200);
      expect(withToken.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    } finally {
      delete process.env.CORS_ORIGINS;
    }
  });

  it("真实 TCP 上不允许的 Origin 预检交由 CORS policy（无 ACAO）", async () => {
    process.env.CORS_ORIGINS = "https://app.example.com";
    try {
      const { app, port } = await makeListeningApp();
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        method: "OPTIONS",
        headers: {
          origin: "https://evil.example.com",
          "access-control-request-method": "GET",
        },
      });
      // @fastify/cors keeps the preflight status but withholds ACAO; the browser therefore
      // cannot use this response, and the request was not admitted as an allowed origin.
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      delete process.env.CORS_ORIGINS;
    }
  });
});

describe("WP5D-2 admission 先于 CORS 预检 short-circuit", () => {
  const CORS_ORIGIN = "https://app.example.com";
  const ORIGIN_HEADERS = {
    origin: CORS_ORIGIN,
    "access-control-request-method": "GET",
  };

  afterEach(() => {
    delete process.env.CORS_ORIGINS;
  });

  it("CIDR 外 OPTIONS（含合法 Origin）→ /v1 与全部探针均 403，且无任何 CORS 响应头/WWW-Authenticate", async () => {
    process.env.CORS_ORIGINS = CORS_ORIGIN;
    const app = await makeApp();
    try {
      for (const url of ["/v1/sessions", "/health", "/readyz", "/metrics"]) {
        const res = await app.inject({ method: "OPTIONS", url, remoteAddress: OUTSIDE_IP, headers: ORIGIN_HEADERS });
        expect(res.statusCode, url).toBe(403);
        expect(res.headers["access-control-allow-origin"], url).toBeUndefined();
        expect(res.headers["access-control-allow-methods"], url).toBeUndefined();
        expect(res.headers["www-authenticate"], url).toBeUndefined();
        expect(res.body).not.toContain(OUTSIDE_IP);
      }
    } finally {
      await app.close();
    }
  });

  it("CIDR 外 OPTIONS 即使携带合法 Origin + 有效 token → 仍 403（token 不能绕过 CIDR）", async () => {
    process.env.CORS_ORIGINS = CORS_ORIGIN;
    const policyIn = makePolicy([{ ip: USER_IP_A, tokenRequired: true, tokens: ["valid-token"] }]);
    const app = await makeApp(makeTestIpAccess({ policy: policyIn }));
    try {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/v1/sessions",
        remoteAddress: OUTSIDE_IP,
        headers: { ...ORIGIN_HEADERS, authorization: "Bearer valid-token" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("allowed 预检正常：/v1 与探针 OPTIONS（合法 Origin）→ 204 + ACAO，不因准入拦截", async () => {
    process.env.CORS_ORIGINS = CORS_ORIGIN;
    const app = await makeApp();
    try {
      for (const url of ["/v1/sessions", "/health", "/readyz", "/metrics"]) {
        const res = await app.inject({ method: "OPTIONS", url, remoteAddress: USER_IP_A, headers: ORIGIN_HEADERS });
        expect(res.statusCode, url).toBe(204);
        expect(res.headers["access-control-allow-origin"], url).toBe(CORS_ORIGIN);
        const methods = String(res.headers["access-control-allow-methods"] ?? "");
        expect(methods, url).toContain("GET");
      }
    } finally {
      await app.close();
    }
  });

  it("tokenRequired 画像：合规预检免 token（/v1 与 /metrics），非预检 OPTIONS 仍要求 token", async () => {
    process.env.CORS_ORIGINS = CORS_ORIGIN;
    const policy = makePolicy([{ ip: USER_IP_A, tokenRequired: true, tokens: ["preflight-secret"] }]);
    const app = await makeApp(makeTestIpAccess({ policy }));
    try {
      for (const url of ["/v1/sessions", "/metrics"]) {
        const preflight = await app.inject({ method: "OPTIONS", url, remoteAddress: USER_IP_A, headers: ORIGIN_HEADERS });
        expect(preflight.statusCode, url).toBe(204);
        expect(preflight.headers["access-control-allow-origin"], url).toBe(CORS_ORIGIN);

        const incomplete = await app.inject({
          method: "OPTIONS",
          url,
          remoteAddress: USER_IP_A,
          headers: { origin: CORS_ORIGIN },
        });
        expect(incomplete.statusCode, url).toBe(401);
        expect(incomplete.headers["www-authenticate"], url).toBe("Bearer");

        const nonPreflight = await app.inject({ method: "OPTIONS", url, remoteAddress: USER_IP_A });
        expect(nonPreflight.statusCode, url).toBe(401);
        expect(nonPreflight.headers["www-authenticate"], url).toBe("Bearer");
      }
      // /health、/readyz 探针与预检一样不被 token gate；非预检 OPTIONS 也免（探针不被 token 卡死）。
      const probeOptions = await app.inject({ method: "OPTIONS", url: "/health", remoteAddress: USER_IP_A });
      expect(probeOptions.statusCode).not.toBe(401);
    } finally {
      await app.close();
    }
  });

  it("tokenRequired 画像：不允许的 Origin 不会被预检豁免为成功", async () => {
    process.env.CORS_ORIGINS = CORS_ORIGIN;
    const policy = makePolicy([{ ip: USER_IP_A, tokenRequired: true, tokens: ["preflight-secret"] }]);
    const app = await makeApp(makeTestIpAccess({ policy }));
    try {
      const malicious = await app.inject({
        method: "OPTIONS",
        url: "/v1/sessions",
        remoteAddress: USER_IP_A,
        headers: {
          origin: "https://evil.example.com",
          "access-control-request-method": "GET",
        },
      });
      // The CORS plugin's static-origin policy returns the preflight status but no ACAO
      // for a disallowed origin; browser CORS therefore blocks it.
      expect(malicious.statusCode).toBe(204);
      expect(malicious.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe("WP5D-2 401/403 响应头契约（WWW-Authenticate）", () => {
  it("401：固定 `WWW-Authenticate: Bearer`（无 realm/无敏感）；403：不带 WWW-Authenticate", async () => {
    const policy = makePolicy([{ ip: USER_IP_A, tokenRequired: true, tokens: ["sekrit"] }]);
    const app = await makeApp(makeTestIpAccess({ policy }));
    try {
      const missing = await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: USER_IP_A });
      expect(missing.statusCode).toBe(401);
      expect(missing.headers["www-authenticate"]).toBe("Bearer");
      expect(missing.body).not.toContain("sekrit");

      const wrong = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: USER_IP_A,
        headers: { authorization: "Bearer wrong" },
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.headers["www-authenticate"]).toBe("Bearer");

      // 403（CIDR 外 / disabled）：无 WWW-Authenticate
      const outside = await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: OUTSIDE_IP });
      expect(outside.statusCode).toBe(403);
      expect(outside.headers["www-authenticate"]).toBeUndefined();

      const policyDisabled = makePolicy([{ ip: USER_IP_B, disabled: true }]);
      const app2 = await makeApp(makeTestIpAccess({ policy: policyDisabled }));
      try {
        const disabled = await app2.inject({ method: "GET", url: "/v1/sessions", remoteAddress: USER_IP_B });
        expect(disabled.statusCode).toBe(403);
        expect(disabled.headers["www-authenticate"]).toBeUndefined();
      } finally {
        await app2.close();
      }
    } finally {
      await app.close();
    }
  });
});

describe("buildApp 准入配置 failfast（必要边界，零副作用）", () => {
  // failfast 发生在任何资源/路由注册之前，故用未初始化的 stub 依赖即可证明
  // 校验不触碰任何 Handler 依赖（零副作用、零清理）。
  function stubDeps(ipAccess: unknown): never {
    return {
      sessions: null,
      projects: null,
      defaultProjectCwd: "/tmp/default-project",
      ipAccess,
      createAdapter: async (): Promise<MockAgentAdapter> => new MockAgentAdapter(),
    } as never;
  }

  it("ipAccess 缺失/伪造/未知字段 → 同步抛错，不创建任何 Fastify 实例/路由（零副作用、无需 close）", () => {
    const good = makeTestIpAccess();
    for (const [name, value] of [
      ["ipAccess 缺失", undefined],
      ["unknown intranetCidrs", { ...good, intranetCidrs: ["SECRET-INTRA"] }],
      ["unknown tokens", { ...good, tokens: { "SECRET-TOKEN": "acct" } }],
      ["unknown trustProxy", { ...good, trustProxy: "SECRET-PROXY" }],
      ["ipAccess 非对象", "bypass"],
      ["ipAccess 空对象", {}],
    ] as const) {
      expect(() => buildApp(stubDeps(value))).toThrow(/ipAccess|allowedClientCidrs/);
    }
  });

  it("合法准入配置 → buildApp 不抛错并正常服务请求", async () => {
    const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
    const app = buildApp({
      sessions,
      projects,
      defaultProjectCwd: "/tmp/default-project",
      ipAccess: makeTestIpAccess(),
      createAdapter: async () => new MockAgentAdapter(),
    });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: USER_IP_A });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});