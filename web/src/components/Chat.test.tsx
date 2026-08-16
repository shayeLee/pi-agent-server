import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Chat } from "./Chat.js";
import type { ChatMessage, ToolCall } from "../types.js";

const messages: ChatMessage[] = [
  { id: "u-0", role: "user", text: "帮我查天气" },
  { id: "a-1", role: "assistant", text: "好的" },
];

const toolCalls: ToolCall[] = [
  {
    toolCallId: "t1",
    toolName: "weather",
    args: { city: "beijing" },
    partialResult: "晴",
    result: undefined,
    isError: false,
    done: false,
  },
];

function setup(partial: Partial<Parameters<typeof Chat>[0]> = {}) {
  const props = {
    messages,
    toolCalls,
    streaming: false,
    onSend: vi.fn(),
    onSteer: vi.fn(),
    onAbort: vi.fn(),
    ...partial,
  };
  render(<Chat {...props} />);
  return props;
}

describe("Chat（聊天区）", () => {
  it("渲染消息列表（user + assistant）与工具调用卡片", () => {
    setup();
    expect(screen.getAllByTestId("message-item")).toHaveLength(2);
    expect(screen.getByText("帮我查天气")).toBeInTheDocument();
    expect(screen.getByText("好的")).toBeInTheDocument();
    expect(screen.getByTestId("tool-call-card")).toBeInTheDocument();
    expect(screen.getByTestId("tool-name")).toHaveTextContent("weather");
  });

  it("发送按钮触发 onSend(text) 并清空输入框", () => {
    const { onSend } = setup();
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "再问一个问题" } });
    fireEvent.click(screen.getByTestId("send-button"));
    expect(onSend).toHaveBeenCalledWith("再问一个问题");
    expect(input).toHaveValue("");
  });

  it("空闲时不显示 steer/abort，流式时显示并向回调传递", () => {
    const { onSteer, onAbort } = setup({ streaming: true });
    expect(screen.getByTestId("steer-button")).toBeInTheDocument();
    expect(screen.getByTestId("abort-button")).toBeInTheDocument();
    expect(screen.queryByTestId("send-button")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "换个方向" } });
    fireEvent.click(screen.getByTestId("steer-button"));
    expect(onSteer).toHaveBeenCalledWith("换个方向");

    fireEvent.click(screen.getByTestId("abort-button"));
    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});