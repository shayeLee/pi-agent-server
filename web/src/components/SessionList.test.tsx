import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionList, formatSessionTime } from "./SessionList.js";
import type { SessionRecord } from "../types.js";

const sessions: SessionRecord[] = [
  { id: "s1", ownerKey: "k", projectId: "default", title: "会话一", createdAt: 1000, updatedAt: 1_700_000_000_000, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null },
  { id: "s2", ownerKey: "k", projectId: "default", title: "会话二", createdAt: 1000, updatedAt: 1_800_000_000_000, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null },
];

function setup(overrides: Partial<Parameters<typeof SessionList>[0]> = {}) {
  const props = {
    sessions,
    activeId: null,
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onExport: vi.fn(),
    ...overrides,
  };
  const utils = render(<SessionList {...props} />);
  return { props, ...utils };
}

describe("SessionList（会话列表）", () => {
  it("渲染每个会话的标题与更新时间", () => {
    setup();
    expect(screen.getByText("会话一")).toBeInTheDocument();
    expect(screen.getByText("会话二")).toBeInTheDocument();
    expect(screen.getByTestId("session-s1")).toHaveTextContent(formatSessionTime(sessions[0]!.updatedAt));
    expect(screen.getByTestId("session-s2")).toHaveTextContent(formatSessionTime(sessions[1]!.updatedAt));
  });

  it("点击会话触发 onSelect(id)", () => {
    const { props } = setup();
    fireEvent.click(screen.getByTestId("session-s2"));
    expect(props.onSelect).toHaveBeenCalledWith("s2");
  });

  it("删除按钮触发 onDelete(id)", () => {
    const { props } = setup();
    fireEvent.click(screen.getByTestId("delete-s1"));
    expect(props.onDelete).toHaveBeenCalledWith("s1");
  });

  it("重命名按钮触发 onRename(id, title)", () => {
    const { props } = setup();
    vi.spyOn(window, "prompt").mockReturnValue("新标题");
    fireEvent.click(screen.getByTestId("rename-s2"));
    expect(props.onRename).toHaveBeenCalledWith("s2", "新标题");
    vi.restoreAllMocks();
  });

  it("activeId 会话标记为激活样式", () => {
    const { container } = setup({ activeId: "s1" });
    expect(container.querySelector(".active")).not.toBeNull();
    expect(container.querySelector(".active")?.textContent).toContain("会话一");
  });

  it("空列表显示占位提示", () => {
    setup({ sessions: [] });
    expect(screen.getByTestId("empty-sessions")).toHaveTextContent("暂无会话");
  });

  it("导出按钮触发 onExport(id)", () => {
    const { props } = setup();
    fireEvent.click(screen.getByTestId("export-s2"));
    expect(props.onExport).toHaveBeenCalledWith("s2");
  });

  it("搜索过滤会话标题", () => {
    setup();
    fireEvent.change(screen.getByTestId("session-search"), { target: { value: "会话一" } });
    expect(screen.getByText("会话一")).toBeInTheDocument();
    expect(screen.queryByText("会话二")).not.toBeInTheDocument();
  });
});