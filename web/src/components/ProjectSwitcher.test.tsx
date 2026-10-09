import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import type { Project } from "pi-agent-server/client";

// Web 不硬编码默认项目 id：测试夹具直接引用服务端 DEFAULT_PROJECT_ID 的同一 UUID，
// 并由 isDefault: true 标记默认项目（与真实列表来源一致）。
const DEFAULT_PROJECT_ID = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
const projects: Project[] = [
  { id: DEFAULT_PROJECT_ID, name: "默认项目", cwd: "/tmp/default", isDefault: true },
  { id: "p1", name: "我的仓库", cwd: "/path/a", isDefault: false },
];

function setup(overrides: Partial<Parameters<typeof ProjectSwitcher>[0]> = {}) {
  const props = {
    projects,
    activeId: DEFAULT_PROJECT_ID,
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  render(<ProjectSwitcher {...props} />);
  return props;
}

describe("ProjectSwitcher（项目切换器）", () => {
  it("渲染自绘项目列表并在触发按钮标记当前项目", () => {
    setup();
    const trigger = screen.getByTestId("project-select");
    expect(trigger).toHaveAttribute("data-value", DEFAULT_PROJECT_ID);
    expect(trigger).toHaveTextContent("默认项目");
    expect(document.querySelector("select")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole("option", { name: "默认项目" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "我的仓库" })).toBeInTheDocument();
  });

  it("长项目名仍位于可收缩标签中，箭头保留在整块可点击触发器内", () => {
    const longName = "很长的项目名称用于验证箭头不会被挤出选择框右侧";
    setup({
      projects: [{ ...projects[0]!, name: longName }],
      activeId: DEFAULT_PROJECT_ID,
    });

    const trigger = screen.getByTestId("project-select");
    expect(trigger.closest(".workbench-project-select")).toBeInTheDocument();
    expect(trigger.querySelector(".select-menu-label")).toHaveTextContent(longName);
    expect(trigger.querySelector("svg")).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("同名项目按 id 切换，完整 cwd 可悬停查看，系统共享项目不显示删除", () => {
    const { onSelect } = setup({ projects: [
      { id: "one", name: "repo", cwd: "/one/repo", isDefault: false, canDelete: false },
      { id: "two", name: "repo", cwd: "/two/repo", isDefault: false, canDelete: false },
    ], activeId: "one" });
    expect(screen.getByTestId("project-select")).toHaveAttribute("title", "/one/repo");
    expect(screen.queryByTestId("delete-project")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("project-select"));
    const options = screen.getAllByRole("option", { name: "repo" });
    expect(options[1]).toHaveAttribute("title", "/two/repo");
    fireEvent.click(options[1]!);
    expect(onSelect).toHaveBeenCalledWith("two");
  });

  it("切换项目触发 onSelect(id)", () => {
    const { onSelect } = setup();
    fireEvent.click(screen.getByTestId("project-select"));
    fireEvent.click(screen.getByRole("option", { name: "我的仓库" }));
    expect(onSelect).toHaveBeenCalledWith("p1");
  });

  it("默认项目（isDefault）不显示删除按钮；额外项目显示", () => {
    setup({ activeId: DEFAULT_PROJECT_ID });
    expect(screen.queryByTestId("delete-project")).not.toBeInTheDocument();
  });

  it("额外项目显示删除按钮，确认后触发 onDelete", () => {
    const { onDelete } = setup({ activeId: "p1" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByTestId("delete-project"));
    expect(onDelete).toHaveBeenCalledWith("p1");
    vi.restoreAllMocks();
  });

  it("新建项目表单：填入 name + cwd 提交触发 onCreate", () => {
    const { onCreate } = setup();
    fireEvent.click(screen.getByTestId("new-project"));
    fireEvent.change(screen.getByTestId("project-name-input"), { target: { value: "新项目" } });
    fireEvent.change(screen.getByTestId("project-cwd-input"), { target: { value: "/path/x" } });
    fireEvent.click(screen.getByTestId("project-create-submit"));
    expect(onCreate).toHaveBeenCalledWith("新项目", "/path/x");
  });
});
