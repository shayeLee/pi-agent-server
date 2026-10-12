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
    ...overrides,
  };
  render(<ProjectSwitcher {...props} />);
  return props;
}

describe("ProjectSwitcher（项目切换器）", () => {
  it("渲染自绘项目列表并在触发按钮标记当前项目，无 folder 装饰图标", () => {
    setup();
    expect(document.querySelector(".workbench-project-icon")).not.toBeInTheDocument();
    const trigger = screen.getByTestId("project-select");
    expect(trigger).toHaveAttribute("data-value", DEFAULT_PROJECT_ID);
    expect(trigger).toHaveTextContent("默认项目");
    expect(document.querySelector("select")).not.toBeInTheDocument();

    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "选择项目" })).toHaveFocus();
    expect(screen.getByRole("menuitemradio", { name: "默认项目" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "我的仓库" })).toBeInTheDocument();
    expect(screen.getByTestId("new-project")).toHaveTextContent("新建项目");
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

  it("同名项目按 id 切换，完整 cwd 可悬停查看，均不显示删除入口", () => {
    const { onSelect } = setup({ projects: [
      { id: "one", name: "repo", cwd: "/one/repo", isDefault: false, canDelete: false },
      { id: "two", name: "repo", cwd: "/two/repo", isDefault: false, canDelete: false },
    ], activeId: "one" });
    expect(screen.getByTestId("project-select")).toHaveAttribute("title", "/one/repo");
    expect(screen.queryByTestId("delete-project")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("project-select"));
    expect(screen.queryByTestId("delete-project")).not.toBeInTheDocument();
    const options = screen.getAllByRole("menuitemradio", { name: "repo" });
    expect(options[1]).toHaveAttribute("title", "/two/repo");
    fireEvent.click(options[1]!);
    expect(onSelect).toHaveBeenCalledWith("two");
  });

  it("切换项目触发 onSelect(id)", () => {
    const { onSelect } = setup();
    fireEvent.click(screen.getByTestId("project-select"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "我的仓库" }));
    expect(onSelect).toHaveBeenCalledWith("p1");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByTestId("project-select")).toHaveFocus();
  });

  it("默认项目与额外项目均不提供项目删除入口（Web UI 不做项目删除）", () => {
    setup({ activeId: DEFAULT_PROJECT_ID });
    fireEvent.click(screen.getByTestId("project-select"));
    expect(screen.queryByTestId("delete-project")).not.toBeInTheDocument();
    expect(screen.queryByText("删除项目")).not.toBeInTheDocument();
    expect(screen.queryByText("删除当前项目")).not.toBeInTheDocument();

    const { unmount } = render(<ProjectSwitcher projects={projects} activeId="p1" onSelect={vi.fn()} onCreate={vi.fn()} />);
    const extraTrigger = screen.getAllByTestId("project-select")[1]!;
    fireEvent.click(extraTrigger);
    expect(screen.queryByTestId("delete-project")).not.toBeInTheDocument();
    expect(screen.queryByText("删除项目")).not.toBeInTheDocument();
    expect(screen.queryByText("删除当前项目")).not.toBeInTheDocument();
    unmount();
  });

  it("使用专用的 12px 居中 project-chevron-down 资产作为触发器下拉箭头，展开时切换为 project-chevron-up", () => {
    setup();
    const trigger = screen.getByTestId("project-select");
    const svg = trigger.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("data-icon", "project-chevron-down");
    expect(svg).toHaveAttribute("viewBox", "0 0 12 12");

    fireEvent.click(trigger);
    const openSvg = trigger.querySelector("svg");
    expect(openSvg).toHaveAttribute("data-icon", "project-chevron-up");
    expect(openSvg).toHaveAttribute("viewBox", "0 0 12 12");
  });

  it("新建项目流程：从菜单点击「新建项目」展开表单，输入并提交触发 onCreate", () => {
    const { onCreate } = setup();
    fireEvent.click(screen.getByTestId("project-select"));
    fireEvent.click(screen.getByTestId("new-project"));
    expect(screen.getByTestId("project-create-form")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("project-name-input"), { target: { value: "新项目" } });
    fireEvent.change(screen.getByTestId("project-cwd-input"), { target: { value: "/path/x" } });
    fireEvent.click(screen.getByTestId("project-create-submit"));
    expect(onCreate).toHaveBeenCalledWith("新项目", "/path/x");
    expect(screen.queryByTestId("project-create-form")).not.toBeInTheDocument();
  });

  it("新建项目表单：点击取消或按 Escape 退出并回焦触发器", () => {
    setup();
    const trigger = screen.getByTestId("project-select");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "选择项目" });
    fireEvent.keyDown(menu, { key: "End" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByTestId("project-create-form")).toBeInTheDocument();
    expect(screen.getByTestId("project-name-input")).toHaveFocus();

    fireEvent.click(screen.getByTestId("project-create-cancel"));
    expect(screen.queryByTestId("project-create-form")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    // 再次打开并通过 Escape 取消
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("new-project"));
    expect(screen.getByTestId("project-create-form")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("project-name-input"), { key: "Escape" });
    expect(screen.queryByTestId("project-create-form")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
