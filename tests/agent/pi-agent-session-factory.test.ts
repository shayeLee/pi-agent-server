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
  SettingsManager: { inMemory: vi.fn(() => ({})) },
}));

vi.mock("../../src/agent/pi-jsonl-conversation-storage.js", () => ({
  openPiRuntimeSessionFile: sdk.openPiRuntimeSessionFile,
}));

import { PiAgentSessionFactory } from "../../src/agent/pi-agent-session-factory.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import type { AgentSessionContext } from "../../src/application/ports/conversation-port.js";
import type { PiResourceLoaderRequest } from "../../src/agent/pi-agent-session-factory.js";

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
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.createAgentSession.mockResolvedValue({
      session: { sessionFile: "/sessions/session.jsonl" },
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

  it("透传自定义工具，同时保留现有工具白名单配置", async () => {
    const customTool = tool("plugin_tool");
    sdk.createAgentSession.mockResolvedValue({
      session: { sessionFile: "/sessions/session.jsonl" },
    });
    const factory = new PiAgentSessionFactory({
      modelRuntime: {} as ModelRuntime,
      createResourceLoader: async () => ({}) as ResourceLoader,
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

  it("每次创建会话都取新的会话专属 loader，且冻结提示词按字面量 override 传入", async () => {
    const loaders: ResourceLoader[] = [];
    const createResourceLoader = vi.fn(async (_request: PiResourceLoaderRequest) => {
      const loader = { name: `loader-${loaders.length}` } as unknown as ResourceLoader;
      loaders.push(loader);
      return loader;
    });
    const factory = new PiAgentSessionFactory({
      modelRuntime: {} as ModelRuntime,
      createResourceLoader,
      agentToolConfig: { noTools: "all" },
    });

    const prepared = await factory.prepareNew(context({ systemPrompt: "会话提示词" }));
    await prepared.open();

    expect(createResourceLoader).toHaveBeenCalledWith({ projectCwd: process.cwd(), systemPrompt: "会话提示词" });
    expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ resourceLoader: loaders[0] }));
  });

  it("恢复会话时同样取新 loader（每个活动 session 独立 runtime）", async () => {
    const loaders: ResourceLoader[] = [];
    const createResourceLoader = vi.fn(async (_request: PiResourceLoaderRequest) => {
      const loader = { name: `loader-${loaders.length}` } as unknown as ResourceLoader;
      loaders.push(loader);
      return loader;
    });
    sdk.openPiRuntimeSessionFile.mockReturnValue({ getHeader: () => ({ cwd: process.cwd() }), getEntries: () => [{ type: "custom", customType: "pi-agent-server:cwd-identity", data: { version: 1, cwd: process.cwd(), dev: 1, ino: 1 } }] });
    const factory = new PiAgentSessionFactory({
      modelRuntime: {} as ModelRuntime,
      createResourceLoader,
      agentToolConfig: { noTools: "all" },
    });
    const conversationRef = "/data/sessions/session-1/history.jsonl";

    await factory.restore(
      context({ systemPrompt: "会话提示词", isNewSession: false }),
      { agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef },
    );

    expect(createResourceLoader).toHaveBeenCalledWith({ projectCwd: process.cwd(), systemPrompt: "会话提示词" });
    expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ resourceLoader: loaders[0] }));
  });

  it("恢复时 transcript 模型优先，不把过期 DB 模型显式覆盖给 SDK", async () => {
    sdk.openPiRuntimeSessionFile.mockReturnValue({
      getHeader: () => ({ cwd: process.cwd() }),
      getEntries: () => [{ type: "custom", customType: "pi-agent-server:cwd-identity", data: { version: 1, cwd: process.cwd(), dev: 1, ino: 1 } }],
      buildSessionContext: () => ({ model: { provider: "B", modelId: "b" }, thinkingLevel: "high" }),
    });
    const factory = new PiAgentSessionFactory({
      modelRuntime: { getModel: vi.fn(() => ({ provider: "A", id: "a" })) } as unknown as ModelRuntime,
      createResourceLoader: async () => ({}) as ResourceLoader,
      agentToolConfig: { noTools: "all" },
    });

    await factory.restore(
      context({ isNewSession: false, modelProvider: "A", modelId: "a", thinkingLevel: "low" }),
      { agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: "/data/sessions/session-1/history.jsonl" },
    );

    expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.not.objectContaining({ model: expect.anything(), thinkingLevel: expect.anything() }));
  });

  it("多个会话各自取到不同 loader（绝不按系统提示词共享可变 loader）", async () => {
    const loaders: ResourceLoader[] = [];
    const createResourceLoader = vi.fn(async (_request: PiResourceLoaderRequest) => {
      const loader = { name: `loader-${loaders.length}` } as unknown as ResourceLoader;
      loaders.push(loader);
      return loader;
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
      return loader;
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
      expect(call[0]).toEqual({ projectCwd: process.cwd(), systemPrompt: null });
    }
  });
});
