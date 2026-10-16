import { describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { Chat } from "./Chat.js";
import type { SessionRecord, TimelineItem } from "pi-agent-server/client";

const session: SessionRecord = {
  id: "s1",
  ownerKey: "k",
  projectId: "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c", // 服务端 DEFAULT_PROJECT_ID（默认项目）
  title: "测试会话",
  createdAt: 1000,
  updatedAt: 2000,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null, systemPrompt: null,
};

const timeline: TimelineItem[] = [
  { kind: "message", id: "u-0", role: "user", text: "帮我查天气", streaming: false },
  { kind: "message", id: "a-1", role: "assistant", text: "好的", streaming: false },
  {
    kind: "tool",
    id: "t1",
    call: {
      toolCallId: "t1",
      toolName: "weather",
      args: { city: "beijing" },
      partialResult: "晴",
      result: undefined,
      isError: false,
      done: false,
    },
  },
];

function setup(partial: Partial<Parameters<typeof Chat>[0]> = {}) {
  const props = {
    session,
    projects: [
      { id: "p1", name: "我的仓库", cwd: "/workspace/repo", isDefault: false },
      { id: "p2", name: "示例项目", cwd: "/workspace/example", isDefault: false },
    ],
    activeProjectId: "p1",
    onSelectProject: vi.fn(),
    canCreateSession: true,
    timeline,
    streaming: false,
    queued: false,
    loadError: null,
    models: [],
    thinkingLevels: ["off", "low", "medium", "high"],
    defaultModel: null,
    defaultThinkingLevel: "medium",
    connection: "open" as const,
    stats: null,
    onSend: vi.fn(),
    onAddFile: vi.fn(async () => undefined),
    onFollowUp: vi.fn(),
    onConfigChange: vi.fn(),
    ...partial,
  };
  const view = render(<Chat {...props} />);
  return { ...props, update: (partial: Partial<Parameters<typeof Chat>[0]>) => {
    Object.assign(props, partial);
    view.rerender(<Chat {...props} />);
  } };
}

describe("Chat（聊天区）", () => {
  it("shows PI's waiting line only for what nothing else on screen says, until the first words arrive", () => {
    vi.useFakeTimers();
    try {
      const user: TimelineItem = { kind: "message", id: "new", role: "user", text: "new request", streaming: false };
      const view = setup({ timeline: [...timeline, user], streaming: true });
      const line = () => screen.getByTestId("waiting-reply");
      expect(line()).toHaveTextContent("等待模型回复");
      expect(line()).toHaveAttribute("role", "status");
      expect(line().querySelector(".ledger-caret")).not.toBeNull();
      // It opens the PI entry where the reply will appear, right after the user's entry.
      const entry = line().closest(".ledger-entry")!;
      expect(entry).toHaveAttribute("data-role", "assistant");
      expect(entry.previousElementSibling).toHaveAttribute("data-role", "user");
      act(() => vi.advanceTimersByTime(33000));
      expect(line()).toHaveTextContent("等待模型回复");
      // A running step already says what PI is doing.
      view.update({ activeTools: true });
      expect(screen.queryByTestId("waiting-reply")).toBeNull();
      view.update({ activeTools: false, connection: "reconnecting" });
      expect(line()).toHaveTextContent("连接中断，正在恢复…");
      expect(line()).toHaveClass("is-warn");
      view.update({ connection: "open", timeline: [...timeline, user,
        { kind: "message", id: "partial", role: "assistant", text: "half", streaming: true }] });
      expect(screen.queryByTestId("waiting-reply")).toBeNull();
      view.update({ streaming: false, timeline: [...timeline, user,
        { kind: "message", id: "partial", role: "assistant", text: "half", streaming: false, stopReason: "aborted" }] });
      expect(screen.getByTestId("aborted-partial")).toHaveTextContent("已中止");
      expect(screen.queryByTestId("waiting-reply")).toBeNull();
      view.update({ primaryAwaitingStart: false, queued: true });
      expect(screen.queryByTestId("waiting-reply")).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("a new session's first send shows only the caret while its stream is still connecting", () => {
    const user: TimelineItem = { kind: "message", id: "first", role: "user", text: "first", streaming: false };
    setup({ timeline: [user], primaryAwaitingStart: true, connection: "connecting" });
    const line = screen.getByTestId("waiting-reply");
    // The header carries "等待运行确认"; connecting is not a dropped connection.
    expect(line).toHaveTextContent("");
    expect(line).not.toHaveAttribute("role");
    expect(line.querySelector(".ledger-caret")).not.toBeNull();
    expect(screen.queryByText(/连接/)).toBeNull();
  });
  it("joins the live PI entry instead of opening a second one", () => {
    const user: TimelineItem = { kind: "message", id: "ask", role: "user", text: "ask", streaming: false };
    const tool: TimelineItem = { kind: "tool", id: "t1", call: { toolCallId: "t1", toolName: "bash", args: {}, done: true, isError: false } } as TimelineItem;
    setup({ timeline: [user, tool], streaming: true });
    expect(screen.getByTestId("waiting-reply").closest(".ledger-entry")).toHaveAttribute("data-role", "assistant");
    expect(document.querySelectorAll('.ledger-entry[data-role="assistant"]')).toHaveLength(1);
  });
  it("将右侧栏图标开关状态与点击传给父级，不维护虚假的本地页签", () => {
    const onToggleTrace = vi.fn();
    const view = setup({ traceOpen: false, onToggleTrace });
    const toggle = screen.getByRole('button', { name: '轨迹' });
    expect(screen.queryByTestId('chat-tab')).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(onToggleTrace).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    view.update({ traceOpen: true });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(onToggleTrace).toHaveBeenCalledTimes(2);
  });

  it("separates primary queue status from empty control synchronization", () => {
    const props = setup({ queued: true, controlQueueLoading: true, deleteControl: vi.fn(), promoteControl: vi.fn() });
    expect(screen.getByTestId("phase-queued")).toHaveTextContent("消息正在排队，等待运行");
    expect(screen.queryByTestId("control-queue")).toBeNull();
    props.update({ streaming: true, queued: false });
    expect(screen.queryByTestId("control-queue")).toBeNull();
    expect(screen.queryByText(/正在同步队列/)).toBeNull();
    props.update({ controlQueueError: "队列读取失败" });
    expect(screen.getByRole("alert")).toHaveTextContent("队列读取失败");
    expect(screen.queryByTestId("control-queue-item")).toBeNull();
    props.update({ queued: true, controlQueue: {requestId:"r", revision:1, items:[{id:"q", kind:"steer", text:"真实条目"}]} });
    expect(screen.getByTestId("control-queue-item")).toHaveTextContent("真实条目");
  });
  it("isolates success banner timers when switching sessions", () => {
    vi.useFakeTimers();
    try {
      const compaction = { status: "succeeded", reason: "manual" } as const;
      const props = setup({ compaction });
      act(() => vi.advanceTimersByTime(4000));
      props.update({ session: { ...session, id: "s2" } });
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByTestId("compaction-banner")).toBeVisible();
      act(() => vi.advanceTimersByTime(3999));
      expect(screen.getByTestId("compaction-banner")).toBeVisible();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByTestId("compaction-banner")).toBeNull();
      props.update({ session });
      expect(screen.getByTestId("compaction-banner")).toBeVisible();
      props.update({ compaction: null });
    } finally {
      vi.useRealTimers();
    }
  });

  function metrics() {
    const el = screen.getByTestId("chat-body");
    let height = 1000;
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 300 },
    });
    return { el, grow: () => { height += 200; } };
  }

  it("follows growth, preserves upward reading across updates, resumes at bottom or via SVG button", () => {
    const props = setup();
    const { el, grow } = metrics();
    props.update({ timeline: [...timeline] });
    // jsdom does not clamp scrollTop like a browser.
    el.scrollTop = 700; fireEvent.scroll(el);
    grow(); props.update({ timeline: [...timeline] });
    expect(el.scrollTop).toBe(1200);
    el.scrollTop = 900; fireEvent.scroll(el);
    el.scrollTop = 300; fireEvent.scroll(el);
    for (let i = 0; i < 3; i++) {
      grow(); props.update({ timeline: [...timeline] });
      expect(el.scrollTop).toBe(300);
    }
    const button = screen.getByRole("button", { name: "回到最新" });
    expect(button).toHaveAttribute("aria-label", "回到最新");
    expect(button).toHaveAttribute("title", "回到最新");
    // An icon-only control: the name lives in aria-label / title, the arrow is decorative.
    expect(button).toHaveTextContent("");
    expect(button.querySelector('svg[data-icon="down"]')).toHaveAttribute("aria-hidden", "true");
    expect(button).not.toHaveAttribute("data-live");
    // While PI is still writing below, it says so.
    props.update({ timeline: [...timeline], streaming: true });
    const live = screen.getByRole("button", { name: "回到最新（正在生成）" });
    expect(live).toHaveAttribute("data-live", "true");
    props.update({ timeline: [...timeline], streaming: false });
    const slot = button.parentElement;
    fireEvent.click(button);
    expect(el.scrollTop).toBe(1800);
    expect(screen.queryByRole("button", { name: "回到最新" })).not.toBeInTheDocument();
    expect(document.querySelector(".chat-latest-row")).toBe(slot);
    el.scrollTop = 1500; fireEvent.scroll(el);
    grow(); props.update({ timeline: [...timeline] });
    expect(el.scrollTop).toBe(2000);
    el.scrollTop = 1700; fireEvent.scroll(el);
    el.scrollTop = 200; fireEvent.scroll(el);
    el.scrollTop = 1680; fireEvent.scroll(el); // within 48px
    grow(); props.update({ timeline: [...timeline] });
    expect(el.scrollTop).toBe(2200);
  });

  it("only unmodified, non-composing Home/End on the body control following", () => {
    const props = setup();
    const { el, grow } = metrics();
    props.update({ timeline: [...timeline] });
    el.scrollTop = 700; fireEvent.scroll(el);
    el.scrollTop = 100; fireEvent.scroll(el);
    const input = screen.getByTestId("composer-input");
    const child = screen.getByRole("button", { name: /工具调用 weather/ });
    const descendants = [document.createElement("input"), document.createElement("textarea"), document.createElement("code"), document.createElement("div")];
    descendants[3]!.contentEditable = "true";
    for (const descendant of descendants) el.append(descendant);
    for (const key of ["Home", "End"]) {
      for (const target of [input, child, ...descendants]) {
        expect(fireEvent.keyDown(target, { key })).toBe(true);
        expect(el.scrollTop).toBe(100);
      }
      for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey", "isComposing"]) {
        expect(fireEvent.keyDown(el, { key, [modifier]: true })).toBe(true);
        expect(el.scrollTop).toBe(100);
      }
    }
    for (const descendant of descendants) descendant.remove();
    grow(); props.update({ timeline: [...timeline] });
    expect(el.scrollTop).toBe(100);
    expect(fireEvent.keyDown(el, { key: "End" })).toBe(false);
    expect(el.scrollTop).toBe(1200);
    for (let i = 0; i < 4; i++) {
      grow(); props.update({ timeline: [...timeline] });
      expect(el.scrollTop).toBe(1400 + i * 200);
    }
  });

  it("Home stops follow immediately across resize and growth; End/latest restore it", () => {
    let resize = () => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    try {
      const props = setup();
      const { el, grow } = metrics();
      props.update({ timeline: [...timeline] });
      for (const resume of ["End", "latest"]) {
        el.focus();
        expect(document.activeElement).toBe(el);
        expect(fireEvent.keyDown(el, { key: "Home" })).toBe(false);
        expect(el.scrollTop).toBe(0);
        // No scroll event first: resize must not race with the Home intent.
        act(() => resize());
        expect(el.scrollTop).toBe(0);
        grow(); props.update({ timeline: [...timeline] });
        act(() => resize());
        expect(el.scrollTop).toBe(0);
        if (resume === "End") expect(fireEvent.keyDown(el, { key: "End" })).toBe(false);
        else fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
        expect(el.scrollTop).toBe(el.scrollHeight);
        grow(); props.update({ timeline: [...timeline] });
        act(() => resize());
        expect(el.scrollTop).toBe(el.scrollHeight);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("waits for new-session history, initializes once, and does not follow manual disclosure", () => {
    const props = setup();
    const { el, grow } = metrics();
    props.update({ timeline: [...timeline] });
    el.scrollTop = 700; fireEvent.scroll(el);
    fireEvent.click(screen.getByRole("button", { name: /工具调用 weather/ }));
    grow(); props.update({ timeline: [...timeline] });
    expect(el.scrollTop).toBe(700);
    props.update({ session: { ...session, id: "s2" }, timeline: [], historyLoading: true });
    props.update({ historyLoading: false });
    el.scrollTop = 0;
    props.update({ timeline: [...timeline] });
    expect(el.scrollTop).toBe(1200);
    el.scrollTop = 900; fireEvent.scroll(el);
    el.scrollTop = 200; fireEvent.scroll(el);
    grow(); props.update({ timeline: [...timeline], session: { ...session, id: "s2" } });
    expect(el.scrollTop).toBe(200);
  });

  it("按时间线原顺序区分用户、助手和工具行（无来源槽标签）", () => {
    setup();
    expect(screen.getByText("帮我查天气")).toBeInTheDocument();
    expect(screen.getByText("好的")).toBeInTheDocument();
    expect(screen.getByTestId("tool-call-card")).toBeInTheDocument();
    expect(screen.getByTestId("tool-name")).toHaveTextContent("weather");
    // Ledger entries: YOU, then one PI entry holding the reply and its work block.
    const entries = screen.getByTestId("message-list").children;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveAttribute("data-role", "user");
    expect(entries[0].querySelector(".ledger-tag")).toHaveTextContent("YOU");
    expect(entries[0].querySelector(".timeline-entry")?.firstElementChild).toHaveClass("row-user");
    expect(entries[1]).toHaveAttribute("data-role", "assistant");
    expect(entries[1].querySelector(".ledger-tag")).toHaveTextContent("PI");
    const anchors = Array.from(document.querySelectorAll<HTMLElement>("[data-timeline-id]")).map(row => row.dataset.timelineKind);
    expect(anchors).toEqual(["user", "assistant_text", "tool_call"]);
    expect(entries[1].querySelector("[data-testid='work-block'] .tool-call")).toBe(screen.getByTestId("tool-call-card"));
    // Reading-first：旧 Crossband 固定来源槽及其标签已废除。
    expect(screen.queryByText("用户原文")).not.toBeInTheDocument();
    expect(screen.queryByText("模型正文")).not.toBeInTheDocument();
    expect(screen.queryByText("工具过程")).not.toBeInTheDocument();
    expect(document.querySelector(".band-source")).toBeNull();
  });

  it("空时间线显示空状态", () => {
    setup({ timeline: [] });
    expect(screen.getByTestId("chat-empty")).toBeInTheDocument();
  });

  it("历史加载中或首条消息发送中不显示空状态", () => {
    const props = setup({ timeline: [], historyLoading: true });
    expect(screen.queryByTestId("chat-empty")).not.toBeInTheDocument();
    props.update({ timeline: [], historyLoading: false, primaryAwaitingStart: true });
    expect(screen.queryByTestId("chat-empty")).not.toBeInTheDocument();
  });

  it("未选择会话由数字人迎接，快捷入口只来自项目里真实存在的命令", async () => {
    const loadCommands = vi.fn(async () => [
      { name: "compact", source: "builtin" as const, description: "压缩" },
      { name: "review", source: "prompt" as const, description: "Review a change" },
    ]);
    const onDraftText = vi.fn();
    setup({ session: null, loadCommands, onDraftText });
    const welcome = screen.getByTestId("no-session-hint");
    expect(welcome).toHaveTextContent("选择项目并发送第一条消息");
    expect(await within(welcome).findByText(/我的仓库/)).toBeInTheDocument();
    const chips = within(welcome).getByRole("group", { name: "快捷开始" });
    expect(within(chips).getAllByRole("button").map(button => button.textContent)).toEqual([expect.stringContaining("/review")]);
    fireEvent.click(within(chips).getByRole("button"));
    expect(onDraftText).toHaveBeenCalledWith("/review ");
  });

  it("没有可用命令时不显示快捷入口", async () => {
    setup({ session: null, loadCommands: async () => [] });
    await screen.findByText(/@/);
    expect(screen.queryByRole("group", { name: "快捷开始" })).not.toBeInTheDocument();
  });

  it("无会话时不重复侧栏项目选择并通过 onSend 提交创建消息", () => {
    const props = setup({ session: null, timeline: [] });
    expect(screen.queryByTestId("composer-project-select")).not.toBeInTheDocument();
    expect(screen.getByTestId("model-thinking-trigger")).toBeInTheDocument();
    expect(props.onSelectProject).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "创建前提问" } });
    fireEvent.click(screen.getByTestId("send-button"));
    expect(props.onSend).toHaveBeenCalledWith("创建前提问");
  });

  it("项目未加载时隐藏无会话 composer", () => {
    setup({ session: null, projects: null, canCreateSession: false });
    expect(screen.queryByTestId("composer")).not.toBeInTheDocument();
  });

  it("没有有效项目时禁用创建和项目选择", () => {
    setup({
      session: null,
      projects: [{ id: "p1", name: "我的仓库", cwd: "/workspace/repo", isDefault: false }],
      activeProjectId: null,
      canCreateSession: false,
    });
    expect(screen.queryByTestId("composer-project-select")).not.toBeInTheDocument();
    expect(screen.getByTestId("send-button")).toBeDisabled();
  });

  it("有会话时隐藏项目选择器", () => {
    setup();
    expect(screen.queryByTestId("composer-project-select")).not.toBeInTheDocument();
    expect(screen.queryByText("工作区内修改")).not.toBeInTheDocument();
  });

  it("发送按钮触发 onSend(text) 并清空输入框", () => {
    const { onSend } = setup();
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "再问一个问题" } });
    fireEvent.click(screen.getByTestId("send-button"));
    expect(onSend).toHaveBeenCalledWith("再问一个问题");
    expect(input).toHaveValue("");
  });

  it("Enter 发送、Shift+Enter 换行，输入法合成中不误发", () => {
    const { onSend } = setup();
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "输入中" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("会话未覆盖配置时显示实际默认模型与思考级别", () => {
    setup({
      defaultModel: { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" },
      defaultThinkingLevel: "medium",
    });
    expect(screen.getByTestId("model-thinking-trigger")).toHaveTextContent("gpt-5.5");
    expect(screen.getByTestId("model-thinking-trigger")).not.toHaveTextContent("openai-codex");
    expect(screen.getByTestId("thinking-trigger")).toHaveTextContent("medium");
    fireEvent.click(screen.getByTestId("model-thinking-trigger"));
    expect(screen.getByRole("radio", { name: "openai-codex/gpt-5.5 (GPT-5.5)" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "medium" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加附件" })).toBeEnabled();
  });

  it("模型和思考深度共用触发器且选择思考深度会真实更新配置", () => {
    const props = setup();
    expect(screen.getByTestId("model-thinking-trigger")).toBeVisible();
    fireEvent.click(screen.getByTestId("model-thinking-trigger"));
    fireEvent.click(screen.getByRole("radio", { name: "high" }));
    expect(props.onConfigChange).toHaveBeenCalledWith({ thinkingLevel: "high" });
    expect(screen.getByRole("dialog", { name: "模型与思考深度" })).toBeInTheDocument();
  });

  it("流式时没有独立停止按钮或空控制行，发送仍追加", () => {
    setup({ streaming: true });
    expect(screen.queryByRole("button", { name: /中止|停止/ })).not.toBeInTheDocument();
    expect(document.querySelector('.composer-runtime-controls')).toBeNull();
    expect(screen.getByTestId("send-button")).toBeInTheDocument();
    expect(screen.getByTestId("send-button")).toHaveAttribute("title", "追加到队列");
    expect(screen.queryByRole("group", { name: "运行时发送模式" })).toBeNull();
  });

  it("排队状态禁用发送", () => {
    setup({ queued: true });
    expect(screen.getByTestId("send-button")).toBeDisabled();
  });
});
