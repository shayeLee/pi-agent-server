import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import App, { TRACE_DEFAULT_MIN_WIDTH } from "./App.js";
import { themePreferenceKey } from "./theme-preference.js";
import { DEFAULT_PROJECT_ID } from "pi-agent-server/client";
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
    getAccess: ReturnType<typeof vi.fn>;
    uploadFile: ReturnType<typeof vi.fn>;
    createSession: ReturnType<typeof vi.fn>;
    createProject: ReturnType<typeof vi.fn>;
    deleteSession: ReturnType<typeof vi.fn>;
    deleteProject: ReturnType<typeof vi.fn>;
    renameSession: ReturnType<typeof vi.fn>;
    updateSessionConfig: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    steer: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    getControlQueue: ReturnType<typeof vi.fn>;
    getSubagents: ReturnType<typeof vi.fn>;
    getSessionSteps: ReturnType<typeof vi.fn>;
    getSystemPrompt: ReturnType<typeof vi.fn>;
    deleteControl: ReturnType<typeof vi.fn>;
    promoteControl: ReturnType<typeof vi.fn>;
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
    // Route resolution reads authorized metadata across projects.
    listSessions = vi.fn(() => Promise.resolve([...sessionList]));
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
    getAccess = vi.fn(() => Promise.resolve({ canRead: true, canWrite: true }));
    uploadFile = vi.fn((input: { name: string; mediaType: string }) => Promise.resolve({
      fileId: "00000000-0000-4000-8000-000000000099", name: input.name, mediaType: input.mediaType,
      size: 10, status: "ready", agentPath: "/server/uploads/file",
    }));
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
    getControlQueue = vi.fn(() => Promise.resolve({ requestId: null, revision: 0, items: [] }));
    deleteControl = vi.fn(() => Promise.resolve({ requestId: null, revision: 1, items: [] }));
    promoteControl = vi.fn(() => Promise.resolve({ requestId: null, revision: 1, items: [] }));
    getSubagents = vi.fn(async (sessionId: string, _runId?: string): Promise<import("pi-agent-server/client").SubagentSnapshot> => ({ sessionId, runs: [] }));
    getSessionSteps = vi.fn((sessionId: string) => Promise.resolve({ sessionId, projectionId: "test", revision: 0, steps: [] }));
    getSystemPrompt = vi.fn(() => Promise.resolve({ source: "unavailable", prompt: null }));
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
    onEvent: null as null | ((event: SseEvent, lastEventId?: number) => void),
    onOpen: null as null | (() => void),
    onNoLiveStream: null as null | (() => void),
    onError: null as null | (() => void),
    onDisconnect: null as null | (() => void),
    close: vi.fn(),
  };
  const createSseConnection = vi.fn(
    (options: {
      onEvent: (event: SseEvent, lastEventId?: number) => void;
      onOpen?: () => void;
      onNoLiveStream?: () => void;
      onError?: () => void;
      onDisconnect?: () => void;
    }): { close: () => void } => {
      sse.onEvent = options.onEvent;
      sse.onOpen = options.onOpen ?? null;
      sse.onNoLiveStream = options.onNoLiveStream ?? null;
      sse.onError = options.onError ?? null;
      sse.onDisconnect = options.onDisconnect ?? null;
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
  window.sessionStorage.clear();
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.instances.length = 0;
  mocks.sse.onEvent = null;
  mocks.sse.onOpen = null;
  mocks.sse.onNoLiveStream = null;
  mocks.sse.onError = null;
  mocks.sse.onDisconnect = null;
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
  it("呈现中文基础文案且保留原有标签与提示", async () => {
    await enterIntranet();
    expect(screen.getByTestId("toggle-sidebar")).toHaveAttribute("title", "折叠侧边栏");
    expect(screen.getByTestId("toggle-sidebar")).toHaveAttribute("aria-label", "折叠侧边栏");
    expect(screen.getByTestId("new-session")).toHaveTextContent("新建会话");
    expect(screen.queryByText("工作区 / 项目")).not.toBeInTheDocument();
    expect(screen.queryByText("会话")).not.toBeInTheDocument();
    expect(screen.getByTestId("project-select")).toBeVisible();
    expect(screen.getByRole("button", { name: "打开工作区导航" })).toBeInTheDocument();
    expect(screen.getByTestId("theme-toggle")).toHaveAttribute("aria-label", "主题");
  });
  it("图片追加结果未知时仅原会话精确确认才清除原草稿与图片", async () => {
    const inst = await enterChat();
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "primary" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(inst.sendMessage).toHaveBeenCalledOnce());
    const request = inst.sendMessage.mock.calls[0]![1] as { requestId: string };
    act(() => mocks.sse.onEvent?.({ type: "status", phase: "agent_start", requestId: request.requestId }));
    inst.followUp.mockRejectedValueOnce(new Error('lost image admission'));
    fireEvent.change(input, { target: { value: "image steering" } });
    fireEvent.paste(input, { clipboardData: { files: [new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "small.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getByTestId("composer-attachment")).toHaveAttribute("data-state", "ready"));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(inst.followUp).toHaveBeenCalledWith("s1", "image steering", expect.objectContaining({ images: [expect.objectContaining({ mediaType: "image/png", base64: expect.any(String) })] })));
    const identity = inst.followUp.mock.calls[0]![2] as { controlId: string; acknowledgementId: string; requestId: string };
    const ack: SseEvent = { type: "steering_consumed", controlId: identity.controlId, acknowledgementId: identity.acknowledgementId, requestId: identity.requestId };
    fireEvent.click(screen.getByTestId("session-s2"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(2));
    act(() => mocks.sse.onEvent?.(ack)); // Identical identity on a different session is not ours.
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId("composer-input")).toHaveValue("image steering");
    expect(screen.getByTestId("composer-attachment")).toBeInTheDocument();
    expect(screen.getByTestId("composer-pending-controls")).toBeInTheDocument();
    act(() => mocks.sse.onEvent?.(ack));
    expect(screen.getByTestId("composer-input")).toHaveValue("");
    expect(screen.queryByTestId("composer-attachment")).not.toBeInTheDocument();
    expect(screen.queryByTestId("composer-pending-controls")).not.toBeInTheDocument();
  });

  it.each(["http-first", "sse-first", "unknown"])("追加准入与精确确认，%s 不终止主任务、不丢新草稿附件", async order => {
    const inst = await enterChat();
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "primary" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(inst.sendMessage).toHaveBeenCalledOnce());
    const request = inst.sendMessage.mock.calls[0]![1] as { requestId: string };
    act(() => mocks.sse.onEvent?.({ type: "status", phase: "agent_start", requestId: request.requestId }));
    let finish!: () => void;
    inst.followUp.mockImplementationOnce(() => order === "unknown" ? Promise.reject(new Error("lost response")) : new Promise<void>(resolve => { finish = resolve; }));
    fireEvent.change(input, { target: { value: "same" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(inst.followUp).toHaveBeenCalledOnce());
    expect(inst.steer).not.toHaveBeenCalled();
    const [sessionId, , identity] = inst.followUp.mock.calls[0] as unknown as [string, string, { controlId: string; acknowledgementId: string; requestId: string }];
    expect(sessionId).toBe("s1");
    const ack: SseEvent = { type: "steering_consumed", ...identity, message: { sourceId: "actual-entry", text: "consumed same" } };
    expect(screen.queryByText("consumed same")).not.toBeInTheDocument();
    if (order === "http-first") { await act(async () => finish()); expect(screen.getByTestId("composer-pending-controls")).toHaveTextContent("已提交，等待确认"); expect(input).toHaveValue(''); }
    if (order === "unknown") await waitFor(() => expect(screen.getByTestId("composer-pending-controls")).toHaveTextContent("状态未知"));
    act(() => {
      mocks.sse.onEvent?.({ ...ack, controlId: "foreign", message: { sourceId: "shared-entry", text: "shared actor consumed" } });
      mocks.sse.onEvent?.({ ...ack, acknowledgementId: "foreign", message: undefined });
      mocks.sse.onEvent?.({ ...ack, requestId: "foreign", message: { sourceId: "wrong-request", text: "must not display" } });
    });
    expect(screen.getByTestId("composer-pending-controls")).toBeInTheDocument();
    expect(input).toHaveValue(order === 'http-first' ? '' : 'same');
    expect(screen.getByText("shared actor consumed")).toBeInTheDocument();
    expect(screen.queryByText("must not display")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "new draft" } });
    fireEvent.change(screen.getByTestId("composer-file-input"), { target: { files: [new File(["new"], "new.txt", { type: "text/plain" })] } });
    await waitFor(() => expect(screen.getByTestId("composer-attachment")).toHaveAttribute("data-state", "ready"));
    act(() => { mocks.sse.onEvent?.(ack); mocks.sse.onEvent?.(ack); });
    if (order === "sse-first") await act(async () => finish());
    expect(screen.getAllByText("consumed same")).toHaveLength(1);
    expect(screen.queryByTestId("composer-pending-controls")).not.toBeInTheDocument();
    expect(input).toHaveValue("new draft");
    expect(screen.getByTestId("composer-attachment")).toHaveTextContent("new.txt");
    act(() => mocks.sse.onEvent?.({ type: "text_delta", text: "primary still active", requestId: request.requestId }));
    expect(screen.getByText("primary still active")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(inst.followUp).toHaveBeenCalledOnce();
    expect(inst.steer).not.toHaveBeenCalled();
    expect(input).toHaveValue("new draft");
    expect(screen.getByTestId("composer-attachment")).toBeInTheDocument();
  });
  it("共享自动项目禁用新建和初始输入，但可打开已有会话继续且不改投默认项目", async () => {
    mocks.setProjects([{ id: "auto", name: "Shared", cwd: "/tmp/shared", isDefault: false, canCreateSession: false }]);
    mocks.setSessions(sessions.map(session => ({ ...session, projectId: "auto" })));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("new-session")).toBeDisabled());
    expect(screen.getByText("当前权限无法在此项目新建会话")).toBeVisible();
    expect(screen.getByTestId("composer-input")).toBeDisabled();
    expect(screen.getByTestId("send-button")).toBeDisabled();
    fireEvent.click(screen.getByTestId("new-session"));
    const inst = mocks.instances[0]!;
    expect(inst.createSession).not.toHaveBeenCalled();
    expect(inst.listSessionsByProject).toHaveBeenCalledWith("auto");
    fireEvent.click(await screen.findByText("会话二"));
    await waitFor(() => expect(screen.getByTestId("composer-input")).toBeEnabled());
    expect(screen.getByTestId("new-session")).toBeDisabled();
  });
  it("主题菜单默认跟随系统，手动模式忽略系统变化，切回系统立即应用", async () => {
    const originalMatchMedia = window.matchMedia;
    let matches = true;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        media: query,
        get matches() { return query === "(prefers-color-scheme: dark)" ? matches : false; },
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
      }),
    });
    try {
      render(<App />);
      const app = screen.getByTestId("app");
      const toggle = screen.getByTestId("theme-toggle");
      const openMenu = async () => {
        fireEvent.keyDown(toggle, { key: "ArrowDown" });
        await screen.findByRole("menuitemradio", { name: "跟随系统" });
      };
      const choose = async (name: string) => {
        await openMenu();
        fireEvent.click(screen.getByRole("menuitemradio", { name }));
      };
      await openMenu();
      expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
      expect(screen.getByRole("menuitemradio", { name: "跟随系统" })).toHaveAttribute("aria-checked", "true");
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      expect(screen.queryByText("已跟随系统")).not.toBeInTheDocument();
      // Ledger brand is a mono wordmark with an accessible product name (DESIGN.md §7).
      const brand = document.querySelector(".ledger-brand");
      expect(brand).toHaveAttribute("aria-label", "pi-agent-server");
      expect(brand).toHaveTextContent("pi/agent");
      expect(document.querySelector(".brand-mark")).toBeNull();
      expect(app).toHaveAttribute("data-theme", "dark");
      await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "dark"));

      matches = false;
      act(() => listeners.forEach((listener) => listener({ matches, media: "(prefers-color-scheme: dark)" } as MediaQueryListEvent)));
      expect(app).toHaveAttribute("data-theme", "light");
      expect(toggle).toHaveAttribute("aria-label", "主题");
      await choose("深色");
      expect(localStorage.getItem(themePreferenceKey())).toBe("dark");
      expect(app).toHaveAttribute("data-theme", "dark");
      matches = false;
      act(() => listeners.forEach((listener) => listener({ matches } as MediaQueryListEvent)));
      expect(app).toHaveAttribute("data-theme", "dark");
      await choose("浅色");
      expect(localStorage.getItem(themePreferenceKey())).toBe("light");
      expect(app).toHaveAttribute("data-theme", "light");

      matches = true;
      act(() => listeners.forEach((listener) => listener({ matches, media: "(prefers-color-scheme: dark)" } as MediaQueryListEvent)));
      expect(app).toHaveAttribute("data-theme", "light");
      await openMenu();
      expect(screen.getByRole("menuitemradio", { name: "浅色" })).toHaveAttribute("aria-checked", "true");
      fireEvent.click(screen.getByRole("menuitemradio", { name: "跟随系统" }));
      expect(app).toHaveAttribute("data-theme", "dark");
      expect(localStorage.getItem(themePreferenceKey())).toBe("system");
      matches = false;
      act(() => listeners.forEach((listener) => listener({ matches } as MediaQueryListEvent)));
      expect(app).toHaveAttribute("data-theme", "light");
      expect(localStorage.getItem(themePreferenceKey())).toBe("system");
      await choose("浅色");
      // Restore following even when the current palette already matches the OS.
      await choose("跟随系统");
      await openMenu();
      expect(screen.getByRole("menuitemradio", { name: "跟随系统" })).toHaveAttribute("aria-checked", "true");
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
    }
  });

  it.each(["light", "dark", "system"] as const)("刷新重挂载恢复 %s 模式，初始主题与模式一致", async (mode) => {
    const originalMatchMedia = window.matchMedia;
    let matches = mode !== "dark";
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    Object.defineProperty(window, "matchMedia", { configurable: true, value: (query: string) => ({
      get matches() { return query === "(prefers-color-scheme: dark)" && matches; },
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    }) });
    try {
      const first = render(<App />);
      fireEvent.keyDown(screen.getByTestId("theme-toggle"), { key: "ArrowDown" });
      fireEvent.click(await screen.findByRole("menuitemradio", { name: { light: "浅色", dark: "深色", system: "跟随系统" }[mode] }));
      expect(localStorage.getItem(themePreferenceKey())).toBe(mode);
      first.unmount();
      matches = !matches;
      const restored = render(<App />);
      const expected = mode === "system" ? (matches ? "dark" : "light") : mode;
      expect(screen.getByTestId("app")).toHaveAttribute("data-theme", expected);
      expect(document.documentElement).toHaveAttribute("data-theme", expected);
      fireEvent.keyDown(screen.getByTestId("theme-toggle"), { key: "ArrowDown" });
      expect(await screen.findByRole("menuitemradio", { name: { light: "浅色", dark: "深色", system: "跟随系统" }[mode] })).toHaveAttribute("aria-checked", "true");
      matches = !matches;
      act(() => listeners.forEach(listener => listener({ matches } as MediaQueryListEvent)));
      expect(screen.getByTestId("app")).toHaveAttribute("data-theme", mode === "system" ? (matches ? "dark" : "light") : mode);
      restored.unmount();
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
    }
  });

  it("存储读写失败不妨碍 App 启动与手动选择", async () => {
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    try {
      render(<App />);
      fireEvent.keyDown(screen.getByTestId("theme-toggle"), { key: "ArrowDown" });
      expect(await screen.findByRole("menuitemradio", { name: "跟随系统" })).toHaveAttribute("aria-checked", "true");
      fireEvent.click(screen.getByRole("menuitemradio", { name: "深色" }));
      expect(screen.getByTestId("app")).toHaveAttribute("data-theme", "dark");
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    } finally { read.mockRestore(); write.mockRestore(); }
  });

  it("系统为亮色时以亮色启动", async () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false }) });
    try {
      render(<App />);
      expect(screen.getByTestId("app")).toHaveAttribute("data-theme", "light");
      expect(screen.getByTestId("theme-toggle")).toHaveAttribute("aria-label", "主题");
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
    }
  });

  it("不做认证探测，直接使用无令牌客户端加载会话且不写入 localStorage", async () => {
    const inst = await enterIntranet();
    expect(screen.getByText("会话二")).toBeInTheDocument();
    expect(mocks.instances).toHaveLength(1);
    expect(inst.token).toBe("");
    expect(inst.tokenProvided).toBe(false);
    expect(window.localStorage.length).toBe(0);
  });

  it("默认呈现对话布局，单一轨迹开关可打开并关闭事件面板", async () => {
    await enterChat();
    expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-tab")).not.toBeInTheDocument();
    expect(screen.getByTestId("trace-tab")).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByTestId("trace-tab"));
    expect(screen.getByTestId("inspector")).toBeInTheDocument();
    expect(screen.getByTestId("trace-tab")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("inspector")).toHaveAttribute("id", screen.getByTestId("trace-tab").getAttribute("aria-controls"));
    // The trace opens on its first tab, subagents; steps load only when their tab is chosen.
    expect(screen.getByTestId("inspector-tab-subagents")).toHaveAttribute("aria-selected", "true");
    expect(mocks.instances[0].getSessionSteps).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("inspector-tab-steps"));
    await waitFor(() => expect(mocks.instances[0].getSessionSteps).toHaveBeenCalled());
    expect(mocks.instances[0].getSystemPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("inspector-tab-systemPrompt"));
    await waitFor(() => expect(mocks.instances[0].getSystemPrompt).toHaveBeenCalled());
    expect(screen.getByTestId("inspector-tab-systemPrompt")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByTestId("inspector-tab-events"));
    expect(screen.getByTestId("inspector-tab-events")).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByTestId("trace-tab"));
    expect(screen.getByTestId("trace-tab")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();
  });

  it("打开会话地址时首帧就为轨迹留位，会话就绪后原位填入；会话不可用时撤掉留位", async () => {
    const wide = vi.fn((query: string) => ({ matches: query === `(min-width: ${TRACE_DEFAULT_MIN_WIDTH}px)`, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn() }));
    vi.stubGlobal("matchMedia", wide);
    try {
      mocks.setSessions(sessions);
      window.history.replaceState(null, "", `/p/${encodeURIComponent(mocks.DEFAULT_PROJECT_ID)}/s/s1`);
      const first = render(<App />);
      // Before the session list loads, the trace column is already reserved: nothing shifts later.
      expect(screen.getByTestId("inspector-placeholder")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId("inspector")).toBeInTheDocument());
      expect(screen.queryByTestId("inspector-placeholder")).toBeNull();
      first.unmount();
      window.history.replaceState(null, "", `/p/${encodeURIComponent(mocks.DEFAULT_PROJECT_ID)}/s/missing`);
      render(<App />);
      expect(screen.getByTestId("inspector-placeholder")).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByTestId("inspector-placeholder")).toBeNull());
      expect(screen.queryByTestId("inspector")).toBeNull();
    } finally { vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); }
  });

  it("对话能保持完整宽度时默认打开轨迹并停在子代理；手动关闭后切换会话保持关闭", async () => {
    const wide = vi.fn((query: string) => ({ matches: query === `(min-width: ${TRACE_DEFAULT_MIN_WIDTH}px)`, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn() }));
    vi.stubGlobal("matchMedia", wide);
    try {
      await enterChat();
      expect(screen.getByTestId("inspector")).toBeInTheDocument();
      expect(screen.getByTestId("trace-tab")).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("inspector-tab-subagents")).toHaveAttribute("aria-selected", "true");
      fireEvent.click(screen.getByTestId("trace-tab"));
      expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("session-s2"));
      await waitFor(() => expect(screen.getByTestId("trace-tab")).toHaveAttribute("aria-expanded", "false"));
      expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();
    } finally { vi.unstubAllGlobals(); }
  });

  it("Inspector 无遮罩、不捕获 Tab；Esc 关闭回焦并保留草稿", async () => {
    await enterChat();
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "sidebar draft" } });
    fireEvent.click(screen.getByTestId("trace-tab"));
    expect(document.querySelector('.workbench-inspector-backdrop')).toBeNull();
    expect(screen.getByTestId("app").style.getPropertyValue('--layout-inspector-width')).toBe('380px');
    input.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('trace-tab')).toHaveFocus());
    expect(input).toHaveValue('sidebar draft');
  });

  it("打开 Inspector 与主题菜单不改变事件流或触发额外检查请求", async () => {
    await enterChat();
    act(() => mocks.sse.onEvent?.({ type: "text_delta", text: "event fixture" }));
    fireEvent.click(screen.getByTestId("trace-tab"));
    fireEvent.click(screen.getByTestId("inspector-tab-steps"));
    await waitFor(() => expect(mocks.instances[0].getSessionSteps).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("inspector-tab-events"));
    const events = screen.getByTestId("event-log").textContent;
    expect(events).toContain("event fixture");
    fireEvent.keyDown(screen.getByTestId("theme-toggle"), { key: "ArrowDown" });
    expect(await screen.findByRole("menuitemradio", { name: "跟随系统" })).toBeInTheDocument();
    expect(screen.getByTestId("event-log").textContent).toBe(events);
    expect(mocks.instances[0].getSessionSteps).toHaveBeenCalledTimes(1);
    expect(mocks.instances[0].getSystemPrompt).not.toHaveBeenCalled();
  });

  it("创建前可选择项目，首次发送在所选项目创建会话并发送消息，创建后隐藏项目选择", async () => {
    mocks.setProjects([
      { id: mocks.DEFAULT_PROJECT_ID, name: "默认项目", cwd: "/tmp/default", isDefault: true },
      { id: "p1", name: "我的仓库", cwd: "/path/a", isDefault: false },
    ]);
    const inst = await enterIntranet();
    const picker = screen.getByTestId("project-select");
    expect(screen.queryByTestId("composer-project-select")).not.toBeInTheDocument();
    expect(picker).toHaveAttribute("data-value", mocks.DEFAULT_PROJECT_ID);
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "我的仓库" }));
    await waitFor(() => expect(inst.listSessionsByProject).toHaveBeenLastCalledWith("p1"));

    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "新项目的第一条消息" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(inst.createSession).toHaveBeenCalledWith(undefined, "p1", expect.any(String)));
    await waitFor(() => expect(inst.sendMessage).toHaveBeenCalledWith("new-session", {
      requestId: expect.any(String),
      prompt: "新项目的第一条消息",
    }));
    expect(screen.queryByTestId("composer-project-select")).not.toBeInTheDocument();
  });

  it.each([false, true])("new-session Enter stays primary across creation and streaming (unknown HTTP: %s)", async unknown => {
    const inst = await enterIntranet();
    let releaseCreate!: (value: unknown) => void;
    let releaseSend!: () => void;
    let rejectSend!: (error: Error) => void;
    let releaseConfig!: (value: unknown) => void;
    inst.updateSessionConfig.mockImplementationOnce(() => new Promise(resolve => { releaseConfig = resolve; }));
    fireEvent.click(screen.getByTestId("thinking-trigger"));
    fireEvent.click(screen.getByRole("radio", { name: "low" }));
    fireEvent.click(screen.getByTestId("thinking-trigger"));
    inst.createSession.mockImplementationOnce(() => new Promise(resolve => { releaseCreate = resolve; }));
    inst.sendMessage.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { releaseSend = resolve; rejectSend = reject; }));
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "primary first" } });
    const enter = () => fireEvent.keyDown(screen.getByTestId("composer-input"), { key: "Enter", code: "Enter" });
    enter(); enter();
    expect(inst.createSession).toHaveBeenCalledTimes(1);
    expect(inst.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId("send-button")).toBeDisabled();
    const created = { ...sessions[0]!, id: "new-session", title: "" };
    await act(async () => releaseCreate(created));
    await waitFor(() => expect(inst.updateSessionConfig).toHaveBeenCalledTimes(1));
    enter();
    expect(screen.getByTestId("send-button")).toBeDisabled();
    expect(inst.sendMessage).not.toHaveBeenCalled();
    expect(inst.steer).not.toHaveBeenCalled();
    await act(async () => releaseConfig({ ...created, thinkingLevel: "low" }));
    await waitFor(() => expect(inst.sendMessage).toHaveBeenCalledTimes(1));
    const [, primary] = inst.sendMessage.mock.calls[0] as unknown as [string, { requestId: string; prompt: string }];
    expect(primary.prompt).toBe("primary first");
    if (!unknown) act(() => mocks.sse.onEvent?.({ type: "status", phase: "agent_start", requestId: primary.requestId }));
    enter();
    expect(screen.getByTestId("composer-input")).toHaveValue("primary first");
    if (unknown) expect(screen.getByTestId("send-button")).toBeDisabled();
    else expect(screen.getByTestId("abort-button")).toBeEnabled();
    expect(inst.steer).not.toHaveBeenCalled();
    expect(inst.followUp).not.toHaveBeenCalled();
    await act(async () => unknown ? rejectSend(new Error("lost HTTP receipt")) : releaseSend());
    if (unknown) {
      await waitFor(() => expect(screen.getByTestId("composer-submit-notice")).toHaveTextContent("结果未知"));
      enter();
      expect(screen.getByTestId("send-button")).toBeDisabled();
      expect(screen.getByTestId("composer-input")).toHaveValue("primary first");
      expect(inst.steer).not.toHaveBeenCalled();
      expect(inst.followUp).not.toHaveBeenCalled();
      act(() => mocks.sse.onEvent?.({ type: "status", phase: "agent_start", requestId: primary.requestId }));
    }
    await waitFor(() => expect(screen.getByTestId("composer-input")).toHaveValue(""));
    enter();
    expect(inst.sendMessage).toHaveBeenCalledTimes(1);
    expect(inst.steer).not.toHaveBeenCalled();
    expect(inst.followUp).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "new intentional guide" } });
    enter();
    await waitFor(() => expect(inst.followUp).toHaveBeenCalledTimes(1));
    expect(inst.followUp).toHaveBeenCalledWith("new-session", "new intentional guide", expect.objectContaining({ requestId: primary.requestId }));
    expect(inst.steer).not.toHaveBeenCalled();
  });

  it("活动用户请求期间异属 error/terminal/queued 不停止 controller UI", async () => {
    const inst = await enterChat();
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "active user" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(inst.sendMessage).toHaveBeenCalledTimes(1));
    const [, request] = inst.sendMessage.mock.calls[0] as unknown as [string, { requestId: string }];
    act(() => {
      mocks.sse.onEvent?.({ type: "status", phase: "agent_start", requestId: request.requestId });
      mocks.sse.onEvent?.({ type: "text_delta", text: "owned answer", requestId: request.requestId });
    });
    await waitFor(() => expect(screen.getByTestId("abort-button")).toHaveAttribute("title", "中止（连按两次 Esc）"));
    act(() => {
      mocks.sse.onEvent?.({ type: "error", message: "pending notification rejected", requestId: "notification-race" });
      mocks.sse.onEvent?.({ type: "completed", requestId: "old" });
      mocks.sse.onEvent?.({ type: "queued", position: 1, requestId: "old" });
      mocks.sse.onEvent?.({ type: "status", phase: "agent_start", requestId: "old" });
      mocks.sse.onEvent?.({ type: "text_delta", text: " foreign text", requestId: "old" });
    });
    expect(screen.getByTestId("abort-button")).toHaveAttribute("title", "中止（连按两次 Esc）");
    expect(screen.queryByTestId("phase-queued")).not.toBeInTheDocument();
    expect(screen.queryByText(/foreign text/)).not.toBeInTheDocument();
    act(() => mocks.sse.onEvent?.({ type: "text_delta", text: " continues", requestId: request.requestId }));
    expect(screen.getByText("owned answer continues")).toBeInTheDocument();
    act(() => mocks.sse.onEvent?.({ type: "completed", requestId: request.requestId }));
    await waitFor(() => expect(screen.getByTestId("send-button")).toHaveAttribute("title", "发送"));
    expect(screen.queryByTestId("abort-button")).not.toBeInTheDocument();
  });

  it("未知结果收到匹配 requestId 的 SSE 正面确认后清除旧输入，不重发", async () => {
    const inst = await enterChat();
    inst.sendMessage.mockRejectedValueOnce(new Error("connection lost"));
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "等待确认" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(screen.getByTestId("composer-submit-notice")).toHaveTextContent("结果未知"));
    const [, request] = inst.sendMessage.mock.calls[0] as unknown as [string, { requestId: string }];
    mocks.sse.onEvent?.({ type: "queued", position: 1, requestId: request.requestId });
    await waitFor(() => expect(screen.queryByTestId("composer-submit-notice")).not.toBeInTheDocument());
    expect(screen.getByTestId("composer-input")).toHaveValue("");
    expect(inst.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("首次创建会话失败时保留输入草稿以便重试", async () => {
    const inst = await enterIntranet();
    inst.createSession.mockRejectedValueOnce(new Error("创建失败"));
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "请分析这个项目" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(screen.getByTestId("composer-submit-notice")).toHaveTextContent("创建状态未知"));
    expect(screen.getByTestId("composer-input")).toHaveValue("请分析这个项目");
    expect(screen.getByTestId("project-select")).toBeInTheDocument();
  });

  it("创建响应未知时仅使用原 createRequestId 核对，不创建第二个会话", async () => {
    const inst = await enterIntranet();
    inst.createSession.mockRejectedValueOnce(new Error("响应丢失"));
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "保留本次消息" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(screen.getByTestId("confirm-creation")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("confirm-creation"));
    await waitFor(() => expect(inst.createSession).toHaveBeenCalledTimes(2));
    expect(inst.createSession.mock.calls[0]?.[2]).toBe(inst.createSession.mock.calls[1]?.[2]);
    await waitFor(() => expect(inst.sendMessage).toHaveBeenCalledTimes(1));
  });

  it("点击新建仅进入页面起始态，不提前创建服务器会话", async () => {
    const inst = await enterIntranet();
    fireEvent.click(screen.getByTestId("session-s1"));
    fireEvent.click(screen.getByTestId("new-session"));
    expect(screen.getByTestId("no-session-hint")).toBeInTheDocument();
    expect(inst.createSession).not.toHaveBeenCalled();
  });

  it("首次发送附件后新建会话不会复现已提交的页面起始态附件", async () => {
    mocks.setSessions([]);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("new-session")).toBeEnabled());
    const inst = mocks.instances.at(-1)!;
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("composer-file-input"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId("composer-attachment")).toHaveAttribute("data-state", "ready"));
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(inst.sendMessage).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("new-session"));
    expect(screen.queryByTestId("composer-attachments")).not.toBeInTheDocument();
  });

  it("非图片文件上传就绪后才可显式发送 fileIds；移除只解除引用", async () => {
    const inst = await enterChat();
    let finishUpload: (value: unknown) => void = () => {};
    inst.uploadFile.mockImplementationOnce(() => new Promise((resolve) => { finishUpload = resolve; }));
    const first = new File(["plain content"], "memo.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("composer-file-input"), { target: { files: [first] } });
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "查看文件" } });
    await waitFor(() => expect(inst.uploadFile).toHaveBeenCalledWith(expect.objectContaining({ name: "memo.txt", kind: "text" })));
    expect(screen.getByTestId("send-button")).toBeDisabled();
    finishUpload({ fileId: "00000000-0000-4000-8000-000000000091", name: "memo.txt", mediaType: "text/plain",
      size: 13, status: "ready", agentPath: "/server/private/memo" });
    await waitFor(() => expect(screen.getByTestId("send-button")).toBeEnabled());
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(inst.sendMessage).toHaveBeenCalledWith("s1", expect.objectContaining({
      prompt: "查看文件", fileIds: ["00000000-0000-4000-8000-000000000091"],
    })));
    expect(JSON.stringify(inst.sendMessage.mock.calls)).not.toContain("/server/private/memo");
    const second = new File(["other"], "other.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("composer-file-input"), { target: { files: [second] } });
    await waitFor(() => expect(inst.uploadFile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("composer-attachment")).toHaveAttribute("data-state", "ready"));
    fireEvent.click(screen.getByRole("button", { name: "移除附件 other.txt" }));
    expect(screen.queryByTestId("composer-attachments")).not.toBeInTheDocument();
    expect(inst.uploadFile).toHaveBeenCalledTimes(2);
  });

  it("文件-only 消息在附件就绪后允许显式发送，失败快照不覆盖后续输入", async () => {
    const inst = await enterChat();
    inst.sendMessage.mockRejectedValueOnce(new mocks.MockApiError(429, "队列满"));
    const file = new File(["text"], "info.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("composer-file-input"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId("send-button")).toBeEnabled());
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(screen.getByTestId("composer-submit-notice")).toHaveTextContent("队列满"));
    const first = inst.sendMessage.mock.calls[0] as unknown as [string, { requestId: string; prompt: string; fileIds: string[] }];
    expect(first[1].prompt).toBe("");
    expect(first[1].fileIds).toHaveLength(1);
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "我继续编辑的新内容" } });
    fireEvent.click(screen.getByTestId("retry-submission"));
    await waitFor(() => expect(inst.sendMessage).toHaveBeenCalledTimes(2));
    const retry = inst.sendMessage.mock.calls[1] as unknown as [string, { requestId: string; prompt: string; fileIds: string[] }];
    expect(retry[1]).toEqual(first[1]);
    expect(screen.getByTestId("composer-input")).toHaveValue("我继续编辑的新内容");
  });

  it("仅图片粘贴预览走 images/base64，不经过文件上传接口", async () => {
    const inst = await enterChat();
    const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "small.png", { type: "image/png" });
    fireEvent.paste(screen.getByTestId("composer-input"), { clipboardData: { files: [png] } });
    await waitFor(() => expect(screen.getByTestId("composer-attachments").querySelector(".composer-attachment-preview")).toBeInTheDocument());
    expect(inst.uploadFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(inst.sendMessage).toHaveBeenCalledWith("s1", expect.objectContaining({
      prompt: "", images: [expect.objectContaining({ mediaType: "image/png", base64: expect.any(String) })],
    })));
  });

  it("上传期间重复点击不会二次提交，同一页继续编辑与失败快照隔离", async () => {
    const inst = await enterChat();
    let accept: () => void = () => {};
    inst.sendMessage.mockImplementationOnce(() => new Promise<void>((resolve) => { accept = resolve; }));
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "第一次" } });
    fireEvent.click(screen.getByTestId("send-button"));
    fireEvent.keyDown(screen.getByTestId("composer-input"), { key: "Enter" });
    expect(inst.sendMessage).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "第二次编辑" } });
    accept();
    await waitFor(() => expect(screen.getByTestId("composer-input")).toHaveValue("第二次编辑"));
  });

  it("切换项目时未发送附件按项目隔离，返回原项目仍在当前页内存", async () => {
    mocks.setProjects([
      { id: mocks.DEFAULT_PROJECT_ID, name: "默认项目", cwd: "/tmp/default", isDefault: true },
      { id: "p1", name: "其他项目", cwd: "/tmp/other", isDefault: false },
    ]);
    await enterIntranet();
    fireEvent.change(screen.getByTestId("composer-file-input"), { target: { files: [new File(["data"], "notes.txt", { type: "text/plain" })] } });
    await waitFor(() => expect(screen.getByTestId("composer-attachment")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("project-select"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "其他项目" }));
    await waitFor(() => expect(screen.queryByTestId("composer-attachment")).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId("project-select"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "默认项目" }));
    await waitFor(() => expect(screen.getByTestId("composer-attachment")).toHaveTextContent("notes.txt"));
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

  it("preserves the session sidebar and parent draft while opening complete child history, then restores selection", async () => {
    const inst = await enterIntranet();
    const run = { id: "child-uuid", runId: "1", agent: "worker", task: "检查任务", startedAt: 1, endedAt: 2, status: "completed" as const, revision: 10 };
    inst.getSubagents.mockImplementation(async (sessionId: string, runId?: string) => ({ sessionId, runs: [run], ...(runId ? { conversation: {
      run, messages: [], inputs: [], timeline: [
        { kind: "message" as const, id: "u", role: "user" as const, text: "完整 steer 内容", streaming: false, hostInput: "steer" as const, sourceLabel: "主代理 · steer · 已送达" },
        { kind: "message" as const, id: "a", role: "assistant" as const, text: "子代理完整回复", streaming: false },
        { kind: "tool" as const, id: "t", call: { toolCallId: "t", toolName: "bash", args: { command: "echo proof" }, partialResult: null, result: { content: [{ type: "text", text: "工具结果末行" }] }, done: true, isError: false } },
      ],
    } } : {}) }));
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(inst.getSubagents).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "保留主会话草稿" } });
    fireEvent.click(screen.getByTestId("trace-tab"));
    fireEvent.click(screen.getByRole("tab", { name: /子代理/ }));
    fireEvent.click(await screen.findByRole("button", { name: /worker #1/ }));
    const child = await screen.findByTestId("subagent-chat");
    await waitFor(() => expect(within(child).getByText("完整 steer 内容")).toBeVisible());
    // The host's turn is tagged 主代理 with its kind in the gutter; delivery is implied by being in the transcript.
    const hostTurn = within(child).getByText("完整 steer 内容").closest(".ledger-entry")!;
    expect(hostTurn.querySelector(".ledger-tag")).toHaveTextContent("主代理");
    expect(hostTurn.querySelector(".ledger-note")).toHaveTextContent("引导");
    expect(within(child).queryByText(/已送达/)).toBeNull();
    expect(within(child).getByText("子代理完整回复")).toBeVisible();
    // Finished child history keeps its steps inside a collapsed work block.
    fireEvent.click(within(child).getByRole("button", { name: /展开工作块/ }));
    fireEvent.click(within(child).getByRole("button", { name: /工具调用/ }));
    expect(child.querySelector(".tool-call-body")).toHaveTextContent("工具结果末行");
    expect(screen.getByTestId("sidebar")).toBeVisible();
    expect(screen.getByTestId("session-s2")).toBeVisible();
    expect(screen.getByTestId("composer-input")).not.toBeVisible();
    expect(JSON.parse(sessionStorage.getItem("pi:selected-subagent")!)).toEqual({ sessionId: "s1", runId: run.id });
    fireEvent.click(within(child).getByRole("button", { name: "← 返回主会话" }));
    expect(screen.getByTestId("composer-input")).toBeVisible();
    expect(screen.getByTestId("composer-input")).toHaveValue("保留主会话草稿");
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

  it.each([false, true])("restores actual exported tool durations (orphan result: %s), preserves title precision and live merge", async orphan => {
    const inst = await enterIntranet();
    const values = [2345.6789, 0, null, undefined, -1, Infinity, NaN];
    inst.exportSession.mockResolvedValue({ messages: [], lastEventId: 7,
      timeline: values.flatMap((durationMs, i) => [
        ...(!orphan ? [{ type: "tool_call", id: `call-${i}`, toolCallId: `duration-${i}`, toolName: "fixture", args: {} }] : []),
        { type: "tool_result", id: `result-${i}`, toolCallId: `duration-${i}`, toolName: "fixture", result: {}, durationMs },
      ]) });
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(document.querySelector('[data-tool-call-id="duration-0"] .tool-duration')).toHaveTextContent("2.3s"));
    expect(document.querySelector('[data-tool-call-id="duration-1"] .tool-duration')).toHaveTextContent("0ms");
    for (let i = 2; i < values.length; i++) expect(document.querySelector(`[data-tool-call-id="duration-${i}"] .tool-duration`)).toBeNull();
    act(() => mocks.sse.onEvent?.({ type: "tool_end", toolCallId: "duration-0", toolName: "fixture", result: {}, isError: false }, 8));
    expect(document.querySelector('[data-tool-call-id="duration-0"] .tool-duration')).toHaveTextContent("2.3s");
    const card = document.querySelector('[data-tool-call-id="duration-0"]') as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /工具调用/ }));
    expect(card.querySelector('.tool-duration')).toHaveAttribute('title', '工具调用耗时：2345.6789 ms');
    expect(card.querySelector('.tool-call-body')).not.toBeNull();
  });

  it("thinking 从导出快照恢复，切换会话再返回仍可展开读取原文", async () => {
    const inst = await enterIntranet();
    const rawThinking = "先检查持久化 JSONL。\n再核对 block 顺序与工具关联。";
    inst.exportSession.mockImplementation(async (id: string) => id === "s1" ? ({
      messages: [
        { role: "user", sourceId: "u1", text: "请检查" },
        { role: "assistant", sourceId: "a1", text: "已检查" },
      ],
      timeline: [
        { id: "message:u1", type: "message", role: "user", messageId: "u1", turnId: "u1", text: "请检查", order: 0 },
        { id: "thinking:a1:0", type: "thinking", messageId: "a1", turnId: "u1", text: rawThinking, order: 1 },
        { id: "assistant-text:a1:1", type: "message", role: "assistant", messageId: "a1", turnId: "u1", text: "已检查", order: 2 },
      ],
      lastEventId: 7,
    }) : ({ messages: [], timeline: [], lastEventId: 0 }));

    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(screen.getByTestId("thinking-history-thinking:a1:0")).toBeInTheDocument());
    expect(screen.getByText("请检查")).toBeInTheDocument();
    expect(screen.getByText("已检查")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /思考过程/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByTestId("thinking-body-history-thinking:a1:0").textContent).toBe(rawThinking);

    fireEvent.click(screen.getByTestId("session-s2"));
    await waitFor(() => expect(screen.queryByTestId("thinking-history-thinking:a1:0")).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(screen.getByTestId("thinking-history-thinking:a1:0")).toBeInTheDocument());
    const restoredToggle = screen.getByRole("button", { name: /思考过程/ });
    expect(restoredToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(restoredToggle);
    expect(screen.getByTestId("thinking-body-history-thinking:a1:0").textContent).toBe(rawThinking);
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
    mocks.sse.onEvent?.({ type: "text_delta", text: "切回后仍在的回答" }, 12);
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
    expect(mocks.createSseConnection.mock.calls[2]![0]).toMatchObject({ lastEventId: 12 });
  });

  it("网络发送结果未知时不自动重试，保留未发送内容", async () => {
    const inst = await enterChat();
    inst.sendMessage
      .mockRejectedValueOnce(new Error("网络暂时不可用"))
      .mockResolvedValueOnce(undefined);
    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "重试这条消息" },
    });
    fireEvent.click(screen.getByTestId("send-button"));

    await waitFor(() => expect(screen.getByTestId("composer-submit-notice")).toHaveTextContent("结果未知"));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(inst.sendMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("composer-input")).toHaveValue("重试这条消息");
  });

  it("发送请求失败时回滚仍处于排队状态的用户消息", async () => {
    const inst = await enterChat();
    inst.sendMessage.mockRejectedValueOnce(new mocks.MockApiError(400, "请求无效"));
    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "这条失败消息应回滚" },
    });
    fireEvent.click(screen.getByTestId("send-button"));

    await waitFor(() => expect(screen.queryByTestId("phase-queued")).not.toBeInTheDocument());
    expect(screen.queryByTestId("message-list")?.textContent ?? "").not.toContain("这条失败消息应回滚");
    expect(screen.getByTestId("composer-input")).toHaveValue("这条失败消息应回滚");
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

  it("SSE 204 no-live-stream 后会话仍可用，界面不显示连接状态", async () => {
    await enterChat();
    mocks.sse.onOpen?.();
    mocks.sse.onNoLiveStream?.();
    expect(screen.getByTestId("chat-header")).toBeInTheDocument();
    expect(screen.queryByTestId("connection-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stat-conn")).not.toBeInTheDocument();
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

  const png = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGP4n2ZMU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAIAlYFtUlL3ZAAAAAElFTkSuQmCC";
  async function selectImages(count: number) {
    const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
    fireEvent.change(screen.getByTestId("composer-file-input"), { target: { files:
      Array.from({ length: count }, (_, i) => new File([bytes], `generated-${i}.png`, { type: "image/png" })) } });
    await waitFor(() => expect(screen.getAllByTestId("composer-attachment")).toHaveLength(count));
    await waitFor(() => expect(screen.getByTestId("send-button")).not.toBeDisabled());
  }

  it.each([1, 2])("accepted retains %i sent images after clearing the composer and switching sessions", async (count) => {
    const inst = await enterChat();
    await selectImages(count);
    if (count === 2) fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "文字和图片" } });
    let accept!: (value: unknown) => void;
    inst.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    fireEvent.click(screen.getByTestId("send-button"));
    expect(screen.queryByAltText("已发送图片 1")).not.toBeInTheDocument();
    accept(undefined);
    await waitFor(() => expect(screen.queryByTestId("composer-attachments")).not.toBeInTheDocument());
    expect(inst.sendMessage).toHaveBeenCalledWith("s1", expect.objectContaining({
      prompt: count === 2 ? "文字和图片" : "", images: Array.from({ length: count }, () => ({ mediaType: "image/png", base64: png })),
    }));
    expect(screen.getByAltText("已发送图片 1")).toHaveAttribute("src", `data:image/png;base64,${png}`);
    fireEvent.click(screen.getByTestId("session-s2"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(screen.getByAltText("已发送图片 1")).toBeInTheDocument());
  });

  it.each([400, 500])("image rejection/unknown (%i) retains snapshot without displaying sent images", async (status) => {
    const inst = await enterChat();
    await selectImages(2);
    inst.sendMessage.mockRejectedValueOnce(new mocks.MockApiError(status, "fixture rejection"));
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(screen.getByTestId("composer-submit-notice")).toBeInTheDocument());
    expect(screen.getAllByTestId("composer-attachment")).toHaveLength(2);
    expect(screen.queryByAltText("已发送图片 1")).not.toBeInTheDocument();
    if (status === 500) {
      const payload = inst.sendMessage.mock.calls[0]![1] as { requestId: string };
      mocks.sse.onEvent?.({ type: "queued", position: 1, requestId: payload.requestId });
      await waitFor(() => expect(screen.getByAltText("已发送图片 1")).toBeInTheDocument());
      expect(screen.queryByTestId("composer-attachments")).not.toBeInTheDocument();
    } else {
      fireEvent.click(screen.getByTestId("retry-submission"));
      await waitFor(() => expect(screen.getByAltText("已发送图片 1")).toBeInTheDocument());
      expect(inst.sendMessage.mock.calls[1]).toEqual(inst.sendMessage.mock.calls[0]);
    }
  });

  it("deferred image rejection closes its original owner after switching away", async () => {
    const inst = await enterChat();
    await selectImages(1);
    let reject!: (error: Error) => void;
    inst.sendMessage.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(inst.sendMessage).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("session-s2"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(2));
    await act(async () => reject(new mocks.MockApiError(400, "image rejected")));
    expect(screen.queryByText("image rejected")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(3));
    expect(screen.queryByTestId("phase-queued")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("composer-attachment")).toHaveLength(1);
    expect(screen.queryByAltText("已发送图片 1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("retry-submission"));
    await waitFor(() => expect(screen.getByAltText("已发送图片 1")).toBeInTheDocument());
    expect(inst.sendMessage.mock.calls[1]).toEqual(inst.sendMessage.mock.calls[0]);
  });

  it("resumes cached lifecycle cursor across an export race so host B follows completed A exactly once", async () => {
    const inst = await enterIntranet();
    const history = Array.from({ length: 120 }, (_, i) => ({ role: "user", text: `history row ${i}` }));
    inst.exportSession.mockResolvedValueOnce({ messages: history, lastEventId: 120 });
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(1));
    expect(mocks.createSseConnection.mock.calls[0]![0]).toMatchObject({ lastEventId: 120 });
    act(() => {
      mocks.sse.onEvent?.({ type: "status", phase: "agent_start", requestId: "A" }, 121);
      mocks.sse.onEvent?.({ type: "text_delta", text: "answer A", requestId: "A" }, 122);
    });
    fireEvent.click(screen.getByTestId("session-s2"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(2));
    let finish!: (data: unknown) => void;
    inst.exportSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(inst.exportSession).toHaveBeenCalledTimes(3));
    await act(async () => finish({ messages: [...history, { role: "assistant", text: "answer A" }, { role: "assistant", text: "answer B" }], lastEventId: 126 }));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(3));
    expect(mocks.createSseConnection.mock.calls[2]![0]).toMatchObject({ lastEventId: 122 });
    act(() => {
      mocks.sse.onEvent?.({ type: "completed", requestId: "A" }, 123);
      mocks.sse.onEvent?.({ type: "status", phase: "agent_start", requestId: "B" }, 124);
      mocks.sse.onEvent?.({ type: "text_delta", text: "answer B", requestId: "B" }, 125);
      // A's delayed terminal cannot end B.
      mocks.sse.onEvent?.({ type: "completed", requestId: "A" }, 126);
    });
    expect(screen.getByTestId("abort-button")).toHaveAttribute("title", "中止（连按两次 Esc）");
    expect(screen.getAllByText("answer A")).toHaveLength(1);
    expect(screen.getAllByText("answer B")).toHaveLength(1);
    expect(screen.getAllByText("history row 119")).toHaveLength(1);
    act(() => mocks.sse.onEvent?.({ type: "completed", requestId: "B" }, 127));
    expect(screen.getByTestId("send-button")).toHaveAttribute("title", "发送");
    expect(screen.queryByTestId("abort-button")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("session-s2"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(4));
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(5));
    expect(mocks.createSseConnection.mock.calls[4]![0]).toMatchObject({ lastEventId: 127 });
    expect(screen.getAllByText("answer B")).toHaveLength(1);
  });

  it("restores existing export images by sourceId without text matching or timeline duplication", async () => {
    const inst = await enterIntranet();
    inst.exportSession.mockResolvedValue({ messages: [{ role: "user", text: "", sourceId: "jsonl-user", images: [{ mediaType: "image/png", base64: png }] }],
      timeline: [{ type: "message", id: "message:jsonl-user", messageId: "jsonl-user", role: "user", text: "" }] });
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(screen.getByAltText("已发送图片 1")).toHaveAttribute("src", `data:image/png;base64,${png}`));
  });

  it("Escape abort keeps running compaction until actual aborted terminal", async () => {
    const inst = await enterChat();
    act(() => { mocks.sse.onOpen?.(); mocks.sse.onEvent?.({ type: "compaction_start", reason: "threshold", requestId: "r1" }); });
    expect(screen.getByTestId("compaction-banner")).toHaveAttribute("data-status", "running");
    expect(screen.getByTestId("abort-button")).toBeEnabled();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(inst.abort).toHaveBeenCalledWith("s1"));
    expect(screen.getByTestId("compaction-banner")).toHaveAttribute("data-status", "running");
    act(() => mocks.sse.onEvent?.({ type: "aborted", requestId: "r1" }));
    expect(screen.getByTestId("compaction-banner")).toHaveAttribute("data-status", "aborted");
  });

  it.each(["onError", "onDisconnect", "onNoLiveStream"] as const)("%s marks compaction unknown even after reconnect and terminal", async callback => {
    await enterChat();
    act(() => { mocks.sse.onOpen?.(); mocks.sse.onEvent?.({ type: "compaction_start", reason: "threshold", requestId: "r1" }); });
    expect(screen.getByTestId("compaction-banner")).toHaveAttribute("data-status", "running");
    act(() => mocks.sse[callback]?.());
    expect(screen.getByTestId("compaction-banner")).toHaveAttribute("data-status", "unknown");
    act(() => { mocks.sse.onOpen?.(); mocks.sse.onEvent?.({ type: "aborted", requestId: "r1" }); });
    expect(screen.getByTestId("compaction-banner")).toHaveAttribute("data-status", "unknown");
  });

  it("switching connections marks running compaction unknown", async () => {
    await enterChat();
    act(() => { mocks.sse.onOpen?.(); mocks.sse.onEvent?.({ type: "compaction_start", reason: "threshold", requestId: "r1" }); });
    fireEvent.click(screen.getByTestId("session-s2"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(mocks.createSseConnection).toHaveBeenCalledTimes(3));
    act(() => mocks.sse.onOpen?.());
    expect(screen.getByTestId("compaction-banner")).toHaveAttribute("data-status", "unknown");
  });

  it("工具运行阶段显示中止按钮并调用 API", async () => {
    const inst = await enterChat();

    act(() => mocks.sse.onEvent?.({ type: "tool_start", toolCallId: "t1", toolName: "search", args: {} }));
    fireEvent.click(screen.getByTestId("abort-button"));
    await waitFor(() => expect(inst.abort).toHaveBeenCalledWith("s1"));
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

    fireEvent.contextMenu(screen.getByTestId("session-s1"));
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

  it("Web UI 不暴露项目删除入口且不触发 deleteProject 请求，额外项目仅支持选择与切换", async () => {
    mocks.setProjects([
      { id: mocks.DEFAULT_PROJECT_ID, name: "默认项目", cwd: "/tmp/default", isDefault: true },
      { id: "p1", name: "我的仓库", cwd: "/path/a", isDefault: false },
    ]);
    const inst = await enterIntranet();

    // 切到额外项目
    fireEvent.click(screen.getByTestId("project-select"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "我的仓库" }));
    await waitFor(() => expect(inst.listSessionsByProject).toHaveBeenCalledWith("p1"));

    // 额外项目下拉菜单中不暴露删除项目入口，不触发 deleteProject
    fireEvent.click(screen.getByTestId("project-select"));
    expect(screen.queryByTestId("delete-project")).not.toBeInTheDocument();
    expect(screen.queryByText("删除项目")).not.toBeInTheDocument();
    expect(inst.deleteProject).not.toHaveBeenCalled();

    // 切回默认项目
    fireEvent.click(screen.getByRole("menuitemradio", { name: "默认项目" }));
    await waitFor(() => {
      expect(screen.getByTestId("project-select")).toHaveAttribute("data-value", mocks.DEFAULT_PROJECT_ID);
    });
    expect(inst.listSessionsByProject).toHaveBeenLastCalledWith(mocks.DEFAULT_PROJECT_ID);
    expect(inst.deleteProject).not.toHaveBeenCalled();
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

  it("项目列表为空时仍能向默认 target 发送首条消息", async () => {
    mocks.setProjects([]);
    render(<App />);
    await waitFor(() => expect(mocks.instances.at(-1)!.listSessionsByProject).toHaveBeenCalledWith(DEFAULT_PROJECT_ID));
    expect(screen.queryByTestId("projects-error")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "first default" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(mocks.instances.at(-1)!.createSession).toHaveBeenCalledWith(undefined, DEFAULT_PROJECT_ID, expect.any(String)));
  });

  it("空默认项目被过滤时仍可选择首个有会话项目", async () => {
    mocks.setProjects([{ id: "pa", name: "项目A", cwd: "/path/a", isDefault: false }]);
    render(<App />);

    await waitFor(() => expect(mocks.instances.at(-1)!.listSessionsByProject).toHaveBeenCalledWith("pa"));
    expect(screen.queryByTestId("projects-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("new-session")).toBeInTheDocument();
  });

  it("窄屏侧栏与审查器均可通过真实控件和 Escape 关闭", async () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
    try {
      await enterChat();
      fireEvent.click(screen.getByRole("button", { name: "打开工作区导航" }));
      expect(screen.getByTestId("app")).toHaveClass("mobile-sidebar-open");
      fireEvent.click(screen.getByTestId("project-select"));
      fireEvent.keyDown(screen.getByRole("menu", { name: "选择项目" }), { key: "Escape" });
      expect(screen.getByTestId("app")).toHaveClass("mobile-sidebar-open");
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.getByTestId("app")).not.toHaveClass("mobile-sidebar-open");

      fireEvent.click(screen.getByTestId("trace-tab"));
      expect(screen.getByTestId("inspector")).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("inspector-close"));
      expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
    }
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
    fireEvent.click(screen.getByTestId("project-select"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "仓库一" }));
    await waitFor(() => expect(inst.listSessionsByProject).toHaveBeenLastCalledWith("p1"));

    // 快速切回默认项目：该请求立即成功（展示会话一/会话二）
    fireEvent.click(screen.getByTestId("project-select"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "默认项目" }));
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

describe("会话显示标题兜底", () => {
  async function blankChat() {
    mocks.setSessions([{ ...sessions[0]!, title: "" }, sessions[1]!]);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("session-s1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(screen.getByTestId("composer-input")).toBeEnabled());
    return mocks.instances.at(-1)!;
  }
  function send(text: string) {
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: text } });
    fireEvent.click(screen.getByTestId("send-button"));
  }
  function expectTitle(text: string) {
    expect(screen.getByTestId("chat-session-title")).toHaveTextContent(text.replace(/\s+/g, " "));
    expect(screen.getByTestId("chat-session-title")).toHaveAttribute("title", text);
    expect(screen.getByTestId("session-s1").querySelector(".session-title")).toHaveAttribute("title", text);
  }
  it("accepted first prompt is full, stable across later messages/reselect and not persisted as title", async () => {
    const api = await blankChat();
    const first = `首条多行\n${"长提示词".repeat(100)}`;
    send(first);
    await waitFor(() => expectTitle(first));
    act(() => mocks.sse.onEvent?.({ type: "completed" }));
    send("后续消息不改标题");
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
    expectTitle(first);
    fireEvent.click(screen.getByTestId("session-s2"));
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expectTitle(first));
    expect(api.renameSession).not.toHaveBeenCalled();
  });
  it("new session gets fallback only after acceptance without sending a create title", async () => {
    mocks.setSessions([]); render(<App />);
    await waitFor(() => expect(screen.getByTestId("new-session")).toBeEnabled());
    const api = mocks.instances.at(-1)!;
    let accept: (value: unknown) => void = () => {};
    api.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    send("新会话第一条提示词");
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    expect(screen.getByTestId("chat-session-title")).toHaveTextContent("未命名会话");
    expect(api.createSession).toHaveBeenCalledWith(undefined, mocks.DEFAULT_PROJECT_ID, expect.any(String));
    await act(async () => { accept(undefined); });
    expect(screen.getByTestId("chat-session-title")).toHaveAttribute("title", "新会话第一条提示词");
    expect(screen.getByTestId("session-new-session").querySelector(".session-title")).toHaveAttribute("title", "新会话第一条提示词");
    expect(api.renameSession).not.toHaveBeenCalled();
  });
  it.each([400, 500])("failed/unknown (%s) does not invent a title; confirmed unknown may fallback", async (status) => {
    const api = await blankChat();
    api.sendMessage.mockRejectedValueOnce(new mocks.MockApiError(status, "未确认"));
    send("不能预先命名");
    await waitFor(() => expect(screen.getByTestId("composer-submit-notice")).toBeInTheDocument());
    expectTitle("未命名会话");
    if (status === 500) {
      const request = api.sendMessage.mock.calls[0]![1] as { requestId: string };
      act(() => mocks.sse.onEvent?.({ type: "queued", position: 1, requestId: request.requestId }));
      await waitFor(() => expectTitle("不能预先命名"));
    }
  });
  it("old-project deferred rename cannot invalidate the new-project pending list", async () => {
    mocks.setProjects([
      { id: mocks.DEFAULT_PROJECT_ID, name: "默认项目", cwd: "/tmp/default", isDefault: true },
      { id: "p1", name: "仓库一", cwd: "/tmp/p1", isDefault: false },
    ]);
    const api = await blankChat();
    let finishRename!: (row: SessionRecord) => void;
    api.renameSession.mockImplementationOnce(() => new Promise<SessionRecord>((resolve) => { finishRename = resolve; }));
    fireEvent.contextMenu(screen.getByTestId("session-s1"));
    fireEvent.click(screen.getByTestId("rename-s1"));
    fireEvent.change(screen.getByTestId("rename-input"), { target: { value: "旧项目标题" } });
    fireEvent.click(screen.getByTestId("rename-save"));
    await waitFor(() => expect(api.renameSession).toHaveBeenCalled());
    mocks.deferSessionsFor("p1");
    fireEvent.click(screen.getByTestId("project-select"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "仓库一" }));
    await waitFor(() => expect(api.listSessionsByProject).toHaveBeenLastCalledWith("p1"));
    await act(async () => { finishRename({ ...sessions[0]!, title: "旧项目标题" }); });
    await act(async () => { mocks.releaseDeferredSessions("p1", [{ ...sessions[0]!, id: "p1-session", projectId: "p1", title: "新项目会话" }]); });
    await waitFor(() => expect(screen.getByTestId("session-p1-session")).toBeInTheDocument());
    expect(screen.queryByTestId("session-s1")).not.toBeInTheDocument();
  });

  it("failed history then accepted send stays unknown; reselect trusts server DTO first prompt", async () => {
    mocks.setProjects([
      { id: mocks.DEFAULT_PROJECT_ID, name: "默认项目", cwd: "/tmp/default", isDefault: true },
      { id: "p1", name: "仓库一", cwd: "/tmp/p1", isDefault: false },
    ]);
    mocks.setSessions([{ ...sessions[0]!, title: "", firstPrompt: null }, sessions[1]!]);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("session-s1")).toBeInTheDocument());
    const api = mocks.instances.at(-1)!;
    api.exportSession.mockRejectedValueOnce(new Error("history unavailable"));
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(screen.getByTestId("composer-input")).toBeEnabled());
    send("accepted but not first");
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    expectTitle("未命名会话");
    mocks.setSessions([{ ...sessions[0]!, title: "", firstPrompt: "可信的历史第一条" }, sessions[1]!]);
    fireEvent.click(screen.getByTestId("project-select"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "仓库一" }));
    await waitFor(() => expect(api.listSessionsByProject).toHaveBeenLastCalledWith("p1"));
    fireEvent.click(screen.getByTestId("project-select"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "默认项目" }));
    await waitFor(() => expect(screen.getByTestId("session-s1").querySelector(".session-title")).toHaveAttribute("title", "可信的历史第一条"));
    api.exportSession.mockRejectedValueOnce(new Error("still unavailable"));
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expectTitle("可信的历史第一条"));
  });

  it("explicit title wins over a late message acceptance", async () => {
    const api = await blankChat();
    let accept: (value: unknown) => void = () => {};
    api.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    send("首条提示词");
    api.renameSession.mockResolvedValueOnce({ ...sessions[0]!, title: "未命名会话" });
    fireEvent.contextMenu(screen.getByTestId("session-s1"));
    fireEvent.click(screen.getByTestId("rename-s1"));
    fireEvent.change(screen.getByTestId("rename-input"), { target: { value: "未命名会话" } });
    fireEvent.click(screen.getByTestId("rename-save"));
    await waitFor(() => expect(api.renameSession).toHaveBeenCalled());
    await act(async () => { accept(undefined); });
    expectTitle("未命名会话");
  });
});


describe("rich usage export hydration", () => {
  const tokens = { input: 0, output: 20, cacheRead: 100, cacheWrite: 0, totalTokens: 120, costUsdEstimate: 0 };
  const usageSnapshot = { lastResponse: { ...tokens, ordinal: 1, cacheHitPercent: 100,
    speed: { outputTokens: 20, generationDurationMs: 100, tokensPerSecond: 200 } },
    sessionTotals: { ...tokens, scope: "allEntries" },
    context: { tokens: 120, window: 10000, percent: 1.2, estimate: true } };
  it("restores export-only rich metrics and does not fabricate request timing", async () => {
    const api = await enterIntranet();
    api.exportSession.mockResolvedValue({ messages: [{ role: "user", text: "usage fixture" }], usageSnapshot });
    fireEvent.click(screen.getByTestId("session-s1"));
    fireEvent.click(await screen.findByRole("button", { name: "查看统计详情" }));
    await waitFor(() => expect(screen.getByTestId("stat-last-cache-hit")).toHaveTextContent("100%"));
    expect(screen.getByTestId("stat-last-breakdown")).toHaveTextContent("输入 0");
    expect(screen.getByTestId("stat-last-speed")).toHaveTextContent("200 tok/s");
    expect(screen.queryByTestId("stat-task-duration")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
    fireEvent.click(screen.getByTestId("session-s2"));
    api.exportSession.mockResolvedValue({ messages: [] });
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(api.exportSession).toHaveBeenCalledTimes(3));
    expect(screen.queryByTestId("stat-context-used")).toBeNull();
  });
  it("clears context immediately when changing model", async () => {
    const api = await enterIntranet();
    api.exportSession.mockResolvedValue({ messages: [{ role: "user", text: "usage fixture" }], usageSnapshot });
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(screen.getByTestId("stat-summary-context")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("model-thinking-trigger"));
    fireEvent.click(screen.getByRole("radio", { name: /DeepSeek V4 Pro/ }));
    await waitFor(() => expect(api.updateSessionConfig).toHaveBeenCalled());
    expect(screen.queryByTestId("stat-summary-context")).toBeNull();
  });
  it("ignores a delayed session A export after switching to B without runtime usage", async () => {
    const api = await enterIntranet();
    let finish!: (value: unknown) => void;
    api.exportSession.mockImplementation((id: string) => id === "s1" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ messages: [] }));
    fireEvent.click(screen.getByTestId("session-s1"));
    await waitFor(() => expect(api.exportSession).toHaveBeenCalledWith("s1"));
    fireEvent.click(screen.getByTestId("session-s2"));
    await waitFor(() => expect(api.exportSession).toHaveBeenCalledWith("s2"));
    await act(async () => { finish({ messages: [], usageSnapshot }); });
    expect(screen.queryByTestId("stat-context-tokens")).toBeNull();
    expect(screen.queryByTestId("stat-input")).toBeNull();
  });
});
