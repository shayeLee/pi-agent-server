import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import type { Project } from "../types.js";

const projects: Project[] = [
  { id: "default", name: "默认项目", cwd: "/tmp/default" },
  { id: "p1", name: "我的仓库", cwd: "/path/a" },
];

function setup(overrides: Partial<Parameters<typeof ProjectSwitcher>[0]> = {}) {
  const props = {
    projects,
    activeId: "default",
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  render(<ProjectSwitcher {...props} />);
  return props;
}

describe("ProjectSwitcher（项目切换器）", () => {
  it("渲染项目下拉列表，当前选中项目", () => {
    setup();
    const select = screen.getByTestId("project-select") as HTMLSelectElement;
    expect(select.value).toBe("default");
    expect(screen.getByText("默认项目")).toBeInTheDocument();
    expect(screen.getByText("我的仓库")).toBeInTheDocument();
  });

  it("切换项目触发 onSelect(id)", () => {
    const { onSelect } = setup();
    fireEvent.change(screen.getByTestId("project-select"), { target: { value: "p1" } });
    expect(onSelect).toHaveBeenCalledWith("p1");
  });

  it("默认项目不显示删除按钮；额外项目显示", () => {
    setup({ activeId: "default" });
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
