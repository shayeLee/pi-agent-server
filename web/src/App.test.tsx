import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "./App.js";
import type { SseEvent, SessionRecord } from "./types.js";

// —— 基础设施 mock（不碰真实网络）——
const mocks = vi.hoisted(() => {
  const instances: {
    baseUrl: string;
    token: string;
    listSessions: ReturnType<typeof vi.fn>;
    listSessionsByProject: ReturnType<typeof vi.fn>;
    listProjects: ReturnType<typeof vi.fn>;
    listModels: ReturnType<typeof vi.fn>;
    createSession: ReturnType<typeof vi.fn>;
    createProject: ReturnType<typeof vi.fn>;
    deleteSession: ReturnType<typeof vi.fn>;
    deleteProject: ReturnType<typeof vi.fn>;
    renameSession: ReturnType<typeof vi.fn>;
    updateSessionConfig: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    steer: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  }[] = [];

  // 探测行为：false = 内网（无 token 也能访问）；true = 公网（需 token）
  let probeFails = false;
  const projectList = [{ id: "default", name: "默认项目", cwd: "/tmp/default" }];

  class MockApiClient {
    baseUrl: string;
    token: string;
    listSessions = vi.fn(() => {
      // 探测（无 token）时按 probeFails 决定；有 token 后总是成功
      if (this.token === "" && probeFails) return Promise.reject(new Error("未授权"));
      return Promise.resolve([...sessionList]);
    });
    listSessionsByProject = vi.fn(() => Promise.resolve([...sessionList]));
    listProjects = vi.fn(() => Promise.resolve([...projectList]));
    createSession = vi.fn((title?: string, projectId?: string) =>
      Promise.resolve({
        id: "new-session",
        ownerKey: "k",
        projectId: projectId ?? "default",
        title: title ?? "",
        createdAt: 1,
        updatedAt: 1,
        modelProvider: null,
        modelId: null,
        thinkingLevel: null, systemPrompt: null,
      }),
    );
    createProject = vi.fn((name: string, cwd: string) =>
      Promise.resolve({ id: "new-project", name, cwd }),
    );
    deleteSession = vi.fn();
    deleteProject = vi.fn(() => Promise.resolve(undefined));
    renameSession = vi.fn();
    listModels = vi.fn(() =>
      Promise.resolve({
        models: [{ provider: "deepseek", id: "v4-pro", name: "DeepSeek V4 Pro" }],
        thinkingLevels: ["off", "low", "medium", "high"],
        defaultModel: { provider: "deepseek", id: "v4-pro", name: "DeepSeek V4 Pro" },
        defaultThinkingLevel: "medium",
      }),
    );
    updateSessionConfig = vi.fn((id: string, config: unknown) =>
      Promise.resolve({
        id,
        ownerKey: "k",
        projectId: "default",
        title: "",
        createdAt: 1,
        updatedAt: 1,
        modelProvider: null,
        modelId: null,
        thinkingLevel: null, systemPrompt: null,
        ...(config as object),
      }),
    );
    sendMessage = vi.fn(() => Promise.resolve(undefined));
    steer = vi.fn(() => Promise.resolve(undefined));
    followUp = vi.fn(() => Promise.resolve(undefined));
    abort = vi.fn(() => Promise.resolve(undefined));
    exportSession = vi.fn(() => Promise.resolve([]));
    constructor(baseUrl: string, token: string) {
      this.baseUrl = baseUrl;
      this.token = token;
      instances.push(this);
    }
  }

  const sse = {
    onEvent: null as null | ((event: SseEvent) => void),
    close: vi.fn(),
  };
  const createSseConnection = vi.fn(
    (options: { onEvent: (event: SseEvent) => void }): { close: () => void } => {
      sse.onEvent = options.onEvent;
      return { close: sse.close };
    },
  );

  const sessionList: SessionRecord[] = [];
  function setSessions(list: SessionRecord[]): void {
    sessionList.length = 0;
    sessionList.push(...list);
  }
  function setProbeFails(v: boolean): void {
    probeFails = v;
  }

  return { instances, MockApiClient, createSseConnection, sse, setSessions, setProbeFails };
});

vi.mock("./lib/api.js", () => ({ ApiClient: mocks.MockApiClient }));
vi.mock("./lib/sse-client.js", () => ({ createSseConnection: mocks.createSseConnection }));

const sessions: SessionRecord[] = [
  { id: "s1", ownerKey: "k", projectId: "default", title: "会话一", createdAt: 1, updatedAt: 1, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null },
  { id: "s2", ownerKey: "k", projectId: "default", title: "会话二", createdAt: 1, updatedAt: 1, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.instances.length = 0;
  mocks.sse.onEvent = null;
  mocks.setProbeFails(false);
});

/** 内网场景：探测成功（无 token 可访问），直接进入会话列表。 */
async function enterIntranet(list: SessionRecord[] = sessions) {
  mocks.setSessions(list);
  render(<App />);
  await waitFor(() => expect(screen.getByText("会话一")).toBeInTheDocument());
  // 探测创建第 1 个实例（token ""），探测成功后 api 创建第 2 个实例；返回 api 实例
  return mocks.instances.at(-1)!;
}

/** 公网场景：探测失败显示 token 框，填 token 后进入会话列表。 */
async function submitToken(list: SessionRecord[] = sessions, token = "sekrit") {
  mocks.setSessions(list);
  mocks.setProbeFails(true);
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText("token")).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText("token"), { target: { value: token } });
  fireEvent.click(screen.getByTestId("token-submit"));
  await waitFor(() => expect(screen.getByText("会话一")).toBeInTheDocument());
  // 探测创建第 1 个实例，填 token 后创建第 2 个
  return mocks.instances.at(-1)!;
}

/** 进入会话列表后选中 s1 并等待 SSE 订阅建立（默认内网场景）。 */
async function enterChat() {
  const inst = await enterIntranet();
  fireEvent.click(screen.getByTestId("session-s1"));
  await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(1));
  return inst;
}

describe("App（顶层流程）", () => {
  it("内网探测成功：免登录直接进入会话列表，token 为空、不落 localStorage", async () => {
    const inst = await enterIntranet();
    expect(screen.getByText("会话二")).toBeInTheDocument();
    expect(inst.token).toBe("");
    expect(window.localStorage.length).toBe(0);
  });

  it("公网探测失败：显示 token 输入框，提交后进入并记录 token", async () => {
    const inst = await submitToken();
    expect(inst.token).toBe("sekrit");
    expect(window.localStorage.length).toBe(0);
  });

  it("内网 SSE 订阅不带 authorization；公网带 Bearer token", async () => {
    // 内网
    await enterChat();
    let options = mocks.createSseConnection.mock.calls[0]![0] as unknown as {
      url: string;
      headers: Record<string, string>;
      lastEventId: number;
    };
    expect(options.url).toBe("/v1/sessions/s1/events");
    expect(options.headers.authorization).toBeUndefined();
    expect(options.lastEventId).toBe(0);
  });

  it("公网 SSE 订阅带 Bearer token", async () => {
    const inst = await submitToken();
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(1));
    const options = mocks.createSseConnection.mock.calls[0]![0] as unknown as {
      headers: Record<string, string>;
    };
    expect(options.headers.authorization).toBe("Bearer sekrit");
    expect(inst.token).toBe("sekrit");
  });

  it("选中会话后事件驱动消息上屏（text_delta 流式 + tool_start 工具卡片）", async () => {
    await enterChat();

    mocks.sse.onEvent?.({ type: "text_delta", text: "你" });
    await waitFor(() => expect(screen.getByText("你")).toBeInTheDocument());
    mocks.sse.onEvent?.({ type: "text_delta", text: "好" });
    await waitFor(() => expect(screen.getByText("你好")).toBeInTheDocument());

    mocks.sse.onEvent?.({
      type: "tool_start",
      toolCallId: "t1",
      toolName: "search",
      args: { q: "x" },
    });
    await waitFor(() => expect(screen.getByTestId("tool-name")).toHaveTextContent("search"));
  });

  it("发送消息：user 消息上屏并调用 sendMessage；text_delta 流式追加 assistant 消息", async () => {
    const inst = await enterChat();

    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "帮我查天气" },
    });
    fireEvent.click(screen.getByTestId("send-button"));

    expect(inst.sendMessage).toHaveBeenCalledWith("s1", {
      requestId: expect.any(String),
      prompt: "帮我查天气",
    });
    await waitFor(() => expect(screen.getByText("帮我查天气")).toBeInTheDocument());

    mocks.sse.onEvent?.({ type: "text_delta", text: "好的，" });
    mocks.sse.onEvent?.({ type: "text_delta", text: "今天晴天" });
    await waitFor(() => expect(screen.getByText("好的，今天晴天")).toBeInTheDocument());
  });

  it("流式阶段可中止", async () => {
    const inst = await enterChat();

    mocks.sse.onEvent?.({ type: "tool_start", toolCallId: "t1", toolName: "search", args: {} });
    await waitFor(() => expect(screen.getByTestId("abort-button")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("abort-button"));
    expect(inst.abort).toHaveBeenCalledWith("s1");
  });

  it("queued 状态显示排队提示，completed 后恢复", async () => {
    await enterChat();

    mocks.sse.onEvent?.({ type: "queued", position: 1 });
    await waitFor(() => expect(screen.getByTestId("phase-queued")).toBeInTheDocument());

    mocks.sse.onEvent?.({ type: "completed" });
    await waitFor(() =>
      expect(screen.queryByTestId("phase-queued")).not.toBeInTheDocument(),
    );
  });

  it("切换到其它会话时关闭旧连接并重建", async () => {
    await enterChat();
    expect(mocks.sse.close).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("session-s2"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(2));
    expect(mocks.sse.close).toHaveBeenCalledTimes(1);
    expect(mocks.createSseConnection.mock.calls[1]![0]).toMatchObject({
      url: "/v1/sessions/s2/events",
    });
  });

  it("删除当前会话后退出聊天并关闭连接", async () => {
    const inst = await enterChat();

    fireEvent.click(screen.getByTestId("delete-s1"));
    await waitFor(() => expect(mocks.sse.close).toHaveBeenCalled());
    expect(inst.deleteSession).toHaveBeenCalledWith("s1");
    expect(screen.getByTestId("no-session-hint")).toBeInTheDocument();
  });
});
