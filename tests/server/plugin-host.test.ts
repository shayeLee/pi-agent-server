import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
  createResult?: (input: Record<string, unknown>) => unknown;
  runTurn?: (ownerKey: string, input: Record<string, unknown>) => unknown;
} = {}): {
  sessions: SessionService;
  createCalls: Array<{ ownerKey: string; input: Record<string, unknown> }>;
  listCalls: string[];
  entryCalls: Array<{ ownerKey: string; sessionId: string }>;
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
    expect(routes.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: "/v1/capabilities/acme/status" },
      { method: "POST", url: "/v1/capabilities/acme/mutate" },
    ]);
    expect(routes.map((route) => route.config.permission)).toEqual([
      "capability:read",
      "capability:write",
    ]);

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
