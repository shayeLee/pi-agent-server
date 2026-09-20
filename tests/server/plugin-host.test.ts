import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { SessionService } from "../../src/application/session-service.js";
import { identityKey } from "../../src/core/user-identity.js";
import {
  type LoadedPlugin,
  type PluginHostContext,
  type PluginHttpMethod,
  type PluginModeProfile,
  type PluginModule,
  type PluginRouteRequestContext,
  type PluginSessionRef,
  type PluginSessionReservation,
} from "../../src/plugin/index.js";
import type { PluginRoute } from "../../src/plugin/index.js";
import { registerPlugins } from "../../src/server/plugin-host.js";

type CapturedRoute = {
  method: PluginHttpMethod;
  url: string;
  config: { permission?: string };
  /** Fastify route-level HEAD 派生开关；宿主只对插件 GET 路由显式置 false。 */
  exposeHeadRoute?: boolean;
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
};

function fakeApp(): { app: FastifyInstance; routes: CapturedRoute[] } {
  const routes: CapturedRoute[] = [];
  const app = {
    route(options: unknown): void {
      routes.push(options as CapturedRoute);
    },
  };
  return { app: app as unknown as FastifyInstance, routes };
}

function loadedPlugin(
  id: string,
  options: {
    modes?: readonly PluginModeProfile[];
    register?: PluginModule["register"];
    dispose?: PluginModule["dispose"];
  } = {},
): LoadedPlugin {
  const manifest = { id, version: 1 };
  const plugin: PluginModule = {
    manifest,
    ...(options.register ? { register: options.register } : {}),
    ...(options.dispose ? { dispose: options.dispose } : {}),
  };
  return {
    manifest,
    tools: [],
    promptFragments: [],
    modes: options.modes ?? [],
    plugin,
  };
}

function mode(overrides: Partial<PluginModeProfile> = {}): PluginModeProfile {
  return {
    id: "copilot",
    modelProvider: "anthropic",
    modelId: "claude-sonnet-4",
    appendSystemPrompt: "固定追加提示词",
    thinkingLevel: "high",
    ...overrides,
  };
}

function fakeSessions(options: {
  session?: PluginSessionRef;
  getEntry?: (ownerKey: string, sessionId: string) => Promise<unknown>;
  getSystemPrompt?: (ownerKey: string, sessionId: string) => Promise<string | null>;
  exportSession?: (ownerKey: string, sessionId: string) => Promise<{ messages: unknown } | null>;
  renameSession?: (ownerKey: string, sessionId: string, title: string, options?: { onlyIfEmpty?: boolean }) => Promise<PluginSessionRef | null>;
  createResult?: (input: Record<string, unknown>) => unknown;
  runTurn?: (ownerKey: string, input: Record<string, unknown>) => unknown;
} = {}): {
  sessions: SessionService;
  createCalls: Array<{ ownerKey: string; input: Record<string, unknown> }>;
  listCalls: string[];
  entryCalls: Array<{ ownerKey: string; sessionId: string }>;
  systemPromptCalls: Array<{ ownerKey: string; sessionId: string }>;
  exportCalls: Array<{ ownerKey: string; sessionId: string }>;
  renameCalls: Array<{ ownerKey: string; sessionId: string; title: string; options?: { onlyIfEmpty?: boolean } }>;
  runTurnCalls: Array<{ ownerKey: string; input: Record<string, unknown> }>;
} {
  const session = options.session ?? {
    id: "session-1",
    projectId: "project-1",
    title: "plugin session",
    createdAt: 100,
    updatedAt: 200,
  };
  const createCalls: Array<{ ownerKey: string; input: Record<string, unknown> }> = [];
  const listCalls: string[] = [];
  const entryCalls: Array<{ ownerKey: string; sessionId: string }> = [];
  const systemPromptCalls: Array<{ ownerKey: string; sessionId: string }> = [];
  const exportCalls: Array<{ ownerKey: string; sessionId: string }> = [];
  const renameCalls: Array<{ ownerKey: string; sessionId: string; title: string; options?: { onlyIfEmpty?: boolean } }> = [];
  const runTurnCalls: Array<{ ownerKey: string; input: Record<string, unknown> }> = [];
  const created: PluginSessionRef[] = [];
  const service = {
    createSession: async (ownerKey: string, input: Record<string, unknown>) => {
      createCalls.push({ ownerKey, input });
      if (options.createResult) return options.createResult(input);
      // 宿主必须严格按预约 id 创建。
      const record = { ...session, id: (input.sessionId as string) ?? session.id };
      created.push(record);
      return { kind: "created" as const, session: record };
    },
    listSessions: async (ownerKey: string) => {
      listCalls.push(ownerKey);
      return created.length > 0 ? [...created] : [session];
    },
    getEntry: async (ownerKey: string, sessionId: string) => {
      entryCalls.push({ ownerKey, sessionId });
      return options.getEntry ? options.getEntry(ownerKey, sessionId) : {};
    },
    getSystemPrompt: async (ownerKey: string, sessionId: string) => {
      systemPromptCalls.push({ ownerKey, sessionId });
      return options.getSystemPrompt ? options.getSystemPrompt(ownerKey, sessionId) : null;
    },
    exportSession: async (ownerKey: string, sessionId: string) => {
      exportCalls.push({ ownerKey, sessionId });
      return options.exportSession ? options.exportSession(ownerKey, sessionId) : null;
    },
    renameSession: async (ownerKey: string, sessionId: string, title: string, renameOptions?: { onlyIfEmpty?: boolean }) => {
      renameCalls.push({ ownerKey, sessionId, title, ...(renameOptions ? { options: renameOptions } : {}) });
      return options.renameSession ? options.renameSession(ownerKey, sessionId, title, renameOptions) : null;
    },
    runTurn: async (ownerKey: string, input: Record<string, unknown>) => {
      runTurnCalls.push({ ownerKey, input });
      if (options.runTurn) return options.runTurn(ownerKey, input);
      return { status: "completed", text: "助手文本" };
    },
  };
  return {
    sessions: service as unknown as SessionService,
    createCalls,
    listCalls,
    entryCalls,
    systemPromptCalls,
    exportCalls,
    renameCalls,
    runTurnCalls,
  };
}

describe("plugin host", () => {
  it("向 register 提供 projectCwd、modes 和受宿主控制的 session API", async () => {
    const { app, routes } = fakeApp();
    const profile = mode();
    const fake = fakeSessions();
    let context: PluginHostContext | undefined;
    const routeContexts: PluginRouteRequestContext[] = [];
    const plugin = loadedPlugin("acme", {
      modes: [profile],
      register: async (received) => {
        context = received;
        received.mountRoute({
          method: "GET",
          path: "/status",
          access: "read",
          handler: async (routeContext) => {
            routeContexts.push(routeContext);
            return { ok: true };
          },
        });
        received.mountRoute({
          method: "POST",
          path: "/mutate",
          access: "write",
          handler: async () => ({ ok: true }),
        });
      },
    });

    await registerPlugins([plugin], {
      app,
      projectCwd: "/workspace/project",
      sessions: fake.sessions,
    });

    expect(context?.projectCwd).toBe("/workspace/project");
    expect(context?.modes).toBe(plugin.modes);
    // 跨仓契约：宿主把权威的 runTurn 预算 code 表注入插件上下文，
    // 插件据此映射文案而不在本地重复定义这些字符串。
    expect(context?.turnErrorCodes).toEqual({
      toolBudget: "turn_tool_budget_exceeded",
      durationBudget: "turn_duration_budget_exceeded",
      assistantTextBudget: "turn_assistant_text_budget_exceeded",
    });
    expect(routes.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: "/v1/capabilities/acme/status" },
      { method: "POST", url: "/v1/capabilities/acme/mutate" },
    ]);
    expect(routes.map((route) => route.config.permission)).toEqual([
      "capability:read",
      "capability:write",
    ]);
    // 宿主只对 GET 显式禁用 Fastify 自动 HEAD；POST 不携带该选项（不带无关字段）。
    expect(routes.map((route) => route.exposeHeadRoute)).toEqual([false, undefined]);

    const request = { user: { kind: "ip", ip: "192.0.2.10" } } as const;
    const reply = {} as FastifyReply;
    await routes[0]!.handler(request as unknown as FastifyRequest, reply);
    expect(routeContexts[0]?.ownerKey).toBe(identityKey(request.user));
    expect(routeContexts[0]?.sessions).toBeDefined();
    expect(routeContexts[0]?.request).toBe(request);
    expect(routeContexts[0]?.reply).toBe(reply);
  });

  it("插件 session API 绑定路由认证 owner，并入 mode profile 的 model/prompt", async () => {
    const { app, routes } = fakeApp();
    const fake = fakeSessions();
    let routeContext: PluginRouteRequestContext | undefined;
    let normalResult: {
      reservation: PluginSessionReservation;
      created: PluginSessionRef;
      restored: PluginSessionRef | null;
    } | undefined;
    const plugin = loadedPlugin("copilot", {
      modes: [mode({ modelProvider: "openai", modelId: "gpt-5", appendSystemPrompt: "追加片段", thinkingLevel: "low" })],
      register: (received) => {
        received.mountRoute({
          method: "POST",
          path: "/sessions",
          access: "write",
          handler: async (context) => {
            routeContext = context;
            const reservation = await context.sessions.reserve({ modeId: "copilot" });
            const created = await context.sessions.create({ reservation, title: "标题" });
            const restored = await context.sessions.restore(created.id);
            normalResult = { reservation, created, restored };
            return { ok: true };
          },
        });
      },
    });
    await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });

    const request = { user: { kind: "ip", ip: "192.0.2.20" } } as const;
    await expect(routes[0]!.handler(request as unknown as FastifyRequest, {} as FastifyReply)).resolves.toEqual({ ok: true });
    const ownerKey = identityKey(request.user);
    const reservation = normalResult!.reservation;
    const created = normalResult!.created;

    expect(reservation.modeId).toBe("copilot");
    expect(reservation.id).toMatch(/^[0-9a-f-]{36}$/);
    // 宿主严格按预约 id 创建：返回 id 必须等于预约 id。
    expect(created.id).toBe(reservation.id);
    expect(created).toMatchObject({ projectId: "project-1", title: "plugin session" });
    expect(normalResult!.restored).toEqual(created);
    // appendSystemPrompt → 宿主 createSession 的 systemPromptAppend（绝不是 override）。
    expect(fake.createCalls).toEqual([{
      ownerKey,
      input: {
        sessionId: reservation.id,
        title: "标题",
        modelProvider: "openai",
        modelId: "gpt-5",
        thinkingLevel: "low",
        systemPromptAppend: "追加片段",
      },
    }]);
    expect(fake.createCalls[0]!.input.systemPromptOverride).toBeUndefined();
    expect(fake.listCalls).toEqual([ownerKey]);
    expect(fake.entryCalls).toEqual([{ ownerKey, sessionId: created.id }]);

    // 路由返回后，缓存的 API 以及其中的预约均已失效。
    await expect(routeContext!.sessions.reserve({ modeId: "copilot" })).rejects.toThrow("会话 API 已失效");
    await expect(routeContext!.sessions.create({ reservation })).rejects.toThrow("会话 API 已失效");
    await expect(routeContext!.sessions.restore(created.id)).rejects.toThrow("会话 API 已失效");
  });

  it("getSystemPrompt 仅返回当前 owner 的创建快照，插件不能伪造 owner", async () => {
    const { app, routes } = fakeApp();
    const request = { user: { kind: "ip", ip: "192.0.2.24" } } as const;
    const ownerKey = identityKey(request.user);
    const fake = fakeSessions({
      getSystemPrompt: async (actualOwner, sessionId) => (
        actualOwner === ownerKey && sessionId === "session-1" ? "创建时冻结的提示词" : null
      ),
    });
    let routeContext: PluginRouteRequestContext | undefined;
    const plugin = loadedPlugin("copilot", {
      modes: [mode()],
      register: (received) => {
        received.mountRoute({
          method: "GET",
          path: "/system-prompt",
          access: "read",
          handler: async (context) => {
            routeContext = context;
            return {
              own: await context.sessions.getSystemPrompt("session-1"),
              // 运行时额外 owner 参数会被忽略；API 只接受 sessionId，宿主绑定认证 owner。
              other: await (context.sessions.getSystemPrompt as unknown as (
                sessionId: string,
                ownerKey: string,
              ) => Promise<string | null>)("other-owner-session", "owner-b"),
            };
          },
        });
      },
    });
    await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });

    await expect(
      routes[0]!.handler(request as unknown as FastifyRequest, {} as FastifyReply),
    ).resolves.toEqual({ own: "创建时冻结的提示词", other: null });
    expect(fake.systemPromptCalls).toEqual([
      { ownerKey, sessionId: "session-1" },
      { ownerKey, sessionId: "other-owner-session" },
    ]);
    await expect(routeContext!.sessions.getSystemPrompt("session-1")).rejects.toThrow("会话 API 已失效");
  });

  it("setTitle 仅更新当前 owner 的会话，返回更新后的元数据并受标题预算约束", async () => {
    const { app, routes } = fakeApp();
    const request = { user: { kind: "ip", ip: "192.0.2.25" } } as const;
    const ownerKey = identityKey(request.user);
    const fake = fakeSessions({
      renameSession: async (actualOwner, sessionId, title) => (
        actualOwner === ownerKey && sessionId === "session-1"
          ? { id: sessionId, projectId: "project-1", title, createdAt: 100, updatedAt: 300 }
          : null
      ),
    });
    let routeContext: PluginRouteRequestContext | undefined;
    const plugin = loadedPlugin("copilot", {
      modes: [mode()],
      register: (received) => {
        received.mountRoute({
          method: "POST",
          path: "/title",
          access: "write",
          handler: async (context) => {
            routeContext = context;
            let tooLongError = "";
            try {
              await context.sessions.setTitle({ sessionId: "session-1", title: "x".repeat(81) });
            } catch (error) {
              tooLongError = (error as Error).message;
            }
            return {
              own: await context.sessions.setTitle({ sessionId: "session-1", title: "首问标题" }),
              other: await context.sessions.setTitle({ sessionId: "other-owner-session", title: "不可见" }),
              tooLongError,
            };
          },
        });
      },
    });
    await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });

    await expect(routes[0]!.handler(request as unknown as FastifyRequest, {} as FastifyReply)).resolves.toEqual({
      own: { id: "session-1", projectId: "project-1", title: "首问标题", createdAt: 100, updatedAt: 300 },
      other: null,
      tooLongError: "插件会话标题超过宿主上限",
    });
    expect(fake.renameCalls).toEqual([
      { ownerKey, sessionId: "session-1", title: "首问标题" },
      { ownerKey, sessionId: "other-owner-session", title: "不可见" },
    ]);
    await expect(routeContext!.sessions.setTitle({ sessionId: "session-1", title: "有效" }))
      .rejects.toThrow("会话 API 已失效");
  });

  it("getMessages 只读投影 messages，并让 onlyIfEmpty 原子标题结果同步给插件", async () => {
    const { app, routes } = fakeApp();
    const request = { user: { kind: "ip", ip: "192.0.2.26" } } as const;
    const ownerKey = identityKey(request.user);
    const titles = new Map([["empty", ""], ["custom", "用户标题"]]);
    const fake = fakeSessions({
      exportSession: async (actualOwner, sessionId) => actualOwner === ownerKey && sessionId === "own"
        ? { messages: [{ role: "user", text: "首问" }], timeline: [{ thinking: "不应泄露" }] }
        : null,
      renameSession: async (actualOwner, sessionId, title, options) => {
        if (actualOwner !== ownerKey || !titles.has(sessionId)) return null;
        const current = titles.get(sessionId)!;
        if (!options?.onlyIfEmpty || current === "") titles.set(sessionId, title);
        return { id: sessionId, projectId: "project-1", title: titles.get(sessionId)!, createdAt: 100, updatedAt: 300 };
      },
    });
    let context: PluginRouteRequestContext | undefined;
    const plugin = loadedPlugin("copilot", {
      modes: [mode()],
      register: (received) => received.mountRoute({
        method: "POST", path: "/automatic-title", access: "write",
        handler: async (receivedContext) => {
          context = receivedContext;
          return {
            ownMessages: await receivedContext.sessions.getMessages("own"),
            otherMessages: await receivedContext.sessions.getMessages("other"),
            empty: await receivedContext.sessions.setTitle({ sessionId: "empty", title: "自动标题", onlyIfEmpty: true }),
            custom: await receivedContext.sessions.setTitle({ sessionId: "custom", title: "不应覆盖", onlyIfEmpty: true }),
          };
        },
      }),
    });
    await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });

    await expect(routes[0]!.handler(request as unknown as FastifyRequest, {} as FastifyReply)).resolves.toEqual({
      ownMessages: [{ role: "user", text: "首问" }],
      otherMessages: null,
      empty: { id: "empty", projectId: "project-1", title: "自动标题", createdAt: 100, updatedAt: 300 },
      custom: { id: "custom", projectId: "project-1", title: "用户标题", createdAt: 100, updatedAt: 300 },
    });
    expect(fake.exportCalls).toEqual([{ ownerKey, sessionId: "own" }, { ownerKey, sessionId: "other" }]);
    expect(fake.entryCalls).toEqual([]); // 只读导出不触发 runtime/provider。
    expect(fake.renameCalls).toEqual([
      { ownerKey, sessionId: "empty", title: "自动标题", options: { onlyIfEmpty: true } },
      { ownerKey, sessionId: "custom", title: "不应覆盖", options: { onlyIfEmpty: true } },
    ]);
    await expect(context!.sessions.getMessages("own")).rejects.toThrow("会话 API 已失效");
  });

  it("插件 GET 路由禁用自动 HEAD：HEAD 404 且 handler/session API 零调用，同路径 POST 不受影响", async () => {
    // 真实 Fastify：只有真实路由注册才可能派生 HEAD，mock app 无法证明 404 语义。
    const app = Fastify();
    app.addHook("onRequest", async (request) => {
      request.user = { kind: "ip", ip: "192.0.2.90" };
    });
    const fake = fakeSessions();
    let getHandlerCalls = 0;
    let postHandlerCalls = 0;
    const plugin = loadedPlugin("acme", {
      modes: [mode()],
      register: (received) => {
        received.mountRoute({
          method: "GET",
          path: "/status",
          access: "read",
          handler: async (context) => {
            getHandlerCalls++;
            return { restored: (await context.sessions.restore("session-1")) !== null };
          },
        });
        received.mountRoute({
          method: "POST",
          path: "/status",
          access: "write",
          handler: async (context) => {
            postHandlerCalls++;
            await context.sessions.reserve({ modeId: "copilot" });
            return { ok: true };
          },
        });
      },
    });
    await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });
    try {
      // 插件未声明 HEAD：契约显式声明的方法之外不存在路由（route-level 禁用自动 HEAD）。
      expect(app.hasRoute({ method: "GET", url: "/v1/capabilities/acme/status" })).toBe(true);
      expect(app.hasRoute({ method: "POST", url: "/v1/capabilities/acme/status" })).toBe(true);
      expect(app.hasRoute({ method: "HEAD", url: "/v1/capabilities/acme/status" })).toBe(false);

      const head = await app.inject({ method: "HEAD", url: "/v1/capabilities/acme/status" });
      expect(head.statusCode).toBe(404);
      // HEAD（及 404 回退）绝不执行 handler，也绝不触达宿主 session API。
      expect(getHandlerCalls).toBe(0);
      expect(fake.listCalls).toEqual([]);
      expect(fake.entryCalls).toEqual([]);
      expect(fake.createCalls).toEqual([]);
      expect(fake.runTurnCalls).toEqual([]);

      // 显式声明的 GET/POST 语义不变。
      const get = await app.inject({ method: "GET", url: "/v1/capabilities/acme/status" });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({ restored: true });
      expect(getHandlerCalls).toBe(1);
      const post = await app.inject({ method: "POST", url: "/v1/capabilities/acme/status" });
      expect(post.statusCode).toBe(200);
      expect(post.json()).toEqual({ ok: true });
      expect(postHandlerCalls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("插件只能暴露契约显式声明的方法：每条 GET 无隐式 HEAD，非 GET 方法不受该选项影响", async () => {
    // 真实 Fastify + 全量插件方法声明：逐个证明「声明即全量」——存在的路由集合与声明集合
    // 完全一致（仅 GET 多出被显式禁用的 HEAD），HEAD 对任意路径 404。
    const app = Fastify();
    app.addHook("onRequest", async (request) => {
      request.user = { kind: "ip", ip: "192.0.2.91" };
    });
    const fake = fakeSessions();
    const calls: string[] = [];
    const declared = [
      ["GET", "/read-only"],
      ["POST", "/mutate"],
      ["PUT", "/replace"],
      ["PATCH", "/patch"],
      ["DELETE", "/remove"],
    ] as const;
    const plugin = loadedPlugin("matrix", {
      modes: [mode()],
      register: (received) => {
        for (const [method, path] of declared) {
          received.mountRoute({
            method,
            path,
            access: method === "GET" ? "read" : "write",
            handler: async (context) => {
              calls.push(`${method} ${path}`);
              await context.sessions.reserve({ modeId: "copilot" });
              return { ok: true };
            },
          });
        }
      },
    });
    await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });
    try {
      // HEAD 派生只适用于 GET：非 GET 方法即便带该选项也无效，故宿主不给它们加。
      for (const [method, path] of declared) {
        const url = `/v1/capabilities/matrix${path}`;
        expect(app.hasRoute({ method, url })).toBe(true);
        expect(app.hasRoute({ method: "HEAD", url })).toBe(false);
        const head = await app.inject({ method: "HEAD", url });
        expect([method, head.statusCode]).toEqual([method, 404]);
      }
      // 所有 HEAD 探测（含 404 回退）都不得执行任何插件 handler 或触达 session API。
      expect(calls).toEqual([]);
      expect(fake.listCalls).toEqual([]);
      expect(fake.entryCalls).toEqual([]);
      expect(fake.createCalls).toEqual([]);
      expect(fake.runTurnCalls).toEqual([]);
      // 声明的方法本身全部可用。
      for (const [method, path] of declared) {
        const response = await app.inject({ method, url: `/v1/capabilities/matrix${path}` });
        expect([method, response.statusCode]).toEqual([method, 200]);
      }
      expect(calls).toEqual(declared.map(([method, path]) => `${method} ${path}`));
    } finally {
      await app.close();
    }
  });

  it("mode 用旧版 systemPrompt 时仍以 systemPromptOverride 创建（兼容路径语义不变）", async () => {
    const { app, routes } = fakeApp();
    const fake = fakeSessions();
    const plugin = loadedPlugin("copilot", {
      modes: [mode({ appendSystemPrompt: undefined, systemPrompt: "整体覆盖提示词" })],
      register: (received) => {
        received.mountRoute({
          method: "POST",
          path: "/sessions",
          access: "write",
          handler: async (context) => {
            const reservation = await context.sessions.reserve({ modeId: "copilot" });
            await context.sessions.create({ reservation });
            return { ok: true };
          },
        });
      },
    });
    await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });

    await expect(
      routes[0]!.handler({ user: { kind: "ip", ip: "192.0.2.22" } } as unknown as FastifyRequest, {} as FastifyReply),
    ).resolves.toEqual({ ok: true });

    expect(fake.createCalls[0]!.input.systemPromptOverride).toBe("整体覆盖提示词");
    expect(fake.createCalls[0]!.input.systemPromptAppend).toBeUndefined();
  });

  it("mode prompt 二选一违反时 create 拒绝，不触达宿主 createSession", async () => {
    for (const profile of [
      // 两者都缺失
      mode({ appendSystemPrompt: undefined }),
      // 两者同时提供
      mode({ appendSystemPrompt: "追加", systemPrompt: "覆盖" }),
    ]) {
      const { app, routes } = fakeApp();
      const fake = fakeSessions();
      let createError: unknown;
      const plugin = loadedPlugin("copilot", {
        modes: [profile],
        register: (received) => {
          received.mountRoute({
            method: "POST",
            path: "/sessions",
            access: "write",
            handler: async (context) => {
              const reservation = await context.sessions.reserve({ modeId: "copilot" });
              try {
                await context.sessions.create({ reservation });
              } catch (error) {
                createError = error;
              }
              return { ok: true };
            },
          });
        },
      });
      await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });
      await routes[0]!.handler({ user: { kind: "ip", ip: "192.0.2.23" } } as unknown as FastifyRequest, {} as FastifyReply);

      expect((createError as Error).message).toMatch(/须二选一/);
      expect(fake.createCalls).toHaveLength(0);
    }
  });

  it("handler 抛错后也会撤销缓存的 session API", async () => {
    const { app, routes } = fakeApp();
    const fake = fakeSessions();
    let routeContext: PluginRouteRequestContext | undefined;
    let reservation: PluginSessionReservation | undefined;
    const plugin = loadedPlugin("copilot", {
      modes: [mode()],
      register: (received) => {
        received.mountRoute({
          method: "POST",
          path: "/sessions",
          access: "write",
          handler: async (context) => {
            routeContext = context;
            reservation = await context.sessions.reserve({ modeId: "copilot" });
            throw new Error("handler failed");
          },
        });
      },
    });
    await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });

    const reply = {
      code: () => ({ send: (body: unknown) => body }),
    } as unknown as FastifyReply;
    await expect(
      routes[0]!.handler({ user: { kind: "ip", ip: "192.0.2.21" } } as unknown as FastifyRequest, reply),
    ).resolves.toMatchObject({ statusCode: 500 });

    await expect(routeContext!.sessions.reserve({ modeId: "copilot" })).rejects.toThrow("会话 API 已失效");
    await expect(routeContext!.sessions.create({ reservation: reservation! })).rejects.toThrow("会话 API 已失效");
    await expect(routeContext!.sessions.restore("session-1")).rejects.toThrow("会话 API 已失效");
    expect(fake.createCalls).toHaveLength(0);
  });

  it("会话预约不可指定 id、不可伪造、不可跨请求或重复使用", async () => {
    const { app, routes } = fakeApp();
    const fake = fakeSessions();
    let reservationA: PluginSessionReservation | undefined;
    const plugin = loadedPlugin("copilot", {
      modes: [mode()],
      register: (received) => {
        received.mountRoute({
          method: "POST",
          path: "/sessions",
          access: "write",
          handler: async (context) => {
            if (!reservationA) {
              reservationA = await context.sessions.reserve({ modeId: "copilot" });
              return { ok: true };
            }

            // 伪造预约（自造 id）一律拒绝，不会触达宿主 createSession。
            await expect(
              context.sessions.create({ reservation: { id: "forged-id", modeId: "copilot" } }),
            ).rejects.toThrow(/预约/);
            // 预约绑定请求上下文：B 请求无法使用 A 的预约。
            await expect(context.sessions.create({ reservation: reservationA })).rejects.toThrow(/预约/);
            // mode 不匹配同样拒绝。
            const reservationB = await context.sessions.reserve({ modeId: "copilot" });
            await expect(context.sessions.create({ reservation: { ...reservationB, modeId: "other" } })).rejects.toThrow(/预约/);
            // 未知 mode 无法预约。
            await expect(context.sessions.reserve({ modeId: "ghost" })).rejects.toThrow(/未知插件 mode/);

            // 正常消费一次后，重复 create 同一预约失败。
            const created = await context.sessions.create({ reservation: reservationB });
            expect(created.id).toBe(reservationB.id);
            await expect(context.sessions.create({ reservation: reservationB })).rejects.toThrow(/预约/);
            return { ok: true };
          },
        });
      },
    });
    await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });

    await expect(routes[0]!.handler({ user: { kind: "ip", ip: "192.0.2.30" } } as unknown as FastifyRequest, {} as FastifyReply))
      .resolves.toEqual({ ok: true });
    await expect(routes[0]!.handler({ user: { kind: "ip", ip: "192.0.2.31" } } as unknown as FastifyRequest, {} as FastifyReply))
      .resolves.toEqual({ ok: true });
    expect(fake.createCalls).toHaveLength(1);
  });

  it("会话 API 不再暴露删除任意用户会话的能力", async () => {
    const { app, routes } = fakeApp();
    const fake = fakeSessions();
    let routeContext: PluginRouteRequestContext | undefined;
    const plugin = loadedPlugin("copilot", {
      modes: [mode()],
      register: (received) => {
        received.mountRoute({
          method: "POST",
          path: "/sessions",
          access: "write",
          handler: (context) => {
            routeContext = context;
            return { ok: true };
          },
        });
      },
    });
    await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });
    await routes[0]!.handler({ user: { kind: "ip", ip: "192.0.2.50" } } as unknown as FastifyRequest, {} as FastifyReply);

    expect((routeContext!.sessions as unknown as Record<string, unknown>).delete).toBeUndefined();
  });

  it.each([
    ["duplicate method/path", 1, (mountRoute: PluginHostContext["mountRoute"]) => {
      mountRoute({ method: "GET", path: "/same", access: "read", handler: async () => null });
      mountRoute({ method: "GET", path: "/same", access: "write", handler: async () => null });
    }],
    ["path without leading slash", 0, (mountRoute: PluginHostContext["mountRoute"]) => {
      mountRoute({ method: "GET", path: "status", access: "read", handler: async () => null });
    }],
    ["path traversal", 0, (mountRoute: PluginHostContext["mountRoute"]) => {
      mountRoute({ method: "GET", path: "/../status", access: "read", handler: async () => null });
    }],
    ["double slash", 0, (mountRoute: PluginHostContext["mountRoute"]) => {
      mountRoute({ method: "GET", path: "/status//detail", access: "read", handler: async () => null });
    }],
    // 运行时插件是 JS：小写/未知 method 必须 fail-fast。否则 "get" 会绕过 GET 的
    // exposeHeadRoute 收口，让 Fastify 派生出未在契约声明的 HEAD 路由。
    ["lowercase method", 0, (mountRoute: PluginHostContext["mountRoute"]) => {
      mountRoute({ method: "get" as unknown as "GET", path: "/status", access: "read", handler: async () => null });
    }],
    ["unknown method", 0, (mountRoute: PluginHostContext["mountRoute"]) => {
      mountRoute({ method: "OPTIONS" as unknown as "GET", path: "/status", access: "read", handler: async () => null });
    }],
  ] as const)("对 %s fail-fast", async (_name, expectedRouteCount, declareRoutes) => {
    const { app, routes } = fakeApp();
    const plugin = loadedPlugin("bad", {
      register: ({ mountRoute }) => declareRoutes(mountRoute),
    });

    await expect(registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fakeSessions().sessions }))
      .rejects.toThrow();
    expect(routes).toHaveLength(expectedRouteCount);
  });

  it("dispose 按注册逆序调用", async () => {
    const { app } = fakeApp();
    const order: string[] = [];
    const plugins = ["first", "second", "third"].map((id) => loadedPlugin(id, {
      dispose: async () => {
        order.push(id);
      },
    }));
    const host = await registerPlugins(plugins, {
      app,
      projectCwd: "/tmp/project",
      sessions: fakeSessions().sessions,
    });

    await host.dispose();
    expect(order).toEqual(["third", "second", "first"]);
  });

  it("runTurn 绑定宿主 owner/session，且只传 sessionId/requestId/prompt", async () => {
    const { app, routes } = fakeApp();
    const fake = fakeSessions({
      runTurn: async () => ({ status: "completed", text: "生成结果" }),
    });
    let routeContext: PluginRouteRequestContext | undefined;
    let returned: unknown;
    const plugin = loadedPlugin("prototype", {
      modes: [mode({ id: "interactive-prototype" })],
      register: (received) => {
        received.mountRoute({
          method: "POST",
          path: "/generate",
          access: "write",
          handler: async (context) => {
            routeContext = context;
            returned = await context.sessions.runTurn({
              sessionId: "session-9",
              requestId: "req-1",
              prompt: "固定服务器指令",
              // 运行时多余字段不得被宿主读取（模型/tools/cwd/图片不可指定）。
              modelId: "attacker-model",
              tools: ["bash"],
              cwd: "/etc",
              images: [{ mediaType: "image/png", base64: "AAAA" }],
            } as never);
            return { ok: true };
          },
        });
      },
    });
    await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });

    const request = { user: { kind: "ip", ip: "192.0.2.60" } } as const;
    await expect(
      routes[0]!.handler(request as unknown as FastifyRequest, {} as FastifyReply),
    ).resolves.toEqual({ ok: true });

    expect(fake.runTurnCalls).toHaveLength(1);
    const [turnCall] = fake.runTurnCalls;
    expect(turnCall!.ownerKey).toBe(identityKey(request.user));
    // 插件提供的多余字段（modelId/tools/cwd/images）绝不透传给宿主；宿主只额外注入
    // per-turn AbortSignal（绑定本请求 HTTP disconnect / revoke）。
    expect(turnCall!.input).toMatchObject({
      sessionId: "session-9",
      requestId: "req-1",
      prompt: "固定服务器指令",
    });
    expect(turnCall!.input.modelId).toBeUndefined();
    expect(turnCall!.input.tools).toBeUndefined();
    expect(turnCall!.input.cwd).toBeUndefined();
    expect(turnCall!.input.images).toBeUndefined();
    expect(turnCall!.input.signal).toBeInstanceOf(AbortSignal);
    expect(returned).toEqual({ status: "completed", text: "生成结果" });

    // handler 返回后 API revoke：runTurn 不可再调用。
    await expect(
      routeContext!.sessions.runTurn({ sessionId: "session-9", requestId: "req-2", prompt: "x" }),
    ).rejects.toThrow("会话 API 已失效");
  });

  it("runTurn 原样透传 busy/aborted/error 结果，并拒绝越权会话", async () => {
    const { app, routes } = fakeApp();
    const results = [
      { status: "busy" as const },
      { status: "aborted" as const },
      { status: "error" as const, message: "模型失败" },
      // 预算超限的 error 带稳定 code：宿主层必须原样透传（不得剥离 additive 字段）。
      { status: "error" as const, message: "本轮工具调用次数超过上限", code: "turn_tool_budget_exceeded" },
    ];
    let callIndex = 0;
    const fake = fakeSessions({
      runTurn: async () => results[callIndex++] ?? { status: "busy" },
    });
    const plugin = loadedPlugin("prototype", {
      modes: [mode({ id: "interactive-prototype" })],
      register: (received) => {
        received.mountRoute({
          method: "POST",
          path: "/generate",
          access: "write",
          handler: async (context) => ({
            result: await context.sessions.runTurn({ sessionId: "session-1", requestId: "req", prompt: "p" }),
          }),
        });
      },
    });
    await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });

    const request = { user: { kind: "ip", ip: "192.0.2.61" } } as const;
    for (const expected of results) {
      await expect(
        routes[0]!.handler(request as unknown as FastifyRequest, {} as FastifyReply),
      ).resolves.toEqual({ result: expected });
    }

    // 越权/不存在的会话：宿主 runTurn 返回 null，路由层折叠为固定 500。
    const denied = fakeSessions({ runTurn: async () => null });
    const { app: app2, routes: routes2 } = fakeApp();
    const deniedPlugin = loadedPlugin("prototype", {
      modes: [mode({ id: "interactive-prototype" })],
      register: (received) => {
        received.mountRoute({
          method: "POST",
          path: "/generate",
          access: "write",
          handler: async (context) => ({
            result: await context.sessions.runTurn({ sessionId: "other", requestId: "req", prompt: "p" }),
          }),
        });
      },
    });
    await registerPlugins([deniedPlugin], { app: app2, projectCwd: "/tmp/project", sessions: denied.sessions });
    const reply = {
      code: () => ({ send: (body: unknown) => body }),
    } as unknown as FastifyReply;
    await expect(
      routes2[0]!.handler({ user: { kind: "ip", ip: "192.0.2.62" } } as unknown as FastifyRequest, reply),
    ).resolves.toMatchObject({ statusCode: 500 });
  });

  it("HTTP disconnect（close）会 abort 在途 runTurn 的 per-turn signal", async () => {
    const { app, routes } = fakeApp();
    let observedSignal: AbortSignal | undefined;
    const fake = fakeSessions({
      runTurn: async (_ownerKey, input) => {
        observedSignal = input.signal as AbortSignal;
        await new Promise<void>((resolve) => {
          if (observedSignal!.aborted) resolve();
          else observedSignal!.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: "aborted" };
      },
    });
    const plugin = loadedPlugin("prototype", {
      modes: [mode({ id: "interactive-prototype" })],
      register: (received) => {
        received.mountRoute({
          method: "POST",
          path: "/generate",
          access: "write",
          handler: async (context) => ({
            result: await context.sessions.runTurn({ sessionId: "s-1", requestId: "r-1", prompt: "p" }),
          }),
        });
      },
    });
    await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });

    const responseRaw = Object.assign(new EventEmitter(), { writableEnded: false });
    const request = { user: { kind: "ip", ip: "192.0.2.70" } } as unknown as FastifyRequest;
    const reply = { raw: responseRaw } as unknown as FastifyReply;
    const handlerPromise = routes[0]!.handler(request, reply);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal!.aborted).toBe(false);

    // 客户端在响应完成前断开：res close（writableEnded=false）触发 signal abort，只终止本 turn。
    responseRaw.emit("close");
    expect(observedSignal!.aborted).toBe(true);
    await expect(handlerPromise).resolves.toEqual({ result: { status: "aborted" } });
  });

  it("插件显式停止信号无需 HTTP 断连即可中止原轮次", async () => {
    const { app, routes } = fakeApp();
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const fake = fakeSessions({ runTurn: async (_ownerKey, input) => {
      observed = input.signal as AbortSignal;
      await new Promise<void>(resolve => observed!.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'aborted' };
    } });
    const plugin = loadedPlugin('prototype', {
      modes: [mode({ id: 'interactive-prototype' })],
      register: received => {
        received.mountRoute({ method: 'POST', path: '/generate', access: 'write', handler: async context => {
          expect(context.sessions.supportsTurnCancellation).toBe(true);
          return context.sessions.runTurn({ sessionId: 's', requestId: 'attempt', prompt: 'p', signal: controller.signal });
        } });
      }
    });
    await registerPlugins([plugin], { app, projectCwd: '/tmp/project', sessions: fake.sessions });
    const responseRaw = Object.assign(new EventEmitter(), { writableEnded: false });
    const pending = routes[0]!.handler({ user: { kind: 'ip', ip: '192.0.2.70' } } as unknown as FastifyRequest, { raw: responseRaw } as unknown as FastifyReply);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(observed!.aborted).toBe(false);
    controller.abort(); // connection intentionally remains open, as with a buffering proxy
    await expect(pending).resolves.toEqual({ status: 'aborted' });
    expect(observed!.aborted).toBe(true);
    expect(responseRaw.writableEnded).toBe(false);
  });

  it("正常响应完成（res close 且 writableEnded=true）不会误中止 runTurn", async () => {
    const { app, routes } = fakeApp();
    let observedSignal: AbortSignal | undefined;
    const fake = fakeSessions({
      runTurn: async (_ownerKey, input) => {
        observedSignal = input.signal as AbortSignal;
        return { status: "completed", text: "ok" };
      },
    });
    const plugin = loadedPlugin("prototype", {
      modes: [mode({ id: "interactive-prototype" })],
      register: (received) => {
        received.mountRoute({
          method: "POST",
          path: "/generate",
          access: "write",
          handler: async (context) => ({
            result: await context.sessions.runTurn({ sessionId: "s-1", requestId: "r-1", prompt: "p" }),
          }),
        });
      },
    });
    await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });

    const responseRaw = Object.assign(new EventEmitter(), { writableEnded: false });
    const handlerPromise = routes[0]!.handler(
      { user: { kind: "ip", ip: "192.0.2.72" } } as unknown as FastifyRequest,
      { raw: responseRaw } as unknown as FastifyReply,
    );
    await expect(handlerPromise).resolves.toEqual({ result: { status: "completed", text: "ok" } });
    // 响应正常写完：即便随后 close，也不得触发 abort（监听器已移除）。
    responseRaw.writableEnded = true;
    responseRaw.emit("close");
    expect(observedSignal!.aborted).toBe(false);
  });

  it("handler 提前返回（revoke）会中止未结束的在途 runTurn", async () => {
    const { app, routes } = fakeApp();
    let observedSignal: AbortSignal | undefined;
    const fake = fakeSessions({
      runTurn: async (_ownerKey, input) => {
        observedSignal = input.signal as AbortSignal;
        await new Promise<void>((resolve) => {
          if (observedSignal!.aborted) resolve();
          else observedSignal!.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: "aborted" };
      },
    });
    const plugin = loadedPlugin("prototype", {
      modes: [mode({ id: "interactive-prototype" })],
      register: (received) => {
        received.mountRoute({
          method: "POST",
          path: "/generate",
          access: "write",
          // 故意不 await：API 在该 handler 返回时被 revoke，必须中止这个脱离请求的 turn。
          handler: (context) => {
            void context.sessions.runTurn({ sessionId: "s-1", requestId: "r-1", prompt: "p" });
            return { ok: true };
          },
        });
      },
    });
    await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });

    await expect(
      routes[0]!.handler({ user: { kind: "ip", ip: "192.0.2.71" } } as unknown as FastifyRequest, {} as FastifyReply),
    ).resolves.toEqual({ ok: true });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("runTurn 在进入宿主前强制 requestId/prompt 上限与控制字符", async () => {
    const { app, routes } = fakeApp();
    const fake = fakeSessions();
    const observed: string[] = [];
    const plugin = loadedPlugin("prototype", {
      modes: [mode({ id: "interactive-prototype" })],
      register: (received) => {
        received.mountRoute({
          method: "POST",
          path: "/generate",
          access: "write",
          handler: async (context) => {
            for (const bad of [
              { sessionId: "", requestId: "r", prompt: "p" },
              { sessionId: "s", requestId: "r".repeat(129), prompt: "p" },
              { sessionId: "s", requestId: "r", prompt: "p".repeat(32_769) },
              { sessionId: "s", requestId: "r", prompt: "bad\u0000prompt" },
            ]) {
              try {
                await context.sessions.runTurn(bad);
                observed.push("unexpected");
              } catch {
                observed.push("rejected");
              }
            }
            return { ok: true };
          },
        });
      },
    });
    await registerPlugins([plugin], { app, projectCwd: "/tmp/project", sessions: fake.sessions });
    await routes[0]!.handler({ user: { kind: "ip", ip: "192.0.2.63" } } as unknown as FastifyRequest, {} as FastifyReply);

    expect(observed).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    expect(fake.runTurnCalls).toHaveLength(0);
  });
});
