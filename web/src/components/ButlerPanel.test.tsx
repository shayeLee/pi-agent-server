import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createChatState, type ActivityResult, type ActivityRun, type ChatState } from "pi-agent-server/client";
import { ButlerPanel, type ButlerPanelProps } from "./ButlerPanel.js";
import type { Butler } from "../hooks/useButler.js";

const run = (sessionId: string, title = `会话 ${sessionId}`): ActivityRun => ({ sessionId, projectId: "p1", title, startedAt: 1 });
const ended = (id: number, sessionId: string, kind: ActivityResult["kind"] = "completed"): ActivityResult =>
  ({ id, at: id, sessionId, projectId: "p2", title: `会话 ${sessionId}`, kind, durationMs: 1 });

function butler(overrides: Partial<Butler> = {}): Butler {
  return { availability: "ready", session: null, state: createChatState(), connection: "idle", error: null,
    send: vi.fn(async () => true), abort: vi.fn(), reset: vi.fn(async () => {}), ...overrides };
}

function setup(overrides: Partial<ButlerPanelProps> = {}) {
  const props: ButlerPanelProps = { name: "小派", running: new Map(), recent: [], onOpen: vi.fn(), onClose: vi.fn(),
    notify: { enabled: false, permission: "default", toggle: vi.fn() }, butler: butler(), ...overrides };
  return { props, ...render(<ButlerPanel {...props} />) };
}

describe("ButlerPanel", () => {
  it("lists what runs and how recent runs ended; a row opens its session", () => {
    const { props } = setup({ running: new Map([["a", run("a", "")]]), recent: [ended(7, "b", "failed"), ended(6, "c", "aborted")] });
    expect(screen.getByTestId("activity-running-a")).toHaveTextContent("未命名会话运行中");
    expect(screen.getByTestId("activity-recent-7")).toHaveTextContent("会话 b失败");
    expect(screen.getByTestId("activity-recent-6")).toHaveTextContent("会话 c已中止");
    fireEvent.click(screen.getByTestId("activity-recent-7"));
    expect(props.onOpen).toHaveBeenCalledWith("p2", "b");
    fireEvent.click(screen.getByTestId("butler-close"));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("switches notifications in its header, and says when the browser refuses them", () => {
    const toggle = vi.fn();
    setup({ notify: { enabled: false, permission: "default", toggle } });
    fireEvent.click(screen.getByTestId("activity-notify"));
    expect(toggle).toHaveBeenCalledWith(true);
    cleanup();
    setup({ notify: { enabled: false, permission: "denied", toggle } });
    expect(screen.getByTestId("activity-notify")).toBeDisabled();
    expect(screen.getByText("浏览器没有允许通知，可以在浏览器的网站设置里打开")).toBeInTheDocument();
    cleanup();
    setup({ notify: { enabled: false, permission: "insecure", toggle } });
    expect(screen.getByTestId("activity-notify")).toBeDisabled();
    expect(screen.getByText(/用 http 地址（如局域网 IP）打开时浏览器不允许通知/)).toBeInTheDocument();
  });

  it("without a butler shows only the lists", () => {
    setup({ butler: butler({ availability: "unavailable" }) });
    expect(screen.queryByTestId("butler-conversation")).toBeNull();
    expect(screen.getByText("正在跑")).toBeInTheDocument();
  });

  it("sends with Enter, keeps images as links, and opens session links in the page", async () => {
    const send = vi.fn(async () => true);
    const state: ChatState = { ...createChatState(), timeline: [
      { kind: "message", id: "m1", role: "assistant", text: "[修登录](/p/p1/s/s1) ![图](https://evil.example/x.png)" },
    ] } as ChatState;
    const { props } = setup({ butler: butler({ send, state, session: { id: "b1" } as Butler["session"] }) });
    expect(document.querySelector(".butler-panel img")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "修登录" }));
    expect(props.onOpen).toHaveBeenCalledWith("p1", "s1");
    const input = screen.getByTestId("butler-input");
    fireEvent.change(input, { target: { value: "今天跑了什么" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(send).toHaveBeenCalledWith("今天跑了什么");
    await vi.waitFor(() => expect(input).toHaveValue(""));
    expect(screen.getByTestId("butler-reset")).toBeInTheDocument();
  });
});
