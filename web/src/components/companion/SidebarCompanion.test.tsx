import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ActivityEvent, ActivityResult, ActivityRun } from "pi-agent-server/client";
import { SIDEBAR_BUBBLE_MS, SidebarCompanion, type SidebarCompanionProps } from "./SidebarCompanion.js";

const persona = { name: "小派", style: "concise" as const, docked: true };
const run = (sessionId: string, title = `会话 ${sessionId}`): ActivityRun => ({ sessionId, projectId: "p1", title, startedAt: 1 });
const ended = (id: number, sessionId: string, kind: ActivityResult["kind"] = "completed"): ActivityResult =>
  ({ id, at: id, sessionId, projectId: "p2", title: `会话 ${sessionId}`, kind, durationMs: 1 });

function setup(overrides: Partial<SidebarCompanionProps> = {}) {
  const props: SidebarCompanionProps = {
    persona, running: new Map(), recent: [], latest: null, activeSessionId: "open",
    onOpen: vi.fn(), notify: { enabled: false, permission: "default", toggle: vi.fn() }, ...overrides,
  };
  const utils = render(<SidebarCompanion {...props} />);
  return { props, ...utils, update: (next: Partial<SidebarCompanionProps>) => utils.rerender(<SidebarCompanion {...props} {...next} />) };
}

/** Radix opens its menu on pointerdown. */
function openMenu() {
  const trigger = screen.getByTestId("sidebar-companion-toggle");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("SidebarCompanion", () => {
  it("works while sessions run and shows how many", () => {
    const { update } = setup();
    expect(screen.getByTestId("sidebar-companion-toggle")).toHaveAttribute("data-mood", "idle");
    expect(screen.queryByTestId("sidebar-companion-count")).toBeNull();
    update({ running: new Map([["a", run("a")], ["b", run("b")]]) });
    expect(screen.getByTestId("sidebar-companion-toggle")).toHaveAttribute("data-mood", "working");
    expect(screen.getByTestId("sidebar-companion-count")).toHaveTextContent("2");
    expect(screen.getByTestId("sidebar-companion-toggle")).toHaveAccessibleName("小派：2 个会话在跑，点开看看");
  });

  it("says when another session ends, opens it on click, and stays quiet for the open session", () => {
    const { props, update } = setup();
    update({ latest: { ...ended(1, "open"), kind: "completed" } });
    expect(screen.queryByTestId("sidebar-companion-bubble")).toBeNull();

    update({ latest: ended(2, "other", "failed") });
    const bubble = screen.getByTestId("sidebar-companion-bubble");
    expect(bubble).toHaveTextContent("「会话 other」失败了。");
    expect(screen.getByTestId("sidebar-companion-toggle")).toHaveAttribute("data-mood", "sad");
    fireEvent.click(bubble);
    expect(props.onOpen).toHaveBeenCalledWith("p2", "other");
    expect(screen.queryByTestId("sidebar-companion-bubble")).toBeNull();
    update({ latest: ended(4, "other") });

    // A run starting elsewhere does not cut the word short; it goes after SIDEBAR_BUBBLE_MS.
    update({ latest: { id: 3, at: 3, sessionId: "x", projectId: "p1", title: "x", kind: "started" } satisfies ActivityEvent });
    expect(screen.getByTestId("sidebar-companion-bubble")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(SIDEBAR_BUBBLE_MS); });
    expect(screen.queryByTestId("sidebar-companion-bubble")).toBeNull();
  });

  it("lists what runs and how recent runs ended; a row opens its session", () => {
    vi.useRealTimers();
    const { props } = setup({ running: new Map([["a", run("a", "")]]), recent: [ended(7, "b", "failed"), ended(6, "c", "aborted")] });
    openMenu();
    expect(screen.getByTestId("activity-running-a")).toHaveTextContent("未命名会话运行中");
    expect(screen.getByTestId("activity-recent-7")).toHaveTextContent("会话 b失败");
    expect(screen.getByTestId("activity-recent-6")).toHaveTextContent("会话 c已中止");
    fireEvent.click(screen.getByTestId("activity-recent-7"));
    expect(props.onOpen).toHaveBeenCalledWith("p2", "b");
  });

  it("switches notifications from its menu, and says when the browser refuses them", () => {
    vi.useRealTimers();
    const toggle = vi.fn();
    const { unmount } = setup({ notify: { enabled: false, permission: "default", toggle } });
    openMenu();
    fireEvent.click(screen.getByTestId("activity-notify"));
    expect(toggle).toHaveBeenCalledWith(true);
    unmount();

    setup({ notify: { enabled: false, permission: "denied", toggle } });
    openMenu();
    expect(screen.getByTestId("activity-notify")).toHaveAttribute("data-disabled");
    expect(screen.getByText("浏览器没有允许通知，可以在浏览器的网站设置里打开")).toBeInTheDocument();
  });
});
