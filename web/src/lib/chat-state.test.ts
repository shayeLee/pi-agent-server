import { describe, it, expect } from "vitest";
import { createChatState, applySseEvent, addUserMessage, createChatStore } from "pi-agent-server/client";
import type { ChatState, SseEvent } from "pi-agent-server/client";

/** 从初始状态依次应用一组事件。 */
function run(events: SseEvent[]): ChatState {
  return events.reduce((s, e) => applySseEvent(s, e), createChatState());
}

/** 取时间线上的全部消息（role + text）。 */
function messages(s: ChatState): Array<[string, string]> {
  return s.timeline
    .filter((i) => i.kind === "message")
    .map((i) => [i.role, i.text] as [string, string]);
}

/** 取时间线上的全部工具调用。 */
function tools(s: ChatState): Array<Extract<(typeof s.timeline)[number], { kind: "tool" }>["call"]> {
  return s.timeline.filter((i) => i.kind === "tool").map((i) => i.call);
}

const terminalRegressionCases = (["text_delta", "thinking_delta"] as const).flatMap(deltaType =>
  (["aborted", "completed", "error"] as const).flatMap(terminal =>
    [false, true].map(withNotification => [deltaType, terminal, withNotification] as const),
  ),
);

describe("chat-state（SSE 事件 → 时间线 UI 状态映射）", () => {
  it("初始状态：空时间线、idle、无错误", () => {
    const s = createChatState();
    expect(s.timeline).toEqual([]);
    expect(s.phase).toBe("idle");
    expect(s.error).toBeNull();
  });

  it("text_delta 增量拼接到同一 assistant 消息", () => {
    const s = run([
      { type: "text_delta", text: "你" },
      { type: "text_delta", text: "好，" },
      { type: "text_delta", text: "世界" },
    ]);
    expect(messages(s)).toEqual([["assistant", "你好，世界"]]);
    expect(s.timeline[0]).toMatchObject({ kind: "message", role: "assistant", streaming: true });
    expect(s.phase).toBe("streaming");
  });

  it("user 消息后 text_delta 打开新 assistant 消息；completed 后再来 text_delta 另起第二条", () => {
    let s = createChatState();
    s = addUserMessage(s, "第一个问题");
    s = applySseEvent(s, { type: "text_delta", text: "回答一" });
    s = applySseEvent(s, { type: "completed" });
    s = applySseEvent(s, { type: "text_delta", text: "回答二" });
    expect(messages(s)).toEqual([
      ["user", "第一个问题"],
      ["assistant", "回答一"],
      ["assistant", "回答二"],
    ]);
    expect(s.phase).toBe("streaming");
  });

  it("addUserMessage 追加 user 消息，多轮消息正确拼接", () => {
    let s = createChatState();
    s = addUserMessage(s, "q1");
    s = applySseEvent(s, { type: "text_delta", text: "hi" });
    s = applySseEvent(s, { type: "completed" });
    s = addUserMessage(s, "q2");
    s = applySseEvent(s, { type: "text_delta", text: "yo" });
    expect(messages(s)).toEqual([
      ["user", "q1"],
      ["assistant", "hi"],
      ["user", "q2"],
      ["assistant", "yo"],
    ]);
  });

  it("tool_start 新建未完成卡片并保存 args", () => {
    const s = run([
      { type: "tool_start", toolCallId: "t1", toolName: "search", args: { q: "x" } },
    ]);
    expect(tools(s)).toEqual([
      {
        toolCallId: "t1",
        toolName: "search",
        args: { q: "x" },
        partialResult: undefined,
        result: undefined,
        isError: false,
        done: false,
      },
    ]);
    expect(s.phase).toBe("streaming");
  });

  it("tool_start → tool_update × 2 → tool_end 完整演进（流式卡片状态）", () => {
    const s = run([
      { type: "tool_start", toolCallId: "t1", toolName: "search", args: { q: "x" } },
      { type: "tool_update", toolCallId: "t1", toolName: "search", partialResult: "部" },
      { type: "tool_update", toolCallId: "t1", toolName: "search", partialResult: "部分" },
      { type: "tool_end", toolCallId: "t1", toolName: "search", result: "完整结果", isError: false },
    ]);
    expect(tools(s)).toHaveLength(1);
    const t = tools(s)[0]!;
    expect(t.partialResult).toBe("部分");
    expect(t.result).toBe("完整结果");
    expect(t.isError).toBe(false);
    expect(t.done).toBe(true);
  });

  it("tool_update 对未知 toolCallId 兜底新建卡片", () => {
    const s = run([
      { type: "tool_update", toolCallId: "t9", toolName: "calc", partialResult: "0.5" },
    ]);
    expect(tools(s)).toEqual([
      {
        toolCallId: "t9",
        toolName: "calc",
        args: undefined,
        partialResult: "0.5",
        result: undefined,
        isError: false,
        done: false,
      },
    ]);
  });

  it("tool_end 只结束匹配 toolCallId 的卡片，不影响其它卡片", () => {
    const s = run([
      { type: "tool_start", toolCallId: "t1", toolName: "a", args: null },
      { type: "tool_start", toolCallId: "t2", toolName: "b", args: null },
      { type: "tool_end", toolCallId: "t1", toolName: "a", result: "r1", isError: false },
    ]);
    expect(tools(s).map((t) => [t.toolCallId, t.done, t.result])).toEqual([
      ["t1", true, "r1"],
      ["t2", false, undefined],
    ]);
  });

  it("tool_end 携带 isError 标记错误卡片", () => {
    const s = run([
      { type: "tool_start", toolCallId: "t1", toolName: "search", args: {} },
      { type: "tool_end", toolCallId: "t1", toolName: "search", result: "rate limit", isError: true },
    ]);
    expect(tools(s)[0]).toMatchObject({ done: true, isError: true, result: "rate limit" });
  });

  it("status 事件（agent_start/turn_start）置为 streaming", () => {
    expect(run([{ type: "status", phase: "agent_start" }]).phase).toBe("streaming");
    expect(run([{ type: "status", phase: "turn_start" }]).phase).toBe("streaming");
  });

  it("queued 显示排队状态", () => {
    const s = run([{ type: "queued", position: 1 }]);
    expect(s.phase).toBe("queued");
  });

  it("completed 标记本次回答结束", () => {
    let s = createChatState();
    s = applySseEvent(s, { type: "text_delta", text: "x" });
    s = applySseEvent(s, { type: "completed" });
    expect(s.phase).toBe("completed");
    expect(s.error).toBeNull();
  });

  it("aborted 标记中止", () => {
    expect(run([{ type: "aborted" }]).phase).toBe("aborted");
  });

  it.each(terminalRegressionCases)("%s → %s（notification=%s）关闭全部流式内容", (deltaType, terminal, withNotification) => {
    let state = addUserMessage(createChatState(), "问题", "user-1", "request-1");
    state = applySseEvent(state, { type: "tool_start", toolCallId: "tool-1", toolName: "search", args: null, requestId: "request-1" });
    state = applySseEvent(state, { type: deltaType, text: "流式内容", requestId: "request-1" });
    if (withNotification) {
      state = applySseEvent(state, { type: "notification", version: 1, notificationId: "notification-1", runIds: ["run-1"], text: "通知", entryId: "entry-1", timestamp: "2026-01-01T00:00:00Z" });
    }
    const original = state;
    const originalTimeline = state.timeline;
    const notification = state.timeline.find(item => item.kind === "notification");
    const terminalEvent: SseEvent = terminal === "error"
      ? { type: "error", message: "失败", requestId: "request-1" }
      : { type: terminal, requestId: "request-1" };
    const result = applySseEvent(state, terminalEvent);

    expect(result.timeline.filter(item => (item.kind === "thinking" || (item.kind === "message" && item.role === "assistant")) && item.streaming)).toEqual([]);
    expect(result.timeline.find(item => item.kind === "message" && item.role === "user")).toMatchObject({ text: "问题" });
    expect(result.timeline.find(item => item.kind === "tool")).toBeDefined();
    if (withNotification) expect(result.timeline.find(item => item.kind === "notification")).toBe(notification);
    expect(original.timeline).toBe(originalTimeline);
    expect(original.timeline.some(item => (item.kind === "thinking" || (item.kind === "message" && item.role === "assistant")) && item.streaming)).toBe(true);
  });

  it("旧 request 的终止事件不关闭新 request 的流式内容", () => {
    let state = applySseEvent(createChatState(), { type: "text_delta", text: "旧回答", requestId: "old" });
    state = applySseEvent(state, { type: "completed", requestId: "old" });
    state = applySseEvent(state, { type: "text_delta", text: "新回答", requestId: "new" });
    const result = applySseEvent(state, { type: "aborted", requestId: "old" });
    expect(result).toBe(state);
    expect(result.timeline.at(-1)).toMatchObject({ kind: "message", text: "新回答", streaming: true });
    expect(result.phase).toBe("streaming");
  });

  it("error 显示错误消息；之后的 text_delta 另起新消息", () => {
    let s = createChatState();
    s = applySseEvent(s, { type: "error", message: "上游超时" });
    expect(s.error).toBe("上游超时");
    s = applySseEvent(s, { type: "text_delta", text: "重试结果" });
    expect(messages(s)).toEqual([["assistant", "重试结果"]]);
  });

  it("工具调用打断文本流：tool 前后 text_delta 分段为两条 assistant 消息（时间线顺序正确）", () => {
    const s = run([
      { type: "text_delta", text: "先" },
      { type: "tool_start", toolCallId: "t1", toolName: "x", args: null },
      { type: "tool_end", toolCallId: "t1", toolName: "x", result: "r", isError: false },
      { type: "text_delta", text: "后" },
    ]);
    // 时间线顺序：assistant「先」(已关闭) → tool → assistant「后」(流式中)
    expect(s.timeline.map((i) => i.kind)).toEqual(["message", "tool", "message"]);
    expect(messages(s)).toEqual([
      ["assistant", "先"],
      ["assistant", "后"],
    ]);
    expect(s.timeline[0]).toMatchObject({ streaming: false });
    expect(s.timeline[2]).toMatchObject({ streaming: true });
    expect(tools(s)[0]!.done).toBe(true);
  });

  it("纯函数：同一输入不改变原状态对象", () => {
    const s0 = createChatState();
    const s1 = applySseEvent(s0, { type: "text_delta", text: "hi" });
    expect(s0.timeline).toEqual([]);
    expect(s1).not.toBe(s0);
  });
});

describe("extension command output", () => {
  it("adds one system entry per recorded run, whoever ran it and whatever request is active", () => {
    const event: SseEvent = { type: "command_output", version: 1, name: "antigravity.usage", args: "", failed: false,
      output: [{ level: "info", text: "Gemini 80%" }], entryId: "e1", timestamp: "2026-10-19T10:00:00Z" };
    const busy = { ...createChatState(), phase: "streaming" as const, activeRequestId: "r1" };
    const once = applySseEvent(busy, event);
    expect(once.timeline).toEqual([{ kind: "command", id: "command:e1", version: 1, name: "antigravity.usage", args: "", failed: false,
      output: [{ level: "info", text: "Gemini 80%" }], entryId: "e1", timestamp: "2026-10-19T10:00:00Z" }]);
    expect(once.phase).toBe("streaming");
    expect(applySseEvent(once, event).timeline).toHaveLength(1);
  });
});

describe("extension command questions", () => {
  const prompt = { promptId: "p1", command: "workbuddy", kind: "select" as const, title: "Plan", options: ["free", "all"], expiresAt: 1 };

  it("keeps a question answered elsewhere on screen until the output arrives, and drops cancelled ones", () => {
    const asked = applySseEvent(createChatState(), { type: "command_prompt", prompt });
    expect(asked.commandPrompt).toEqual({ prompt });
    expect(applySseEvent(asked, { type: "command_prompt_closed", promptId: "other", reason: "answered" })).toBe(asked);
    const answered = applySseEvent(asked, { type: "command_prompt_closed", promptId: "p1", reason: "answered" });
    expect(answered.commandPrompt).toEqual({ prompt, closed: "answered" });
    const done = applySseEvent(answered, { type: "command_output", version: 1, name: "workbuddy", args: "", failed: false, output: [], entryId: "e1", timestamp: "t" });
    expect(done.commandPrompt).toBeNull();
    expect(applySseEvent(asked, { type: "command_prompt_closed", promptId: "p1", reason: "timeout" }).commandPrompt).toBeNull();
  });

  it("restores the open question on (re)connect without undoing a newer close", () => {
    const store = createChatStore();
    store.restoreCommandPrompt(prompt);
    expect(store.getState().commandPrompt).toEqual({ prompt });
    store.applyEvent({ type: "command_prompt_closed", promptId: "p1", reason: "answered" });
    store.restoreCommandPrompt(null);
    expect(store.getState().commandPrompt).toEqual({ prompt, closed: "answered" });
    store.applyEvent({ type: "command_prompt_closed", promptId: "p1", reason: "cancelled" });
    store.restoreCommandPrompt(prompt);
    store.restoreCommandPrompt(null);
    expect(store.getState().commandPrompt).toBeNull();
  });
});
