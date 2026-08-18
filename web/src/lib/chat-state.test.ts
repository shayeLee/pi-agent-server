import { describe, it, expect } from "vitest";
import { createChatState, applySseEvent, addUserMessage } from "./chat-state.js";
import type { ChatState } from "./chat-state.js";
import type { SseEvent } from "../types.js";

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
