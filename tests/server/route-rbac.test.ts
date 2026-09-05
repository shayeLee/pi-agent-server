// WP5D-3 路由授权（docs/ip-rbac-design.md §6 冻结矩阵）：
// - 每角色（admin/user/viewer/operator）× 每路由类别：探针 / metrics / 纯读 GET / 写变更 / SSE；
// - unknown/forged access failclosed（纯决策函数 + 未声明 permission 路由 default-deny）；
// - /metrics 仅 admin/operator；CORS 预检不做 role（先 admission 后放行）；403 固定 body 不泄
//   role/IP/path；401 保持 token 语义（role gate 不前置 token gate）；user/admin 跨 owner 404 不变
//   （admin 暂不跨 owner）；SSE viewer 只读可、writes 拒且零 service side effects。
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.js";
import { identityKey } from "../../src/core/user-identity.js";
import type { IpRole } from "../../src/core/ip-access-policy.js";
import {
  evaluateRouteAuthorization,
  FORBIDDEN_BODY,
} from "../../src/server/route-rbac.js";
import { createOperationStatus } from "../../src/server/ops-status.js";
import type { SseSocket } from "../../src/server/sse-socket.js";
import { RuntimeRegistry } from "../../src/runtime/runtime-registry.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess } from "../helpers/ip-access.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import type { SessionStorePort } from "../../src/application/ports/session-store-port.js";

const ROLES: readonly IpRole[] = ["admin", "user", "viewer", "operator"];
/** 每角色一个来源 IP（四个用户 = 四个 IP；一个 IP = 一个用户）。 */
const ROLE_IP: Record<IpRole, string> = {
  admin: "10.0.0.20",
  user: "10.0.0.21",
  viewer: "10.0.0.22",
  operator: "10.0.0.23",
};
/** 另一个普通用户（跨 owner 隔离 / 越权 404 验证）。 */
const OTHER_USER_IP = "10.0.0.24";
const OTHER_USER_OWNER = identityKey({ kind: "ip", ip: OTHER_USER_IP });

const JSON_HEADERS = { "content-type": "application/json" };
const FIXED_403_BODY = JSON.stringify(FORBIDDEN_BODY);

function ownerOf(ip: string): string {
  return identityKey({ kind: "ip", ip });
}

function rolePolicy() {
  return makePolicy((ROLES as readonly IpRole[]).map((role) => ({ ip: ROLE_IP[role], role })));
}

async function makeRbacApp(opts: { readyOps?: boolean } = {}): Promise<{
  app: FastifyInstance;
  sessions: SessionStorePort;
  adapters: Map<string, MockAgentAdapter>;
}> {
  const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
  const adapters = new Map<string, MockAgentAdapter>();
  const app = buildApp({
    sessions,
    projects,
    defaultProjectCwd: "/tmp/default-project",
    defaultModel: null,
    modelCatalog: {
      getAvailable: async () => [],
      isAvailable: async () => false,
    },
    ipAccess: makeTestIpAccess({ policy: rolePolicy() }),
    createAdapter: async (sessionId) => {
      const adapter = new MockAgentAdapter();
      adapters.set(sessionId, adapter);
      return adapter;
    },
    ...(opts.readyOps
      ? { ops: createOperationStatus({ ready: true, migrationGate: "off", storageDialect: "sqlite" }) }
      : {}),
  });
  return { app, sessions, adapters };
}

/** 直接经 repository 预置一个会话（绕过 HTTP 创建，供任何角色拥有）。 */
async function seedSession(sessions: SessionStorePort, ownerKey: string, id: string, title: string): Promise<void> {
  await sessions.create({
    id,
    ownerKey,
    projectId: DEFAULT_PROJECT_ID,
    title,
    createdAt: 1,
    updatedAt: 1,
    piSessionFile: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    systemPrompt: null,
    capabilityVersions: null,
  });
}

describe("evaluateRouteAuthorization（纯函数：unknown/forged access failclosed）", () => {
  it("每已知角色命中其允许的权限 → allowed", () => {
    expect(evaluateRouteAuthorization("probe:health", "viewer")).toEqual({ verdict: "allowed" });
    expect(evaluateRouteAuthorization("probe:readyz", "operator")).toEqual({ verdict: "allowed" });
    expect(evaluateRouteAuthorization("probe:metrics", "admin")).toEqual({ verdict: "allowed" });
    expect(evaluateRouteAuthorization("probe:metrics", "operator")).toEqual({ verdict: "allowed" });
    expect(evaluateRouteAuthorization("models:list", "viewer")).toEqual({ verdict: "allowed" });
    expect(evaluateRouteAuthorization("sessions:list", "viewer")).toEqual({ verdict: "allowed" });
    expect(evaluateRouteAuthorization("sessions:export", "viewer")).toEqual({ verdict: "allowed" });
    expect(evaluateRouteAuthorization("sessions:events", "viewer")).toEqual({ verdict: "allowed" });
    expect(evaluateRouteAuthorization("sessions:create", "user")).toEqual({ verdict: "allowed" });
    expect(evaluateRouteAuthorization("projects:create", "admin")).toEqual({ verdict: "allowed" });
  });

  it("role 缺失/未知/伪造 → denied role-forbidden（failclosed，绝不误放行）", () => {
    expect(evaluateRouteAuthorization("models:list", undefined)).toEqual({ verdict: "denied", reason: "role-forbidden" });
    expect(evaluateRouteAuthorization("models:list", null)).toEqual({ verdict: "denied", reason: "role-forbidden" });
    expect(evaluateRouteAuthorization("models:list", "")).toEqual({ verdict: "denied", reason: "role-forbidden" });
    expect(evaluateRouteAuthorization("models:list", "superuser")).toEqual({ verdict: "denied", reason: "role-forbidden" });
    expect(evaluateRouteAuthorization("models:list", "guest")).toEqual({ verdict: "denied", reason: "role-forbidden" });
    expect(evaluateRouteAuthorization("models:list", 42)).toEqual({ verdict: "denied", reason: "role-forbidden" });
    // 任何权限点都不接受未知 role（包括最强权限）
    expect(evaluateRouteAuthorization("probe:metrics", "hacker")).toEqual({ verdict: "denied", reason: "role-forbidden" });
  });

  it("permission 未知/未声明 → denied undeclared（default-deny）", () => {
    expect(evaluateRouteAuthorization(undefined, "admin")).toEqual({ verdict: "denied", reason: "undeclared" });
    expect(evaluateRouteAuthorization("futuristic:route", "admin")).toEqual({ verdict: "denied", reason: "undeclared" });
    expect(evaluateRouteAuthorization(123, "admin")).toEqual({ verdict: "denied", reason: "undeclared" });
  });

  it("角色不具备的权限 → denied role-forbidden（矩阵边界）", () => {
    expect(evaluateRouteAuthorization("probe:metrics", "user")).toEqual({ verdict: "denied", reason: "role-forbidden" });
    expect(evaluateRouteAuthorization("probe:metrics", "viewer")).toEqual({ verdict: "denied", reason: "role-forbidden" });
    expect(evaluateRouteAuthorization("models:list", "operator")).toEqual({ verdict: "denied", reason: "role-forbidden" });
    expect(evaluateRouteAuthorization("sessions:create", "viewer")).toEqual({ verdict: "denied", reason: "role-forbidden" });
    expect(evaluateRouteAuthorization("sessions:send-message", "viewer")).toEqual({ verdict: "denied", reason: "role-forbidden" });
    expect(evaluateRouteAuthorization("sessions:control", "viewer")).toEqual({ verdict: "denied", reason: "role-forbidden" });
    expect(evaluateRouteAuthorization("projects:create", "operator")).toEqual({ verdict: "denied", reason: "role-forbidden" });
  });
});

describe("WP5D-3 权限矩阵：探针 / metrics", () => {
  it("/health、/readyz 任意 admitted role → 200；/metrics 仅 admin/operator → 200，user/viewer → 固定 403", async () => {
    const { app } = await makeRbacApp({ readyOps: true });
    try {
      for (const role of ROLES) {
        const ip = ROLE_IP[role];
        expect((await app.inject({ method: "GET", url: "/health", remoteAddress: ip })).statusCode, `${role} health`).toBe(200);
        expect((await app.inject({ method: "GET", url: "/readyz", remoteAddress: ip })).statusCode, `${role} readyz`).toBe(200);
        const metrics = await app.inject({ method: "GET", url: "/metrics", remoteAddress: ip });
        if (role === "admin" || role === "operator") {
          expect(metrics.statusCode, `${role} metrics`).toBe(200);
          expect(metrics.body).toContain("pi_agent_server_ready 1");
        } else {
          expect(metrics.statusCode, `${role} metrics`).toBe(403);
          expect(metrics.body).toBe(FIXED_403_BODY);
          // 403 不泄 role/IP/path
          expect(metrics.body).not.toContain(role);
          expect(metrics.body).not.toContain(ip);
          expect(metrics.body).not.toContain("/metrics");
          expect(metrics.headers["www-authenticate"]).toBeUndefined();
        }
      }
    } finally {
      await app.close();
    }
  });
});

describe("WP5D-3 权限矩阵：/v1 只读列表 GET", () => {
  it("GET /v1/models、/v1/projects、/v1/sessions：viewer/user/admin → 200；operator → 固定 403", async () => {
    const { app } = await makeRbacApp();
    try {
      for (const role of ROLES) {
        const ip = ROLE_IP[role];
        for (const url of ["/v1/models", "/v1/projects", "/v1/sessions"]) {
          const res = await app.inject({ method: "GET", url, remoteAddress: ip });
          if (role === "operator") {
            expect(res.statusCode, `${role} ${url}`).toBe(403);
            expect(res.body).toBe(FIXED_403_BODY);
            expect(res.body).not.toContain(ip);
            expect(res.body).not.toContain(url);
          } else {
            expect(res.statusCode, `${role} ${url}`).toBe(200);
          }
        }
      }
    } finally {
      await app.close();
    }
  });
});

describe("WP5D-3 权限矩阵：创建写（POST）", () => {
  it("POST /v1/projects、/v1/sessions：user/admin → 201；viewer/operator → 固定 403 且零 side effects", async () => {
    const { app, sessions } = await makeRbacApp();
    try {
      const viewerOwner = ownerOf(ROLE_IP.viewer);
      const operatorOwner = ownerOf(ROLE_IP.operator);
      const beforeViewer = await sessions.listByOwner(viewerOwner);
      const beforeOperator = await sessions.listByOwner(operatorOwner);
      for (const role of ROLES) {
        const ip = ROLE_IP[role];
        for (const [url, payload] of [
          ["/v1/projects", { name: `p-${role}`, cwd: `/ws/${role}` }],
          ["/v1/sessions", { title: `s-${role}` }],
        ] as const) {
          const res = await app.inject({ method: "POST", url, remoteAddress: ip, headers: JSON_HEADERS, payload: JSON.stringify(payload) });
          if (role === "viewer" || role === "operator") {
            expect(res.statusCode, `${role} ${url}`).toBe(403);
            expect(res.body).toBe(FIXED_403_BODY);
            expect(res.body).not.toContain(role);
            expect(res.body).not.toContain(ip);
          } else {
            expect(res.statusCode, `${role} ${url}`).toBe(201);
          }
        }
      }
      // viewer/operator 的创建写被拒 → 名下没有任何新会话（零 service side effects）。
      expect(await sessions.listByOwner(viewerOwner)).toEqual(beforeViewer);
      expect(await sessions.listByOwner(operatorOwner)).toEqual(beforeOperator);
    } finally {
      await app.close();
    }
  });
});

describe("WP5D-3 权限矩阵：own 资源子路由", () => {
  it("export/rename/config/delete/messages/steer/follow-ups/abort：viewer 仅 export 可读，其余 403；operator 全部 403", async () => {
    const { app, sessions } = await makeRbacApp();
    try {
      const expectedByRoute: Array<{
        name: string;
        method: "GET" | "PATCH" | "DELETE" | "POST";
        path: (id: string) => string;
        payload?: object;
        viewerAllowed: boolean;
      }> = [
        { name: "export", method: "GET", path: (id) => `/v1/sessions/${id}/export`, viewerAllowed: true },
        { name: "rename", method: "PATCH", path: (id) => `/v1/sessions/${id}`, payload: { title: "改" }, viewerAllowed: false },
        { name: "config", method: "PATCH", path: (id) => `/v1/sessions/${id}/config`, payload: { thinkingLevel: "low" }, viewerAllowed: false },
        { name: "messages", method: "POST", path: (id) => `/v1/sessions/${id}/messages`, payload: { requestId: "r", prompt: "hi" }, viewerAllowed: false },
        { name: "steer", method: "POST", path: (id) => `/v1/sessions/${id}/steer`, payload: { text: "改" }, viewerAllowed: false },
        { name: "follow-ups", method: "POST", path: (id) => `/v1/sessions/${id}/follow-ups`, payload: { text: "追加" }, viewerAllowed: false },
        { name: "abort", method: "POST", path: (id) => `/v1/sessions/${id}/abort`, viewerAllowed: false },
        { name: "delete", method: "DELETE", path: (id) => `/v1/sessions/${id}`, viewerAllowed: false },
      ];

      // 每个 op 各自预置全新会话（delete 在自身会话上执行，不影响其他 op 的状态断言）。
      for (const op of expectedByRoute) {
        const sessionIdByRole: Record<IpRole, string> = {} as Record<IpRole, string>;
        for (const role of ROLES) {
          const id = `own-${role}-${op.name}`;
          await seedSession(sessions, ownerOf(ROLE_IP[role]), id, id);
          sessionIdByRole[role] = id;
        }
        for (const role of ROLES) {
          const opts = {
            method: op.method,
            url: op.path(sessionIdByRole[role]),
            remoteAddress: ROLE_IP[role],
            ...(op.payload !== undefined ? { headers: JSON_HEADERS, payload: JSON.stringify(op.payload) } : {}),
          };
          const res = await app.inject(opts);
          if (role === "operator") {
            // operator 全部 /v1 → 403（含纯读 export）。
            expect(res.statusCode, `${role} ${op.name}`).toBe(403);
            continue;
          }
          if (role === "viewer") {
            if (op.viewerAllowed) {
              expect(res.statusCode, `viewer ${op.name}`).toBe(200);
            } else {
              expect(res.statusCode, `viewer ${op.name}`).toBe(403);
              expect(res.body).toBe(FIXED_403_BODY);
            }
            continue;
          }
          // user/admin：own-resource 现有行为（导出 200；messages 202；rename/config 200；
          // delete 204；steer/follow-ups/abort 无活动任务 → 409）。
          if (op.name === "export") expect(res.statusCode, `${role} ${op.name}`).toBe(200);
          else if (op.name === "messages") expect(res.statusCode, `${role} ${op.name}`).toBe(202);
          else if (op.name === "rename" || op.name === "config") expect(res.statusCode, `${role} ${op.name}`).toBe(200);
          else if (op.name === "delete") expect(res.statusCode, `${role} ${op.name}`).toBe(204);
          else expect(res.statusCode, `${role} ${op.name}`).toBe(409); // steer/follow-ups/abort
        }
      }

      // viewer 全部写请求被拒 → 会话记录逐字节不变（零 service side effects：
      // piSessionFile 未 lazy 创建、title/updatedAt 未动、模型/思考级别未配）。
      const viewerBefore = await sessions.get(`own-viewer-messages`);
      const viewerId = `own-viewer-messages`;
      await app.inject({
        method: "POST",
        url: `/v1/sessions/${viewerId}/messages`,
        remoteAddress: ROLE_IP.viewer,
        headers: JSON_HEADERS,
        payload: JSON.stringify({ requestId: "again", prompt: "再试" }),
      });
      const viewerAfter = await sessions.get(viewerId);
      expect(viewerAfter).toEqual(viewerBefore);
    } finally {
      await app.close();
    }
  });

  it("viewer 的写请求不创建任何 runtime/adapter（路由层拒绝，未触达 service）", async () => {
    const { app, sessions, adapters } = await makeRbacApp();
    try {
      await seedSession(sessions, ownerOf(ROLE_IP.viewer), "v-write", "v");
      const ops = [
        { method: "POST", url: "/v1/sessions/v-write/messages", payload: { requestId: "r", prompt: "hi" } },
        { method: "POST", url: "/v1/sessions/v-write/abort" },
        { method: "POST", url: "/v1/sessions/v-write/steer", payload: { text: "x" } },
        { method: "POST", url: "/v1/sessions/v-write/follow-ups", payload: { text: "y" } },
        { method: "PATCH", url: "/v1/sessions/v-write", payload: { title: "恶意改名" } },
        { method: "PATCH", url: "/v1/sessions/v-write/config", payload: { thinkingLevel: "low" } },
        { method: "DELETE", url: "/v1/sessions/v-write" },
      ] as const;
      for (const op of ops) {
        const res = await app.inject({
          method: op.method,
          url: op.url,
          remoteAddress: ROLE_IP.viewer,
          ...("payload" in op && op.payload !== undefined
            ? { headers: JSON_HEADERS, payload: JSON.stringify(op.payload) }
            : {}),
        });
        expect(res.statusCode, `${op.method} ${op.url}`).toBe(403);
        expect(res.body).toBe(FIXED_403_BODY);
      }
      // 零 side effects：session 记录不变、无 activity、无 runtime/adapter 被创建。
      const after = await sessions.get("v-write");
      expect(after).toMatchObject({
        id: "v-write",
        ownerKey: ownerOf(ROLE_IP.viewer),
        title: "v",
        piSessionFile: null,
      });
      expect(adapters.get("v-write")).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("跨 owner 404 不变：user 访问他人会话 → 404；admin 同样只读自己的（暂不跨 owner）", async () => {
    const { app, sessions } = await makeRbacApp();
    try {
      await seedSession(sessions, OTHER_USER_OWNER, "other-session", "他人的");
      // user 访问他人会话：子资源全部 404（越权与不存在统一 404，不泄存在性）。
      for (const [method, url] of [
        ["GET", "/v1/sessions/other-session/export"],
        ["GET", "/v1/sessions/other-session/events"],
        ["PATCH", "/v1/sessions/other-session"],
        ["DELETE", "/v1/sessions/other-session"],
        ["POST", "/v1/sessions/other-session/messages"],
      ] as const) {
        const res = await app.inject({
          method,
          url,
          remoteAddress: ROLE_IP.user,
          ...(method === "PATCH" ? { headers: JSON_HEADERS, payload: JSON.stringify({ title: "x" }) } : {}),
          ...(method === "POST" ? { headers: JSON_HEADERS, payload: JSON.stringify({ requestId: "r", prompt: "x" }) } : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect((await sessions.get("other-session"))?.title).toBe("他人的");
      }
      // admin 暂不跨 owner：admin 对他人会话的只读/删除同样 404（无跨 owner 能力）。
      for (const [method, url] of [
        ["GET", "/v1/sessions/other-session/export"],
        ["DELETE", "/v1/sessions/other-session"],
      ] as const) {
        const res = await app.inject({ method, url, remoteAddress: ROLE_IP.admin });
        expect(res.statusCode, `admin ${method} ${url}`).toBe(404);
      }
      expect(await sessions.get("other-session")).not.toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe("WP5D-3 默认拒绝与鉴权顺序", () => {
  it("未声明 permission 的新增路由 → default-deny 固定 403（漏接线不误放行）", async () => {
    const { app } = await makeRbacApp();
    try {
      app.get("/v1/undeclared", async () => ({ ok: true }));
      app.get("/v1/declared", { config: { permission: "models:list" } }, async () => ({ ok: true }));
      // 未声明 → 403（固定 body）；已声明且角色匹配 → 200。
      const undeclared = await app.inject({ method: "GET", url: "/v1/undeclared", remoteAddress: ROLE_IP.user });
      expect(undeclared.statusCode).toBe(403);
      expect(undeclared.body).toBe(FIXED_403_BODY);
      const declared = await app.inject({ method: "GET", url: "/v1/declared", remoteAddress: ROLE_IP.viewer });
      expect(declared.statusCode).toBe(200);
      expect(declared.json()).toEqual({ ok: true });
      // operator 对已声明只读权限 → 403。
      const op = await app.inject({ method: "GET", url: "/v1/declared", remoteAddress: ROLE_IP.operator });
      expect(op.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("tokenRequired 语义保持：缺失/错误 token → 401（即使角色本可访问），正确 token 后角色 gate 生效", async () => {
    // 单独构建：viewer IP 配 tokenRequired（同一 IP 上 token 与 role 并存）。
    const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
    const app = buildApp({
      sessions,
      projects,
      defaultProjectCwd: "/tmp/default-project",
      ipAccess: makeTestIpAccess({
        policy: makePolicy([
          { ip: ROLE_IP.viewer, role: "viewer", tokenRequired: true, tokens: ["viewer-token"] },
          { ip: ROLE_IP.user, role: "user" },
        ]),
      }),
      createAdapter: async () => new MockAgentAdapter(),
    });
    try {
      // 缺失 token：401（token gate 先于 role gate；WWW-Authenticate 固定 Bearer）。
      const missing = await app.inject({ method: "GET", url: "/v1/models", remoteAddress: ROLE_IP.viewer });
      expect(missing.statusCode).toBe(401);
      expect(missing.headers["www-authenticate"]).toBe("Bearer");
      expect(missing.body).not.toContain(ROLE_IP.viewer);
      const wrong = await app.inject({
        method: "GET",
        url: "/v1/models",
        remoteAddress: ROLE_IP.viewer,
        headers: { authorization: "Bearer wrong" },
      });
      expect(wrong.statusCode).toBe(401);
      // 正确 token：viewer 读 models 200。
      const ok = await app.inject({
        method: "GET",
        url: "/v1/models",
        remoteAddress: ROLE_IP.viewer,
        headers: { authorization: "Bearer viewer-token" },
      });
      expect(ok.statusCode).toBe(200);
      // 正确 token + viewer 写 → 403（role gate 对实际请求生效）。
      const write = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        remoteAddress: ROLE_IP.viewer,
        headers: { authorization: "Bearer viewer-token", ...JSON_HEADERS },
        payload: JSON.stringify({ title: "x" }),
      });
      expect(write.statusCode).toBe(403);
      expect(write.body).toBe(FIXED_403_BODY);
    } finally {
      await app.close();
    }
  });

  it("CORS 预检不做 role/token：viewer/operator 的合规预检 → 204 + ACAO（随后实际请求才 role gate）", async () => {
    process.env.CORS_ORIGINS = "https://app.example.com";
    const { app } = await makeRbacApp();
    try {
      // 合规预检（OPTIONS + Origin + Access-Control-Request-Method）→ 204 + ACAO，无 role gate。
      for (const role of ["viewer", "operator", "user", "admin"] as const) {
        for (const url of ["/v1/sessions", "/v1/models"]) {
          const res = await app.inject({
            method: "OPTIONS",
            url,
            remoteAddress: ROLE_IP[role],
            headers: {
              origin: "https://app.example.com",
              "access-control-request-method": "GET",
            },
          });
          expect(res.statusCode, `${role} preflight ${url}`).toBe(204);
          expect(res.headers["access-control-allow-origin"], `${role} ${url}`).toBe("https://app.example.com");
        }
      }
      // 展示实际请求 role gate：viewer 预检通过的 GET 读可（200），operator 同一预检后的实际请求 403。
      const viewerGet = await app.inject({ method: "GET", url: "/v1/models", remoteAddress: ROLE_IP.viewer, headers: { origin: "https://app.example.com" } });
      expect(viewerGet.statusCode).toBe(200);
      const operatorGet = await app.inject({ method: "GET", url: "/v1/models", remoteAddress: ROLE_IP.operator, headers: { origin: "https://app.example.com" } });
      expect(operatorGet.statusCode).toBe(403);
    } finally {
      await app.close();
      delete process.env.CORS_ORIGINS;
    }
  });
});

describe("WP5D-3 SSE：viewer 只读可，writes 拒", () => {
  it("viewer 已有 runtime 的会话可订阅：写头成功、流保持打开；无 runtime 返回 204；operator 403 且零 SSE 响应", async () => {
    const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
    await seedSession(sessions, ownerOf(ROLE_IP.viewer), "v-live", "viewer-live");
    await seedSession(sessions, ownerOf(ROLE_IP.viewer), "v-events", "viewer-session");
    await seedSession(sessions, ownerOf(ROLE_IP.operator), "op-events", "operator-session");

    // 预置 viewer 会话的 runtime（注入共享 registry；生产组合不注入，测试用于验证已有 runtime 的订阅路径）。
    const adapters = new Map<string, MockAgentAdapter>();
    const registry = new RuntimeRegistry({
      concurrency: new ConcurrencyController({
        globalLimit: 20, perUserLimit: 2, perUserQueueLimit: 10, globalQueueLimit: 100, queueTimeoutMs: 300_000,
      }),
      createAdapter: async (sessionId) => {
        const adapter = new MockAgentAdapter();
        adapters.set(sessionId, adapter);
        return adapter;
      },
    });
    await registry.getOrCreate("v-live", ownerOf(ROLE_IP.viewer));

    const sseHeaders: Array<{ status: number; headers: Record<string, unknown> }> = [];
    const flushCounts: number[] = [];
    const app = buildApp({
      sessions,
      projects,
      defaultProjectCwd: "/tmp/default-project",
      ipAccess: makeTestIpAccess({ policy: rolePolicy() }),
      registry,
      sseSocketFactory: (replyRaw, requestRaw): SseSocket => ({
        writeHead: (status, headers) => {
          sseHeaders.push({ status, headers: { ...headers } });
          replyRaw.writeHead(status, headers);
        },
        flushHeaders: () => {
          flushCounts.push(1);
          replyRaw.flushHeaders();
          // 测试夹具：写头成功即收尾，让 inject 在握手断言后立即返回（流建立≠需要一直开着）。
          setImmediate(() => replyRaw.end());
        },
        write: (data) => replyRaw.write(data),
        end: () => replyRaw.end(),
        onClose: (cb) => requestRaw.on("close", cb),
      }),
      createAdapter: async () => new MockAgentAdapter(),
    });
    try {
      // viewer + 已有 runtime：SSE 连接建立（200 + text/event-stream + flushHeaders = 订阅成功，只读可）。
      const viewer = await app.inject({ method: "GET", url: "/v1/sessions/v-live/events", remoteAddress: ROLE_IP.viewer });
      expect(viewer.statusCode).toBe(200);
      expect(sseHeaders.length).toBeGreaterThanOrEqual(1);
      expect(sseHeaders[0]!.status).toBe(200);
      expect(String(sseHeaders[0]!.headers["Content-Type"]).toLowerCase()).toBe("text/event-stream");
      expect(flushCounts.length).toBeGreaterThanOrEqual(1);

      // viewer + 无 runtime（v-events 未预置 runtime）：稳定 204，零 SSE 响应、零副作用。
      const sseHeadersBefore = sseHeaders.length;
      const noRuntime = await app.inject({ method: "GET", url: "/v1/sessions/v-events/events", remoteAddress: ROLE_IP.viewer });
      expect(noRuntime.statusCode).toBe(204);
      expect(sseHeaders.length).toBe(sseHeadersBefore);
      expect(flushCounts.length).toBe(sseHeadersBefore);

      // operator：SSE 被 403 拒（无 writeHead/无 flush = 未建立任何流）。
      const operator = await app.inject({ method: "GET", url: "/v1/sessions/op-events/events", remoteAddress: ROLE_IP.operator });
      expect(operator.statusCode).toBe(403);
      expect(operator.body).toBe(FIXED_403_BODY);
      expect(sseHeaders.length).toBe(sseHeadersBefore);
      expect(flushCounts.length).toBe(sseHeadersBefore);
    } finally {
      await app.close();
    }
  });

  it("viewer 的 export 只读：不创建 runtime（registry 保持为空、DB 记录不变）", async () => {
    const { app, sessions, adapters } = await makeRbacApp();
    try {
      await seedSession(sessions, ownerOf(ROLE_IP.viewer), "v-export", "v");
      const res = await app.inject({ method: "GET", url: "/v1/sessions/v-export/export", remoteAddress: ROLE_IP.viewer });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ messages: [], lastEventId: 0 });
      expect(adapters.get("v-export")).toBeUndefined();
      expect(await sessions.get("v-export")).toMatchObject({ id: "v-export", piSessionFile: null });
    } finally {
      await app.close();
    }
  });
});