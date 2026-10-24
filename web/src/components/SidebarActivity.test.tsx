import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ActivityResult, ActivityRun } from "pi-agent-server/client";
import { SidebarActivity, type SidebarActivityProps } from "./SidebarActivity.js";

const run = (sessionId: string, title = `会话 ${sessionId}`): ActivityRun => ({ sessionId, projectId: "p1", title, startedAt: 1 });
const ended = (id: number, sessionId: string, kind: ActivityResult["kind"] = "completed"): ActivityResult =>
  ({ id, at: id, sessionId, projectId: "p2", title: `会话 ${sessionId}`, kind, durationMs: 1 });

function setup(overrides: Partial<SidebarActivityProps> = {}) {
  const props: SidebarActivityProps = { running: new Map(), recent: [], onOpen: vi.fn(), notify: { enabled: false, permission: "default", toggle: vi.fn() }, ...overrides };
  return { props, ...render(<SidebarActivity {...props} />) };
}

/** Radix opens its menu on pointerdown. */
function openMenu() {
  fireEvent.pointerDown(screen.getByTestId("sidebar-activity-toggle"), { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("SidebarActivity", () => {
  it("says how many sessions run, in words", () => {
    const { rerender, props } = setup();
    expect(screen.getByTestId("sidebar-activity-toggle")).toHaveTextContent("运行动态");
    expect(screen.getByTestId("sidebar-activity-toggle")).not.toHaveAttribute("data-running");
    rerender(<SidebarActivity {...props} running={new Map([["a", run("a")], ["b", run("b")]])} />);
    expect(screen.getByTestId("sidebar-activity-toggle")).toHaveAttribute("data-running", "true");
    expect(screen.getByTestId("sidebar-activity-toggle")).toHaveAccessibleName("2 个会话在跑，点开看看");
    expect(screen.getByTestId("sidebar-activity-count")).toHaveTextContent("2");
  });

  it("lists what runs and how recent runs ended; a row opens its session", () => {
    const { props } = setup({ running: new Map([["a", run("a", "")]]), recent: [ended(7, "b", "failed"), ended(6, "c", "aborted")] });
    openMenu();
    expect(screen.getByTestId("activity-running-a")).toHaveTextContent("未命名会话运行中");
    expect(screen.getByTestId("activity-recent-7")).toHaveTextContent("会话 b失败");
    expect(screen.getByTestId("activity-recent-6")).toHaveTextContent("会话 c已中止");
    fireEvent.click(screen.getByTestId("activity-recent-7"));
    expect(props.onOpen).toHaveBeenCalledWith("p2", "b");
  });

  it("switches notifications from its menu, and says when the browser refuses them", () => {
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
