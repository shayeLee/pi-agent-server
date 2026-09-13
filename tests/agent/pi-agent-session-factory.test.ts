import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime, ResourceLoader, ToolDefinition } from "@earendil-works/pi-coding-agent";

const sdk = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  sessionManager: { getSessionFile: vi.fn(() => "/sessions/session.jsonl") },
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
      projectCwd: "/project",
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
      resourceLoader: {} as ResourceLoader,
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

  it("创建会话时用 systemPrompt 解析出的 loader 替换共享 loader", async () => {
    const sharedLoader = { name: "shared" } as unknown as ResourceLoader;
    const promptLoader = { name: "prompt" } as unknown as ResourceLoader;
    const resolveLoader = vi.fn(async () => promptLoader);
    const factory = new PiAgentSessionFactory({
      modelRuntime: {} as ModelRuntime,
      resourceLoader: sharedLoader,
      resourceLoaderForSystemPrompt: resolveLoader,
      agentToolConfig: { noTools: "all" },
    });

    const prepared = await factory.prepareNew(context({ systemPrompt: "会话提示词" }));
    await prepared.open();

    expect(resolveLoader).toHaveBeenCalledWith("会话提示词");
    expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ resourceLoader: promptLoader }));
  });

  it("恢复会话时同样使用 systemPrompt 解析出的 loader", async () => {
    const sharedLoader = { name: "shared" } as unknown as ResourceLoader;
    const promptLoader = { name: "prompt" } as unknown as ResourceLoader;
    const resolveLoader = vi.fn(async () => promptLoader);
    sdk.openPiRuntimeSessionFile.mockReturnValue({});
    const factory = new PiAgentSessionFactory({
      modelRuntime: {} as ModelRuntime,
      resourceLoader: sharedLoader,
      resourceLoaderForSystemPrompt: resolveLoader,
      agentToolConfig: { noTools: "all" },
    });
    const conversationRef = "/data/sessions/session-1/history.jsonl";

    await factory.restore(
      context({ systemPrompt: "会话提示词", isNewSession: false }),
      { agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef },
    );

    expect(resolveLoader).toHaveBeenCalledWith("会话提示词");
    expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ resourceLoader: promptLoader }));
  });

  it("无 systemPrompt 时保留共享 loader，且不调用解析器", async () => {
    const sharedLoader = { name: "shared" } as unknown as ResourceLoader;
    const resolveLoader = vi.fn(async () => ({ name: "prompt" }) as unknown as ResourceLoader);
    const factory = new PiAgentSessionFactory({
      modelRuntime: {} as ModelRuntime,
      resourceLoader: sharedLoader,
      resourceLoaderForSystemPrompt: resolveLoader,
      agentToolConfig: { noTools: "all" },
    });

    for (const systemPrompt of [null, undefined]) {
      sdk.createAgentSession.mockClear();
      const prepared = await factory.prepareNew(context({ systemPrompt }));
      await prepared.open();
      expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ resourceLoader: sharedLoader }));
    }
    expect(resolveLoader).not.toHaveBeenCalled();
  });

  it("未提供解析器时即使有 systemPrompt 也保留共享 loader", async () => {
    const sharedLoader = { name: "shared" } as unknown as ResourceLoader;
    const factory = new PiAgentSessionFactory({
      modelRuntime: {} as ModelRuntime,
      resourceLoader: sharedLoader,
      agentToolConfig: { noTools: "all" },
    });

    const prepared = await factory.prepareNew(context({ systemPrompt: "会话提示词" }));
    await prepared.open();

    expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ resourceLoader: sharedLoader }));
  });
});
