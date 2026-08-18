import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Chat } from "./Chat.js";
import type { SessionRecord, TimelineItem } from "../types.js";

const session: SessionRecord = {
  id: "s1",
  ownerKey: "k",
  projectId: "default",
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
    timeline,
    streaming: false,
    queued: false,
    loadError: null,
    models: [],
    thinkingLevels: ["off", "low", "medium", "high"],
    defaultModel: null,
    defaultThinkingLevel: "medium",
    connected: true,
    stats: null,
    onSend: vi.fn(),
    onSteer: vi.fn(),
    onFollowUp: vi.fn(),
    onAbort: vi.fn(),
    onToggleDetails: vi.fn(),
    onConfigChange: vi.fn(),
    ...partial,
  };
  render(<Chat {...props} />);
  return props;
}

describe("Chat（聊天区）", () => {
  it("渲染时间线（user + assistant + 工具卡片）", () => {
    setup();
    expect(screen.getByText("帮我查天气")).toBeInTheDocument();
    expect(screen.getByText("好的")).toBeInTheDocument();
    expect(screen.getByTestId("tool-call-card")).toBeInTheDocument();
    expect(screen.getByTestId("tool-name")).toHaveTextContent("weather");
  });

  it("空时间线显示空状态", () => {
    setup({ timeline: [] });
    expect(screen.getByTestId("chat-empty")).toBeInTheDocument();
  });

  it("未选择会话显示提示", () => {
    setup({ session: null });
    expect(screen.getByTestId("no-session-hint")).toBeInTheDocument();
  });

  it("发送按钮触发 onSend(text) 并清空输入框", () => {
    const { onSend } = setup();
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "再问一个问题" } });
    fireEvent.click(screen.getByTestId("send-button"));
    expect(onSend).toHaveBeenCalledWith("再问一个问题");
    expect(input).toHaveValue("");
  });

  it("会话未覆盖配置时显示实际默认模型与思考级别", () => {
    setup({
      defaultModel: { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" },
      defaultThinkingLevel: "medium",
    });
    expect(screen.getByRole("option", { name: "openai-codex / gpt-5.5" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "medium" })).toBeInTheDocument();
  });

  it("流式时显示中止按钮", () => {
    setup({ streaming: true });
    expect(screen.getByTestId("abort-button")).toBeInTheDocument();
    expect(screen.queryByTestId("send-button")).not.toBeInTheDocument();
  });

  it("排队状态禁用发送", () => {
    setup({ queued: true });
    expect(screen.getByTestId("send-button")).toBeDisabled();
  });
});
