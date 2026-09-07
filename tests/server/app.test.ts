import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.js";
import { identityKey } from "../../src/core/user-identity.js";
import type { SessionRecord, SessionStorePort } from "../../src/application/ports/session-store-port.js";
import type { ModelCatalogPort } from "../../src/application/ports/model-catalog-port.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makeTestIpAccess, USER_IP_A, USER_IP_B } from "../helpers/ip-access.js";

// WP5D-2：身份 = 直接 socket IP（canonical）；两个测试用户 = 两个来源 IP。
const IP_A = USER_IP_A;
const IP_B = USER_IP_B;
const OWNER_A = identityKey({ kind: "ip", ip: IP_A });
const OWNER_B = identityKey({ kind: "ip", ip: IP_B });

async function makeApp(defaults: {
  defaultModel?: { provider: string; id: string; name: string } | null;
  defaultThinkingLevel?: string;
  resolveSystemPrompt?: (cwd: string) => Promise<string>;
  modelCatalog?: ModelCatalogPort;
} = {}): Promise<{ app: FastifyInstance; sessions: SessionStorePort; adapters: Map<string, MockAgentAdapter> }> {
  const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
  const adapters = new Map<string, MockAgentAdapter>();
  const app = buildApp({
    sessions,
    projects,
    defaultProjectCwd: "/tmp/default-project",
    defaultModel: defaults.defaultModel,
    defaultThinkingLevel: defaults.defaultThinkingLevel,
    systemPromptResolver: defaults.resolveSystemPrompt
      ? { resolve: defaults.resolveSystemPrompt }
      : undefined,
    modelCatalog: defaults.modelCatalog ?? {
      getAvailable: async () => [
        { provider: "deepseek", id: "v4-pro", name: "DeepSeek V4 Pro" },
        { provider: "openai-codex", id: "gpt-5", name: "GPT-5" },
      ],
      isAvailable: async (provider, modelId) =>
        ["deepseek/v4-pro", "openai-codex/gpt-5"].includes(`${provider}/${modelId}`),
    },
    ipAccess: makeTestIpAccess(),
    createAdapter: async (sessionId) => {
      const adapter = new MockAgentAdapter();
      adapters.set(sessionId, adapter);
      return adapter;
    },
  });
  return { app, sessions, adapters };
}

const JSON_HEADERS = { "content-type": "application/json" };

async function createSession(
  app: FastifyInstance,
  ip: string,
  title?: string,
): Promise<Omit<SessionRecord, "agentKind" | "conversationFormat" | "conversationRef">> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    remoteAddress: ip,
    headers: JSON_HEADERS,
    payload: JSON.stringify(title === undefined ? {} : { title }),
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe("HTTP 层：鉴权与会话 CRUD（needs.md §4.2）", () => {
  describe("GET /health", () => {
    it("免鉴权返回 { status: ok }", async () => {
      const { app } = await makeApp();
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok" });
    });
  });

  describe("网络准入边界（WP5D-2）", () => {
    it("CIDR 外访问 /v1/sessions 返回 403（默认拒绝模型）", async () => {
      const { app } = await makeApp();
      const res = await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: "203.0.113.9" });
      expect(res.statusCode).toBe(403);
    });

    it("CIDR 内未登记 IP 免 token 访问 /v1/sessions 返回 200（token off 默认画像）", async () => {
      const { app } = await makeApp();
      const res = await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: IP_A });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("POST /v1/sessions", () => {
    it("创建会话返回 201 且字段完整", async () => {
      const { app } = await makeApp();
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ title: "项目 alpha" }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toEqual(expect.any(String));
      expect(body.ownerKey).toBe(OWNER_A);
      expect(body.title).toBe("项目 alpha");
      expect(body.createdAt).toEqual(expect.any(Number));
      expect(body.updatedAt).toEqual(expect.any(Number));
      expect(body.updatedAt).toBeGreaterThanOrEqual(body.createdAt);
    });

    it("另一来源 IP 创建会话 ownerKey 为 ip: 前缀（一个 IP = 一个用户）", async () => {
      const { app } = await makeApp();
      const created = await createSession(app, IP_B, "来源 B 会话");
      expect(created.ownerKey).toBe(OWNER_B);
    });

    it("未传 title 时默认空标题", async () => {
      const { app } = await makeApp();
      const created = await createSession(app, IP_A);
      expect(created.title).toBe("");
    });
  });

  describe("GET /v1/sessions", () => {
    it("只返回当前用户会话，且按 updatedAt 降序", async () => {
      const { app, sessions } = await makeApp();
      // 直接经注入的 repository 预置不同 updatedAt 的记录，验证排序与用户隔离
      const owner = OWNER_A;
      const other = OWNER_B;
      for (const rec of [
        { id: "s-old", ownerKey: owner, projectId: DEFAULT_PROJECT_ID, title: "旧", createdAt: 1000, updatedAt: 1000, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: null, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null },
        { id: "s-new", ownerKey: owner, projectId: DEFAULT_PROJECT_ID, title: "新", createdAt: 3000, updatedAt: 3000, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: null, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null },
        { id: "s-mid", ownerKey: owner, projectId: DEFAULT_PROJECT_ID, title: "中", createdAt: 2000, updatedAt: 2000, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: null, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null },
        { id: "s-other", ownerKey: other, projectId: DEFAULT_PROJECT_ID, title: "他人", createdAt: 9999, updatedAt: 9999, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: null, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null },
      ]) {
        await sessions.create(rec);
      }

      const res = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: IP_A,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.map((s: { id: string }) => s.id)).toEqual(["s-new", "s-mid", "s-old"]);
      expect(body.some((s: { id: string }) => s.id === "s-other")).toBe(false);
    });

    it("不同用户各自只能看到自己的会话", async () => {
      const { app } = await makeApp();
      await createSession(app, IP_A, "我的");
      await createSession(app, IP_B, "别人的");

      const ipList = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: IP_A,
      });
      expect(ipList.json()).toHaveLength(1);
      expect(ipList.json()[0]).toMatchObject({ title: "我的", ownerKey: OWNER_A });

      const acctList = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: IP_B,
      });
      expect(acctList.json()).toHaveLength(1);
      expect(acctList.json()[0]).toMatchObject({ title: "别人的", ownerKey: OWNER_B });
    });
  });

  describe("DELETE /v1/sessions/:id", () => {
    it("删除自己的会话返回 204，列表不再包含且存储已删除", async () => {
      const { app, sessions } = await makeApp();
      const { id } = await createSession(app, IP_A, "待删除");

      const res = await app.inject({
        method: "DELETE",
        url: `/v1/sessions/${id}`,
        remoteAddress: IP_A,
      });
      expect(res.statusCode).toBe(204);

      expect(await sessions.get(id)).toBeNull();
      const list = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: IP_A,
      });
      expect(list.json().some((s: { id: string }) => s.id === id)).toBe(false);
    });

    it("删除不存在的会话返回 404", async () => {
      const { app } = await makeApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/v1/sessions/no-such-id",
        remoteAddress: IP_A,
      });
      expect(res.statusCode).toBe(404);
    });

    it("删除他人的会话返回 404 且记录保留", async () => {
      const { app, sessions } = await makeApp();
      const { id } = await createSession(app, IP_B, "别人的");

      const res = await app.inject({
        method: "DELETE",
        url: `/v1/sessions/${id}`,
        remoteAddress: IP_A,
      });
      expect(res.statusCode).toBe(404);
      expect(await sessions.get(id)).not.toBeNull();
    });
  });

  describe("PATCH /v1/sessions/:id", () => {
    it("重命名自己的会话返回 200 并反映新 title", async () => {
      const { app, sessions } = await makeApp();
      const { id } = await createSession(app, IP_A, "旧标题");
      const before = await sessions.get(id);

      const res = await app.inject({
        method: "PATCH",
        url: `/v1/sessions/${id}`,
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ title: "新标题" }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ id, ownerKey: OWNER_A, title: "新标题" });
      expect(body.updatedAt).toBeGreaterThanOrEqual(before?.updatedAt ?? 0);

      const after = await sessions.get(id);
      expect(after?.title).toBe("新标题");
    });

    it("重命名不存在的会话返回 404", async () => {
      const { app } = await makeApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/v1/sessions/no-such-id",
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ title: "任意" }),
      });
      expect(res.statusCode).toBe(404);
    });

    it("重命名他人的会话返回 404 且 title 不变", async () => {
      const { app, sessions } = await makeApp();
      const { id } = await createSession(app, IP_B, "别人的");

      const res = await app.inject({
        method: "PATCH",
        url: `/v1/sessions/${id}`,
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ title: "恶意改名" }),
      });
      expect(res.statusCode).toBe(404);
      expect((await sessions.get(id))?.title).toBe("别人的");
    });
  });

  describe("多项目", () => {
    async function createProject(
      app: FastifyInstance,
      token: string,
      name: string,
      cwd: string,
    ) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: JSON_HEADERS, remoteAddress: token,
        payload: JSON.stringify({ name, cwd }),
      });
      expect(res.statusCode).toBe(201);
      return res.json() as { id: string; name: string; cwd: string };
    }

    it("GET /v1/projects 返回默认项目 + 该用户项目", async () => {
      const { app } = await makeApp();
      await createProject(app, IP_A, "我的仓库", "/path/a");
      await createProject(app, IP_B, "他人项目", "/path/b");

      const res = await app.inject({
        method: "GET",
        url: "/v1/projects",
        remoteAddress: IP_A,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ id: string; name: string; cwd: string; isDefault: boolean }>;
      expect(body[0]).toMatchObject({
        id: DEFAULT_PROJECT_ID,
        name: "默认项目",
        cwd: "/tmp/default-project",
        isDefault: true,
      });
      expect(body.some((p) => p.name === "我的仓库")).toBe(true);
      expect(body.some((p) => p.name === "他人项目")).toBe(false);
    });

    it("创建会话时不带 projectId 归默认项目", async () => {
      const { app, sessions } = await makeApp();
      const created = await createSession(app, IP_A, "默认项目会话");
      expect(created.projectId).toBe(DEFAULT_PROJECT_ID);
      expect((await sessions.get(created.id))?.projectId).toBe(DEFAULT_PROJECT_ID);
    });

    it("创建会话带 projectId 归到指定项目；无效 projectId 返回 404", async () => {
      const { app } = await makeApp();
      const project = await createProject(app, IP_A, "仓库", "/path/a");

      const ok = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ title: "项目会话", projectId: project.id }),
      });
      expect(ok.statusCode).toBe(201);
      expect(ok.json().projectId).toBe(project.id);

      const bad = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ projectId: "no-such-project" }),
      });
      expect(bad.statusCode).toBe(404);
    });

    it("删除额外项目级联删除其下会话；默认项目不可删", async () => {
      const { app, sessions } = await makeApp();
      const project = await createProject(app, IP_A, "仓库", "/path/a");

      // 该项目下建两个会话
      const s1 = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ projectId: project.id, title: "会话1" }),
      });
      const s2 = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ projectId: project.id, title: "会话2" }),
      });
      expect(s1.statusCode).toBe(201);
      expect(s2.statusCode).toBe(201);

      // 删除项目
      const del = await app.inject({
        method: "DELETE",
        url: `/v1/projects/${project.id}`,
        remoteAddress: IP_A,
      });
      expect(del.statusCode).toBe(204);
      expect(await sessions.get(s1.json().id)).toBeNull();
      expect(await sessions.get(s2.json().id)).toBeNull();

      // 默认项目不可删
      const delDefault = await app.inject({
        method: "DELETE",
        url: `/v1/projects/${DEFAULT_PROJECT_ID}`,
        remoteAddress: IP_A,
      });
      expect(delDefault.statusCode).toBe(400);
    });

    it("GET /v1/sessions?projectId= 按项目过滤", async () => {
      const { app } = await makeApp();
      const project = await createProject(app, IP_A, "仓库", "/path/a");
      const a = await createSession(app, IP_A, "默认会话");
      const b = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ projectId: project.id, title: "项目会话" }),
      });
      expect(b.statusCode).toBe(201);

      const filtered = await app.inject({
        method: "GET",
        url: `/v1/sessions?projectId=${project.id}`,
        remoteAddress: IP_A,
      });
      const body = filtered.json() as Array<{ id: string }>;
      expect(body.map((s) => s.id)).toEqual([b.json().id]);
      expect(body.some((s) => s.id === a.id)).toBe(false);
    });
  });

  describe("模型与思考级别", () => {
    it("GET /v1/models 返回可用模型 + 思考级别枚举", async () => {
      const { app } = await makeApp();
      const res = await app.inject({ method: "GET", url: "/v1/models", remoteAddress: IP_A });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        models: Array<{ provider: string; id: string; name: string }>;
        thinkingLevels: string[];
        defaultModel: { provider: string; id: string; name: string } | null;
        defaultThinkingLevel: string;
      };
      expect(body.models.some((m) => m.provider === "deepseek" && m.id === "v4-pro")).toBe(true);
      expect(body.thinkingLevels).toContain("high");
      expect(body.thinkingLevels).toContain("off");
      expect(body.defaultModel).toBeNull();
      expect(body.defaultThinkingLevel).toBe("medium");
    });

    it("GET /v1/models 返回配置的实际服务端默认值", async () => {
      const { app } = await makeApp({
        defaultModel: { provider: "openai-codex", id: "gpt-5", name: "GPT-5" },
        defaultThinkingLevel: "high",
      });
      const res = await app.inject({ method: "GET", url: "/v1/models", remoteAddress: IP_A });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        defaultModel: { provider: "openai-codex", id: "gpt-5" },
        defaultThinkingLevel: "high",
      });
    });

    it("创建会话写入按项目解析的系统提示词", async () => {
      const { app, sessions } = await makeApp({
        resolveSystemPrompt: async (cwd) => `Pi 默认提示词：${cwd}`,
      });
      const created = await createSession(app, IP_A);

      expect(created.systemPrompt).toBe("Pi 默认提示词：/tmp/default-project");
      expect((await sessions.get(created.id))?.systemPrompt).toBe("Pi 默认提示词：/tmp/default-project");
    });

    it("创建会话可指定模型与思考级别并持久化", async () => {
      const { app, sessions } = await makeApp();
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({
          title: "配模型",
          modelProvider: "deepseek",
          modelId: "v4-pro",
          thinkingLevel: "high",
        }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.modelProvider).toBe("deepseek");
      expect(body.modelId).toBe("v4-pro");
      expect(body.thinkingLevel).toBe("high");
      expect((await sessions.get(body.id))?.modelProvider).toBe("deepseek");
    });

    it("创建会话时模型不成对或非法 thinkingLevel 返回 400（与 PATCH 语义一致）", async () => {
      const { app } = await makeApp();

      const half = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ modelProvider: "deepseek" }),
      });
      expect(half.statusCode).toBe(400);

      const badLevel = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ thinkingLevel: "super-high" }),
      });
      expect(badLevel.statusCode).toBe(400);
    });

    it("创建会话时无效模型返回 400（不静默回退默认）", async () => {
      const { app } = await makeApp();
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ modelProvider: "deepseek", modelId: "no-such-model" }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("创建会话时模型可用性检查失败（catalog 抛错）返回 503 且不创建会话", async () => {
      const { app, sessions } = await makeApp({
        modelCatalog: {
          getAvailable: async () => [],
          isAvailable: async () => { throw new Error("凭证读取失败"); },
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ modelProvider: "deepseek", modelId: "v4-pro" }),
      });
      expect(res.statusCode).toBe(503);
      // 无副作用：不创建会话
      expect(await sessions.listByOwner(OWNER_A)).toEqual([]);
    });

    it("PATCH /v1/sessions/:id/config 切换模型与思考级别并透传 adapter", async () => {
      const { app, sessions, adapters } = await makeApp();
      const { id } = await createSession(app, IP_A, "切模型");

      const res = await app.inject({
        method: "PATCH",
        url: `/v1/sessions/${id}/config`,
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ modelProvider: "openai-codex", modelId: "gpt-5", thinkingLevel: "low" }),
      });
      expect(res.statusCode).toBe(200);
      const got = await sessions.get(id);
      expect(got?.modelProvider).toBe("openai-codex");
      expect(got?.modelId).toBe("gpt-5");
      expect(got?.thinkingLevel).toBe("low");
      // 透传 adapter：setModel/setThinkingLevel 被精确调用
      expect(adapters.get(id)?.calls).toEqual([
        { method: "setModel", provider: "openai-codex", modelId: "gpt-5" },
        { method: "setThinkingLevel", level: "low" },
      ]);
    });

    it("PATCH config 部分更新：仅改 thinkingLevel 保留已有模型", async () => {
      const { app, sessions } = await makeApp();
      const { id } = await createSession(app, IP_A, "部分更新");

      // 先设置完整配置
      await app.inject({
        method: "PATCH",
        url: `/v1/sessions/${id}/config`,
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ modelProvider: "deepseek", modelId: "v4-pro", thinkingLevel: "high" }),
      });

      // 只更新 thinkingLevel，模型应保留（COALESCE 不覆盖未提供字段）
      const res = await app.inject({
        method: "PATCH",
        url: `/v1/sessions/${id}/config`,
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ thinkingLevel: "low" }),
      });
      expect(res.statusCode).toBe(200);

      const got = await sessions.get(id);
      expect(got?.modelProvider).toBe("deepseek");
      expect(got?.modelId).toBe("v4-pro");
      expect(got?.thinkingLevel).toBe("low");
    });

    it("PATCH config 模型不成对返回 400；非法 thinkingLevel 返回 400", async () => {
      const { app } = await makeApp();
      const { id } = await createSession(app, IP_A, "校验");

      const half = await app.inject({
        method: "PATCH",
        url: `/v1/sessions/${id}/config`,
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ modelProvider: "deepseek" }),
      });
      expect(half.statusCode).toBe(400);

      const badLevel = await app.inject({
        method: "PATCH",
        url: `/v1/sessions/${id}/config`,
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ thinkingLevel: "super-high" }),
      });
      expect(badLevel.statusCode).toBe(400);
    });

    it("PATCH config 不可用模型返回 400，且不调用 setModel、不持久化", async () => {
      const { app, sessions, adapters } = await makeApp();
      const { id } = await createSession(app, IP_A, "切到坏模型");

      const res = await app.inject({
        method: "PATCH",
        url: `/v1/sessions/${id}/config`,
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ modelProvider: "deepseek", modelId: "no-such-model" }),
      });
      expect(res.statusCode).toBe(400);
      expect(adapters.get(id)?.calls).toEqual([]); // 未调用 setModel
      expect((await sessions.get(id))?.modelProvider).toBeNull(); // 未持久化
    });

    it("PATCH config 模型可用性检查失败（catalog 抛错）返回 503，且不持久化", async () => {
      const { app, sessions, adapters } = await makeApp({
        modelCatalog: {
          getAvailable: async () => [],
          isAvailable: async () => { throw new Error("凭证读取失败"); },
        },
      });
      const { id } = await createSession(app, IP_A, "切模型时故障");

      const res = await app.inject({
        method: "PATCH",
        url: `/v1/sessions/${id}/config`,
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ modelProvider: "deepseek", modelId: "v4-pro" }),
      });
      expect(res.statusCode).toBe(503);
      expect(adapters.get(id)?.calls).toEqual([]); // 未调用 setModel
      expect((await sessions.get(id))?.modelProvider).toBeNull();
    });
  });

  describe("权限矩阵：子资源越权与不存在统一 404", () => {
    const operations: ReadonlyArray<{
      name: string;
      method: "GET" | "POST" | "PATCH";
      path: (id: string) => string;
      payload?: string;
    }> = [
      {
        name: "config",
        method: "PATCH",
        path: (id) => `/v1/sessions/${id}/config`,
        payload: JSON.stringify({ thinkingLevel: "low" }),
      },
      {
        name: "follow-ups",
        method: "POST",
        path: (id) => `/v1/sessions/${id}/follow-ups`,
        payload: JSON.stringify({ text: "继续" }),
      },
      { name: "abort", method: "POST", path: (id) => `/v1/sessions/${id}/abort` },
      { name: "events", method: "GET", path: (id) => `/v1/sessions/${id}/events` },
    ];

    for (const op of operations) {
      const common = op.payload !== undefined
        ? { headers: JSON_HEADERS, remoteAddress: IP_A }
        : { remoteAddress: IP_A };

      it(`${op.name} 访问他人会话返回 404 且无副作用`, async () => {
        const { app, sessions } = await makeApp();
        const other = await createSession(app, IP_B, "他人");
        const before = await sessions.get(other.id);

        const res = await app.inject({
          method: op.method,
          url: op.path(other.id),
          ...common,
          payload: op.payload,
        });
        expect(res.statusCode).toBe(404);
        // 越权操作不得产生任何副作用：记录前后完全相等
        expect(await sessions.get(other.id)).toEqual(before);
      });

      it(`${op.name} 访问不存在会话返回 404`, async () => {
        const { app } = await makeApp();
        const res = await app.inject({
          method: op.method,
          url: op.path("no-such-session"),
          ...common,
          payload: op.payload,
        });
        expect(res.statusCode).toBe(404);
      });
    }

    it("删除他人项目返回 404 且项目保留", async () => {
      const { app } = await makeApp();
      const created = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: JSON_HEADERS, remoteAddress: IP_B,
        payload: JSON.stringify({ name: "他人项目", cwd: "/path/other" }),
      });
      expect(created.statusCode).toBe(201);
      const projectId = (created.json() as { id: string }).id;

      const del = await app.inject({
        method: "DELETE",
        url: `/v1/projects/${projectId}`,
        remoteAddress: IP_A,
      });
      expect(del.statusCode).toBe(404);

      const list = await app.inject({
        method: "GET",
        url: "/v1/projects",
        headers: JSON_HEADERS, remoteAddress: IP_B,
      });
      expect(list.json()).toContainEqual(expect.objectContaining({ id: projectId }));
    });

    it("用他人 projectId 创建会话返回 404", async () => {
      const { app } = await makeApp();
      const created = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: JSON_HEADERS, remoteAddress: IP_B,
        payload: JSON.stringify({ name: "他人项目", cwd: "/path/other" }),
      });
      const projectId = (created.json() as { id: string }).id;

      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: JSON_HEADERS, remoteAddress: IP_A,
        payload: JSON.stringify({ projectId }),
      });
      expect(res.statusCode).toBe(404);
    });
  });
});