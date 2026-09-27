import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "./App.js";
import type { Project, SseEvent, SessionRecord } from "pi-agent-server/client";

// —— 基础设施 mock（不碰真实网络）——
const mocks = vi.hoisted(() => {
  const instances: {
    baseUrl: string;
    token: string;
    tokenProvided: boolean;
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
    exportSession: ReturnType<typeof vi.fn>;
  }[] = [];

  // 默认项目 id 的测试写照（与 src/application/ports/project-store-port.ts 的 DEFAULT_PROJECT_ID
  // 同值）：Web 不硬编码任何项目 id，默认项目由 isDefault: true 字段从列表推导。
  const DEFAULT_PROJECT_ID = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
  const defaultProjectFixture: Project = {
    id: DEFAULT_PROJECT_ID,
    name: "默认项目",
    cwd: "/tmp/default",
    isDefault: true,
  };
  let projectList: Project[] = [defaultProjectFixture];
  // 项目列表 pending 门闩：用于验证「项目未加载完成前不加载会话、不启用新建」
  let projectListPending = false;
  let releaseProjectList: (() => void) | null = null;

  function setProjects(list: Project[]): void {
    projectList = [...list];
  }
  function resetProjects(): void {
    projectList = [defaultProjectFixture];
  }
  function removeProject(id: string): void {
    projectList = projectList.filter((p) => p.id !== id);
  }
  function setProjectListPending(v: boolean): void {
    projectListPending = v;
    if (!v) {
      releaseProjectList?.();
      releaseProjectList = null;
    }
  }

  // 项目列表主动失败（模拟 GET /v1/projects 报错）
  let projectsFailure: Error | null = null;
  function setProjectsFail(v: boolean | Error): void {
    projectsFailure = v === true ? new Error("连接服务失败") : v === false ? null : v;
  }

  // 「单个项目的会话请求挂起」：用于陈旧响应测试。deferSessionsFor 指定要挂起的项目，
  // releaseDeferredSessions 以传入的列表放行（此时才会触发旧响应覆盖新选择的问题）。
  let deferredSessionsProject: string | null = null;
  const deferredSessionsResolvers = new Map<string, (list: SessionRecord[]) => void>();
  function deferSessionsFor(projectId: string): void {
    deferredSessionsProject = projectId;
  }
  function releaseDeferredSessions(projectId: string, list: SessionRecord[]): void {
    const resolve = deferredSessionsResolvers.get(projectId);
    if (!resolve) throw new Error(`no pending deferred session request for ${projectId}`);
    deferredSessionsResolvers.delete(projectId);
    resolve([...list]);
  }
  function resetDeferredSessions(): void {
    deferredSessionsProject = null;
    deferredSessionsResolvers.clear();
  }

  class MockApiError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
      this.name = "ApiError";
    }
  }

  class MockApiClient {
    baseUrl: string;
    token: string;
    tokenProvided: boolean;
    listSessionsByProject = vi.fn((projectId: string) => {
      if (projectId === deferredSessionsProject) {
        return new Promise<SessionRecord[]>((resolve) => {
          deferredSessionsResolvers.set(projectId, (list) => resolve([...list]));
        });
      }
      return Promise.resolve([...sessionList]);
    });
    listProjects = vi.fn(() =>
      projectsFailure
        ? Promise.reject(projectsFailure)
        : projectListPending
          ? new Promise<Project[]>((resolve) => {
              releaseProjectList = () => resolve([...projectList]);
            })
          : Promise.resolve([...projectList]),
    );
    createSession = vi.fn((title?: string, projectId?: string) =>
      Promise.resolve({
        id: "new-session",
        ownerKey: "k",
        projectId: projectId ?? DEFAULT_PROJECT_ID,
        title: title ?? "",
        createdAt: 1,
        updatedAt: 1,
        modelProvider: null,
        modelId: null,
        thinkingLevel: null, systemPrompt: null,
      }),
    );
    createProject = vi.fn((name: string, cwd: string) =>
      Promise.resolve({ id: "new-project", name, cwd, isDefault: false }),
    );
    deleteSession = vi.fn();
    deleteProject = vi.fn((id: string) => {
      // 与真实删除联动：从项目列表移除，供 refreshProjects 回退默认项目
      removeProject(id);
      return Promise.resolve(undefined);
    });
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
        projectId: DEFAULT_PROJECT_ID,
        title: "",
        createdAt: 1,
        updatedAt: 1,
        modelProvider: null,
        modelId: null,
        thinkingLevel: null, systemPrompt: null,
        ...(config as object),
      }),
    );
    sendMessage = vi.fn((): Promise<unknown> => Promise.resolve(undefined));
    steer = vi.fn(() => Promise.resolve(undefined));
    followUp = vi.fn(() => Promise.resolve(undefined));
    abort = vi.fn(() => Promise.resolve(undefined));
    exportSession = vi.fn((): Promise<unknown> => Promise.resolve([]));
    constructor(options: { baseUrl?: string; token?: string }) {
      this.baseUrl = options.baseUrl ?? "";
      this.token = options.token ?? "";
      this.tokenProvided = options.token !== undefined;
      instances.push(this);
    }
  }

  const sse = {
    onEvent: null as null | ((event: SseEvent) => void),
    onOpen: null as null | (() => void),
    onNoLiveStream: null as null | (() => void),
    close: vi.fn(),
  };
  const createSseConnection = vi.fn(
    (options: {
      onEvent: (event: SseEvent) => void;
      onOpen?: () => void;
      onNoLiveStream?: () => void;
    }): { close: () => void } => {
      sse.onEvent = options.onEvent;
      sse.onOpen = options.onOpen ?? null;
      sse.onNoLiveStream = options.onNoLiveStream ?? null;
      return { close: sse.close };
    },
  );

  const sessionList: SessionRecord[] = [];
  function setSessions(list: SessionRecord[]): void {
    sessionList.length = 0;
    sessionList.push(...list);
  }
  return {
    instances,
    MockApiClient,
    MockApiError,
    createSseConnection,
    sse,
    setSessions,
    setProjects,
    resetProjects,
    setProjectListPending,
    setProjectsFail,
    deferSessionsFor,
    releaseDeferredSessions,
    resetDeferredSessions,
    DEFAULT_PROJECT_ID,
  };
});

vi.mock("pi-agent-server/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pi-agent-server/client")>();
  return {
    ...actual,
    ApiClient: mocks.MockApiClient,
    ApiError: mocks.MockApiError,
    createSseConnection: mocks.createSseConnection,
  };
});

const sessions: SessionRecord[] = [
  { id: "s1", ownerKey: "k", projectId: mocks.DEFAULT_PROJECT_ID, title: "会话一", createdAt: 1, updatedAt: 1, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null },
  { id: "s2", ownerKey: "k", projectId: mocks.DEFAULT_PROJECT_ID, title: "会话二", createdAt: 1, updatedAt: 1, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.instances.length = 0;
  mocks.sse.onEvent = null;
  mocks.sse.onOpen = null;
  mocks.sse.onNoLiveStream = null;
  mocks.resetProjects();
  mocks.setProjectListPending(false);
  mocks.setProjectsFail(false);
  mocks.resetDeferredSessions();
});

/** 内网场景：通过无令牌客户端直接进入会话列表。 */
async function enterIntranet(list: SessionRecord[] = sessions) {
  mocks.setSessions(list);
  render(<App />);
  await waitFor(() => expect(screen.getByText("会话一")).toBeInTheDocument());
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
  it("不做认证探测，直接使用无令牌客户端加载会话且不写入 localStorage", async () => {
    const inst = await enterIntranet();
    expect(screen.getByText("会话二")).toBeInTheDocument();
    expect(mocks.instances).toHaveLength(1);
    expect(inst.token).toBe("");
    expect(inst.tokenProvided).toBe(false);
    expect(window.localStorage.length).toBe(0);
  });

  it("SSE 订阅不带 authorization", async () => {
    await enterChat();
    const options = mocks.createSseConnection.mock.calls[0]![0] as unknown as {
      url: string;
      headers?: Record<string, string>;
      lastEventId: number;
    };
    expect(options.url).toBe("/v1/sessions/s1/events");
    expect(options.headers?.authorization).toBeUndefined();
    expect(options.lastEventId).toBe(0);
  });

  it("恢复会话历史并将导出游标用于 SSE 续传", async () => {
    const inst = await enterIntranet();
    inst.exportSession.mockResolvedValue({
      messages: [
        { role: "user", text: "之前的问题" },
        { role: "assistant", text: "之前的回答" },
      ],
      lastEventId: 42,
    });
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(1));
    expect(screen.getByText("之前的问题")).toBeInTheDocument();
    expect(screen.getByText("之前的回答")).toBeInTheDocument();
    expect(mocks.createSseConnection.mock.calls[0]![0]).toMatchObject({ lastEventId: 42 });
  });

  it("历史请求挂起期间禁用发送，历史恢复后恢复发送", async () => {
    const inst = await enterIntranet();
    let resolveHistory: (data: unknown) => void = () => {};
    inst.exportSession.mockImplementation(
      () => new Promise<unknown>((resolve) => { resolveHistory = resolve; }),
    );

    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(inst.exportSession).toHaveBeenCalledWith("s1"));
    expect(screen.getByTestId("composer-input")).toBeDisabled();
    expect(screen.getByTestId("send-button")).toBeDisabled();
    fireEvent.click(screen.getByTestId("send-button"));
    expect(inst.sendMessage).not.toHaveBeenCalled();

    resolveHistory({ messages: [{ role: "assistant", text: "恢复的历史" }], lastEventId: 12 });
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(1));
    expect(screen.getByText("恢复的历史")).toBeInTheDocument();
    expect(screen.getByTestId("composer-input")).toBeEnabled();

    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "加载后发送" },
    });
    fireEvent.click(screen.getByTestId("send-button"));
    expect(inst.sendMessage).toHaveBeenCalledWith("s1", {
      requestId: expect.any(String),
      prompt: "加载后发送",
    });
  });

  it("切回流式会话时保留已有流式内容，不被再次加载的历史覆盖", async () => {
    const inst = await enterChat();
    mocks.sse.onEvent?.({ type: "text_delta", text: "切回后仍在的回答" });
    await waitFor(() => expect(screen.getByText("切回后仍在的回答")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("session-s2"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(2));

    inst.exportSession.mockResolvedValue({
      messages: [{ role: "assistant", text: "不应覆盖流式内容的旧快照" }],
      lastEventId: 24,
    });
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(3));

    expect(screen.getByText("切回后仍在的回答")).toBeInTheDocument();
    expect(screen.queryByText("不应覆盖流式内容的旧快照")).not.toBeInTheDocument();
    expect(mocks.createSseConnection.mock.calls[2]![0]).toMatchObject({ lastEventId: 24 });
  });

  it("网络发送失败时使用同一 requestId 重试", async () => {
    const inst = await enterChat();
    inst.sendMessage
      .mockRejectedValueOnce(new Error("网络暂时不可用"))
      .mockResolvedValueOnce(undefined);
    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "重试这条消息" },
    });
    fireEvent.click(screen.getByTestId("send-button"));

    await waitFor(() => expect(inst.sendMessage).toHaveBeenCalledTimes(2), { timeout: 3000 });
    const first = inst.sendMessage.mock.calls[0] as unknown as [string, { requestId: string }];
    const retry = inst.sendMessage.mock.calls[1] as unknown as [string, { requestId: string }];
    expect(retry[0]).toBe(first[0]);
    expect(retry[1].requestId).toBe(first[1].requestId);
  });

  it("发送请求失败时回滚仍处于排队状态的用户消息", async () => {
    const inst = await enterChat();
    inst.sendMessage.mockRejectedValueOnce(new mocks.MockApiError(400, "请求无效"));
    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "这条失败消息应回滚" },
    });
    fireEvent.click(screen.getByTestId("send-button"));

    await waitFor(() =>
      expect(screen.queryByText("这条失败消息应回滚")).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId("phase-queued")).not.toBeInTheDocument();
  });

  it("切换会话后取消旧会话的待发送重试", async () => {
    const inst = await enterChat();
    inst.sendMessage.mockRejectedValue(new Error("网络暂时不可用"));
    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "不应重试" },
    });
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(inst.sendMessage).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("session-s2"));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(inst.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("切换会话后隔离聊天状态并忽略旧 SSE 连接迟到的事件", async () => {
    await enterChat();
    mocks.sse.onEvent?.({ type: "text_delta", text: "会话一的回答" });
    await waitFor(() => expect(screen.getByText("会话一的回答")).toBeInTheDocument());
    const staleOnEvent = mocks.sse.onEvent;
    fireEvent.click(screen.getByTestId("session-s2"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(2));

    expect(screen.queryByText("会话一的回答")).not.toBeInTheDocument();
    staleOnEvent?.({ type: "text_delta", text: "过期连接消息" });
    expect(screen.queryByText("过期连接消息")).not.toBeInTheDocument();
  });

  it("SSE 204 no-live-stream 后 UI 保持未连接", async () => {
    await enterChat();

    mocks.sse.onOpen?.();
    await waitFor(() => expect(screen.getByTestId("connection-badge")).toHaveTextContent("已连接"));

    mocks.sse.onNoLiveStream?.();
    await waitFor(() => expect(screen.getByTestId("connection-badge")).toHaveTextContent("未连接"));
    expect(screen.getByTestId("stat-conn")).toHaveTextContent("未连接");
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

  it("项目列表加载完成前不加载会话、不启用新建；默认项目 id 仅从 isDefault 推导", async () => {
    mocks.setProjectListPending(true);
    render(<App />);

    // 项目列表请求已发起但仍 pending：会话保持加载中，无新建按钮，未请求任何项目会话
    await waitFor(() => expect(mocks.instances.at(-1)!.listProjects).toHaveBeenCalled());
    expect(screen.getByTestId("sessions-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("new-session")).not.toBeInTheDocument();
    expect(mocks.instances.at(-1)!.listSessionsByProject).not.toHaveBeenCalled();

    // 放行后：按 isDefault 推导的默认项目 id 加载会话
    mocks.setProjectListPending(false);
    await waitFor(() => expect(screen.getByText("会话一")).toBeInTheDocument());
    expect(mocks.instances.at(-1)!.listSessionsByProject).toHaveBeenCalledWith(mocks.DEFAULT_PROJECT_ID);
    expect(screen.getByTestId("new-session")).toBeInTheDocument();
  });

  it("删除当前额外项目后回退到服务端 isDefault 标示的默认项目", async () => {
    mocks.setProjects([
      { id: mocks.DEFAULT_PROJECT_ID, name: "默认项目", cwd: "/tmp/default", isDefault: true },
      { id: "p1", name: "我的仓库", cwd: "/path/a", isDefault: false },
    ]);
    const inst = await enterIntranet();

    // 切到额外项目
    fireEvent.change(screen.getByTestId("project-select"), { target: { value: "p1" } });
    await waitFor(() => expect(inst.listSessionsByProject).toHaveBeenCalledWith("p1"));

    // 删除当前额外项目：确认后回到 isDefault 标示的默认项目
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByTestId("delete-project"));
    await waitFor(() => {
      const select = screen.getByTestId("project-select") as HTMLSelectElement;
      expect(select.value).toBe(mocks.DEFAULT_PROJECT_ID);
    });
    expect(inst.deleteProject).toHaveBeenCalledWith("p1");
    expect(inst.listSessionsByProject).toHaveBeenLastCalledWith(mocks.DEFAULT_PROJECT_ID);
    vi.restoreAllMocks();
  });

  it("项目列表失败：侧边栏显示可重试错误、不加载项目会话、不启用新建；重试后推导默认项目并加载", async () => {
    mocks.setProjectsFail(true);
    render(<App />);

    // 项目列表请求已发出但失败：不再是永久「加载中…」，而是可重试的错误提示
    await waitFor(() => expect(screen.getByTestId("projects-error")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("项目列表加载失败");
    expect(screen.queryByTestId("sessions-loading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("new-session")).not.toBeInTheDocument();
    const inst = mocks.instances.at(-1)!;
    expect(inst.listSessionsByProject).not.toHaveBeenCalled();

    // 点击重试：服务恢复后按 isDefault 推导默认项目并正常加载会话，错误消失
    mocks.setProjectsFail(false);
    fireEvent.click(screen.getByTestId("retry-projects"));
    await waitFor(() => expect(screen.getByText("会话一")).toBeInTheDocument());
    expect(screen.queryByTestId("projects-error")).not.toBeInTheDocument();
    expect(inst.listSessionsByProject).toHaveBeenCalledWith(mocks.DEFAULT_PROJECT_ID);
    expect(screen.getByTestId("new-session")).toBeInTheDocument();
  });

  it("401 不显示 token 表单，而显示项目加载错误并可重试", async () => {
    mocks.setProjectsFail(new mocks.MockApiError(401, "HTTP 401"));
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("projects-error")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("HTTP 401");
    expect(screen.getByTestId("retry-projects")).toBeInTheDocument();
    expect(screen.queryByTestId("token-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("auth-probing")).not.toBeInTheDocument();
    expect(mocks.instances).toHaveLength(1);
    expect(mocks.instances[0]?.token).toBe("");
    expect(mocks.instances[0]?.tokenProvided).toBe(false);
    expect(mocks.instances[0]?.listProjects).toHaveBeenCalled();
  });

  it("项目列表不含 isDefault 项目：显示可重试错误且不请求项目会话，而非永久加载中", async () => {
    mocks.setProjects([{ id: "pa", name: "项目A", cwd: "/path/a", isDefault: false }]);
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("projects-error")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("默认项目");
    expect(screen.queryByTestId("sessions-loading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("new-session")).not.toBeInTheDocument();
    expect(mocks.instances.at(-1)!.listSessionsByProject).not.toHaveBeenCalled();
  });

  it("陈旧的项目会话响应不会覆盖后选择项目的会话（快速切换项目）", async () => {
    mocks.setProjects([
      { id: mocks.DEFAULT_PROJECT_ID, name: "默认项目", cwd: "/tmp/default", isDefault: true },
      { id: "p1", name: "仓库一", cwd: "/path/a", isDefault: false },
    ]);
    // p1 的会话请求挂起，稍后以陈旧数据放行
    mocks.deferSessionsFor("p1");
    const inst = await enterIntranet();

    // 切到 p1：请求已发出但仍挂起
    fireEvent.change(screen.getByTestId("project-select"), { target: { value: "p1" } });
    await waitFor(() => expect(inst.listSessionsByProject).toHaveBeenLastCalledWith("p1"));

    // 快速切回默认项目：该请求立即成功（展示会话一/会话二）
    fireEvent.change(screen.getByTestId("project-select"), {
      target: { value: mocks.DEFAULT_PROJECT_ID },
    });
    await waitFor(() => expect(inst.listSessionsByProject).toHaveBeenCalledTimes(3));

    // p1 的陈旧响应最后才返回：不得覆盖当前默认项目的会话
    mocks.releaseDeferredSessions("p1", [
      {
        id: "p1-old",
        ownerKey: "k",
        projectId: "p1",
        title: "p1 的陈旧会话",
        createdAt: 1,
        updatedAt: 1,
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        systemPrompt: null,
      },
    ]);
    expect(screen.queryByText("p1 的陈旧会话")).not.toBeInTheDocument();
    expect(screen.getByText("会话一")).toBeInTheDocument();
    expect(screen.getByText("会话二")).toBeInTheDocument();
  });
});
