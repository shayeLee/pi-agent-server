import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ActivityRun } from "pi-agent-server/client";
import { SidebarActivity, type SidebarActivityProps } from "./SidebarActivity.js";

const run = (sessionId: string): ActivityRun => ({ sessionId, projectId: "p1", title: `会话 ${sessionId}`, startedAt: 1 });

describe("SidebarActivity", () => {
  it("says how many sessions run, in words, and switches the panel", () => {
    const props: SidebarActivityProps = { running: new Map(), open: false, onToggle: vi.fn() };
    const { rerender } = render(<SidebarActivity {...props} />);
    const toggle = screen.getByTestId("sidebar-activity-toggle");
    expect(toggle).toHaveTextContent("运行动态");
    expect(toggle).not.toHaveAttribute("data-running");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    rerender(<SidebarActivity {...props} open running={new Map([["a", run("a")], ["b", run("b")]])} />);
    expect(toggle).toHaveAttribute("data-running", "true");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAccessibleName("2 个会话在跑，点开看看");
    expect(screen.getByTestId("sidebar-activity-count")).toHaveTextContent("2");
    fireEvent.click(toggle);
    expect(props.onToggle).toHaveBeenCalledOnce();
  });
});
