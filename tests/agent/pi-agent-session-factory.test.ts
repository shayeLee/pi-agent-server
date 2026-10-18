import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime, ResourceLoader, ToolDefinition } from "@earendil-works/pi-coding-agent";

const sdk = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  sessionManager: { getSessionFile: vi.fn(() => "/sessions/session.jsonl"), appendCustomEntry: vi.fn() },
  openPiRuntimeSessionFile: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: sdk.createAgentSession,
  SessionManager: { create: vi.fn(() => sdk.sessionManager) },
  SettingsManager: { inMemory: vi.fn(() => ({ getDefaultTools: () => undefined })) },
}));

vi.mock("../../src/agent/pi-jsonl-conversation-storage.js", () => ({
  openPiRuntimeSessionFile: sdk.openPiRuntimeSessionFile,
}));

import { PiAgentSessionFactory } from "../../src/agent/pi-agent-session-factory.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import type { AgentSessionContext } from "../../src/application/ports/conversation-port.js";
import type { PiResourceLoaderRequest } from "../../src/agent/pi-agent-session-factory.js";

function sessionLoader(loader: ResourceLoader) {
  return { loader, failbackLifecycleSource: { on: () => () => {} } };
}

function tool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [] }),
  } as unknown as ToolDefinition;
}

describe("PiAgentSessionFactory", () => {
  it.each([{}, { loader: {} }])("缺少 bus 在 SDK 启动前 fail closed: %j", async invalid => {
    sdk.createAgentSession.mockClear();
    const factory = new PiAgentSessionFactory({ modelRuntime: {} as ModelRuntime,
      createResourceLoader: async () => invalid as never, agentToolConfig: {} });
    const prepared = await factory.prepareNew(context());
    await expect(prepared.open()).rejects.toThrow("session-local ResourceLoader EventBus");
    expect(sdk.createAgentSession).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.createAgentSession.mockResolvedValue({
      session: { sessionFile: "/sessions/session.jsonl", subscribe: () => () => {} },
    });
  });

  function context(overrides: Partial<AgentSessionContext> = {}): AgentSessionContext {
    return {
      sessionId: "session-1",
      projectId: DEFAULT_PROJECT_ID,
      projectCwd: process.cwd(),
      dataDir: "/data",
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      isNewSession: true,
      agentToolConfig: { tools: ["read", "plugin_tool"], noTools: "builtin" },
      ...overrides,
    };
  }

  it.each(["+bash", "-read", "++bash", "+-read", "-+read"])("rejects unresolved factory name %s before SDK creation", name => {
    expect(() => new PiAgentSessionFactory({
      modelRuntime: {} as ModelRuntime,
      createResourceLoader: async () => sessionLoader({} as ResourceLoader),
      agentToolConfig: { tools: [name] },
    })).toThrow("resolved tools");
    expect(sdk.createAgentSession).not.toHaveBeenCalled();
  });

  it("resolved empty and unknown exact lists are forwarded without defaults or reparsing", async () => {
    for (const tools of [[], ["unknown_legal_name"]]) {
      const factory = new PiAgentSessionFactory({ modelRuntime: {} as ModelRuntime,
        createResourceLoader: async () => sessionLoader({} as ResourceLoader), agentToolConfig: { tools } });
      await (await factory.prepareNew(context())).open();
      expect(sdk.createAgentSession.mock.calls.at(-1)![0].tools).toEqual(tools);
    }
  });

  it("透传自定义工具，同时保留现有工具白名单配置", async () => {
    const customTool = tool("plugin_tool");
    sdk.createAgentSession.mockResolvedValue({
      session: { sessionFile: "/sessions/session.jsonl", subscribe: () => () => {} },
    });
    const factory = new PiAgentSessionFactory({
      modelRuntime: {} as ModelRuntime,
      createResourceLoader: async () => sessionLoader({} as ResourceLoader),
      customTools: [customTool],
      agentToolConfig: {
        tools: ["read", "plugin_tool"],
        noTools: "builtin",
      },
    });

    const prepared = await factory.prepareNew(context());
    await prepared.open();

    expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      tools: ["read", "plugin_tool"],
      noTools: "builtin",
      customTools: [customTool],
    }));
  });

  it("all 接线传宿主默认快照 modifiers，仍传入自定义工具", async () => {
    const customTool = tool("plugin_tool");
    const factory = new PiAgentSessionFactory({
      modelRuntime: {} as ModelRuntime,
      createResourceLoader: async () => sessionLoader({} as ResourceLoader),
      customTools: [customTool],
      agentToolConfig: {},
    });
    const prepared = await factory.prepareNew(context({ agentToolConfig: {} }));
    await prepared.open();
    const options = sdk.createAgentSession.mock.calls[0]![0];
    expect(options.tools).toEqual(["+read", "+bash", "+edit", "+write"]);
    expect(options.noTools).toBe("builtin");
    expect(options.customTools).toEqual([customTool]);
  });

  it("每次创建会话都取新的会话专属 loader，且冻结提示词按字面量 override 传入", async () => {
    const loaders: ResourceLoader[] = [];
    const createResourceLoader = vi.fn(async (_request: PiResourceLoaderRequest) => {
      const loader = { name: `loader-${loaders.length}` } as unknown as ResourceLoader;
      loaders.push(loader);
      return sessionLoader(loader);
    });
    const factory = new PiAgentSessionFactory({
      modelRuntime: {} as ModelRuntime,
      createResourceLoader,
      agentToolConfig: { noTools: "all" },
    });

    const prepared = await factory.prepareNew(context({ systemPrompt: "会话提示词" }));
    await prepared.open();

    expect(createResourceLoader).toHaveBeenCalledWith({ projectId: DEFAULT_PROJECT_ID, projectCwd: process.cwd(), systemPrompt: "会话提示词", mcpCredentialOwner: null });
    expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ resourceLoader: loaders[0] }));
  });

  it("恢复会话时同样取新 loader（每个活动 session 独立 runtime）", async () => {
    const loaders: ResourceLoader[] = [];
    const createResourceLoader = vi.fn(async (_request: PiResourceLoaderRequest) => {
      const loader = { name: `loader-${loaders.length}` } as unknown as ResourceLoader;
      loaders.push(loader);
      return sessionLoader(loader);
    });
    sdk.openPiRuntimeSessionFile.mockReturnValue({ getHeader: () => ({ cwd: process.cwd() }), getEntries: () => [{ type: "custom", customType: "pi-agent-server:cwd-identity", data: { version: 1, cwd: process.cwd(), dev: 1, ino: 1 } }] });
    const factory = new PiAgentSessionFactory({
      modelRuntime: {} as ModelRuntime,
      defaultModel: { provider: "fixture", id: "default" } as never,
      createResourceLoader,
      agentToolConfig: { noTools: "all" },
    });
    const conversationRef = "/data/sessions/session-1/history.jsonl";

    await factory.restore(
      context({ systemPrompt: "会话提示词", isNewSession: false }),
      { agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef },
    );

    expect(createResourceLoader).toHaveBeenCalledWith({ projectId: DEFAULT_PROJECT_ID, projectCwd: process.cwd(), systemPrompt: "会话提示词", mcpCredentialOwner: null });
    expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ resourceLoader: loaders[0] }));
  });

  it("恢复时 transcript 模型优先，显式固定给 SDK 而不是过期 DB 模型", async () => {
    sdk.openPiRuntimeSessionFile.mockReturnValue({
      getHeader: () => ({ cwd: process.cwd() }),
      getEntries: () => [{ type: "custom", customType: "pi-agent-server:cwd-identity", data: { version: 1, cwd: process.cwd(), dev: 1, ino: 1 } }],
      buildSessionContext: () => ({ model: { provider: "B", modelId: "b" }, thinkingLevel: "high" }),
    });
    const factory = new PiAgentSessionFactory({
      modelRuntime: { getModel: vi.fn((provider, id) => ({ provider, id })) } as unknown as ModelRuntime,
      createResourceLoader: async () => sessionLoader({} as ResourceLoader),
      agentToolConfig: { noTools: "all" },
    });

    await factory.restore(
      context({ isNewSession: false, modelProvider: "A", modelId: "a", thinkingLevel: "low" }),
      { agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: "/data/sessions/session-1/history.jsonl" },
    );

    expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ model: { provider: "B", id: "b" } }));
    expect(sdk.createAgentSession.mock.calls[0]![0]).not.toHaveProperty("thinkingLevel");
  });

  it.each([null, undefined])("无历史模型 %s：DB 优先于 configured default；无 DB 用 default", async model => {
    sdk.openPiRuntimeSessionFile.mockReturnValue({
      getHeader: () => ({ cwd: process.cwd() }),
      getEntries: () => [{ type: "custom", customType: "pi-agent-server:cwd-identity", data: { version: 1, cwd: process.cwd(), dev: 1, ino: 1 } }],
      buildSessionContext: () => ({ model }),
    });
    const fallback = { provider: "fixture", id: "default" };
    const factory = new PiAgentSessionFactory({
      modelRuntime: { getModel: vi.fn((provider, id) => ({ provider, id })) } as unknown as ModelRuntime,
      defaultModel: fallback as never,
      createResourceLoader: async () => sessionLoader({} as ResourceLoader), agentToolConfig: {},
    });
    const conversation = { agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: "/data/sessions/session-1/history.jsonl" };
    await factory.restore(context({ isNewSession: false, modelProvider: "fixture", modelId: "saved" }), conversation);
    expect(sdk.createAgentSession.mock.calls.at(-1)![0].model).toEqual({ provider: "fixture", id: "saved" });
    await factory.restore(context({ isNewSession: false }), conversation);
    expect(sdk.createAgentSession.mock.calls.at(-1)![0].model).toEqual(fallback);
  });

  it.each([null, undefined, { provider: "missing", modelId: "missing" }])("恢复无可用模型 fail closed，不启动 SDK: %j", async model => {
    sdk.openPiRuntimeSessionFile.mockReturnValue({
      getHeader: () => ({ cwd: process.cwd() }),
      getEntries: () => [{ type: "custom", customType: "pi-agent-server:cwd-identity", data: { version: 1, cwd: process.cwd(), dev: 1, ino: 1 } }],
      buildSessionContext: () => ({ model }),
    });
    const factory = new PiAgentSessionFactory({
      modelRuntime: { getModel: vi.fn(() => undefined) } as unknown as ModelRuntime,
      ...(model ? { defaultModel: { provider: "fixture", id: "default" } as never } : {}),
      createResourceLoader: async () => sessionLoader({} as ResourceLoader), agentToolConfig: {},
    });
    await expect(factory.restore(context({ isNewSession: false }), {
      agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: "/data/sessions/session-1/history.jsonl",
    })).rejects.toThrow(model ? "historical session model is unavailable" : "no saved or configured default model");
    expect(sdk.createAgentSession).not.toHaveBeenCalled();
  });

  it("多个会话各自取到不同 loader（绝不按系统提示词共享可变 loader）", async () => {
    const loaders: ResourceLoader[] = [];
    const createResourceLoader = vi.fn(async (_request: PiResourceLoaderRequest) => {
      const loader = { name: `loader-${loaders.length}` } as unknown as ResourceLoader;
      loaders.push(loader);
      return sessionLoader(loader);
    });
    const factory = new PiAgentSessionFactory({
      modelRuntime: {} as ModelRuntime,
      createResourceLoader,
      agentToolConfig: { noTools: "all" },
    });

    for (const sessionId of ["session-1", "session-2"]) {
      const prepared = await factory.prepareNew(context({ sessionId, systemPrompt: "同一个冻结提示词" }));
      await prepared.open();
    }

    expect(loaders).toHaveLength(2);
    expect(loaders[0]).not.toBe(loaders[1]);
    expect(sdk.createAgentSession).toHaveBeenNthCalledWith(1, expect.objectContaining({ resourceLoader: loaders[0] }));
    expect(sdk.createAgentSession).toHaveBeenNthCalledWith(2, expect.objectContaining({ resourceLoader: loaders[1] }));
  });

  it("无 systemPrompt 时仍取新 loader，但快照为 null（由宿主按项目 cwd 重新解析）", async () => {
    const loaders: ResourceLoader[] = [];
    const createResourceLoader = vi.fn(async (_request: PiResourceLoaderRequest) => {
      const loader = { name: `loader-${loaders.length}` } as unknown as ResourceLoader;
      loaders.push(loader);
      return sessionLoader(loader);
    });
    const factory = new PiAgentSessionFactory({
      modelRuntime: {} as ModelRuntime,
      createResourceLoader,
      agentToolConfig: { noTools: "all" },
    });

    for (const systemPrompt of [null, undefined]) {
      sdk.createAgentSession.mockClear();
      const prepared = await factory.prepareNew(context({ systemPrompt }));
      await prepared.open();
      expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ resourceLoader: loaders.at(-1) }));
    }
    expect(createResourceLoader).toHaveBeenCalledTimes(2);
    for (const call of createResourceLoader.mock.calls) {
      expect(call[0]).toEqual({ projectId: DEFAULT_PROJECT_ID, projectCwd: process.cwd(), systemPrompt: null, mcpCredentialOwner: null });
    }
  });
});
