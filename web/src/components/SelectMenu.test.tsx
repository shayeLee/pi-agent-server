import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SelectMenu } from "./SelectMenu.js";

const options = [
  { value: "a", label: "项目 A" },
  { value: "b", label: "项目 B" },
  { value: "c", label: "项目 C" },
];

describe("SelectMenu", () => {
  it("展示受控选中值并自绘 listbox 与 option", () => {
    const onChange = vi.fn();
    const { container } = render(
      <SelectMenu options={options} value="a" onChange={onChange} ariaLabel="选择项目" testId="project-trigger" />,
    );
    const trigger = screen.getByRole("button", { name: "选择项目" });
    expect(trigger).toHaveAttribute("data-testid", "project-trigger");
    expect(trigger).toHaveAttribute("data-value", "a");
    expect(trigger).toHaveTextContent("项目 A");
    expect(container.querySelector("select")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole("listbox", { name: "选择项目" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "项目 A" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("option", { name: "项目 B" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("支持上下键、Home/End 和 Enter 选择", () => {
    const onChange = vi.fn();
    render(<SelectMenu options={options} value="b" onChange={onChange} ariaLabel="选择项目" />);
    fireEvent.click(screen.getByRole("button", { name: "选择项目" }));
    const listbox = screen.getByRole("listbox");

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "项目 C" })).toHaveAttribute("data-active", "true");
    fireEvent.keyDown(listbox, { key: "Home" });
    expect(screen.getByRole("option", { name: "项目 A" })).toHaveAttribute("data-active", "true");
    fireEvent.keyDown(listbox, { key: "End" });
    expect(screen.getByRole("option", { name: "项目 C" })).toHaveAttribute("data-active", "true");
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("c");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Escape 和外部点击关闭菜单", () => {
    render(<SelectMenu options={options} value="a" onChange={vi.fn()} ariaLabel="选择项目" />);
    const trigger = screen.getByRole("button", { name: "选择项目" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it.each([true, false])("打开后禁用或清空选项会关闭，点击和键盘不会改变值 (disabled=%s)", (disabled) => {
    const onChange = vi.fn();
    const { rerender } = render(<SelectMenu options={options} value="a" onChange={onChange} ariaLabel="选择项目" />);
    const trigger = screen.getByRole("button", { name: "选择项目" });
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox");
    const option = screen.getByRole("option", { name: "项目 B" });
    rerender(<SelectMenu options={disabled ? options : []} value="a" onChange={onChange} ariaLabel="选择项目" disabled={disabled} />);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(option);
    fireEvent.keyDown(listbox, { key: "Enter" });
    fireEvent.keyDown(listbox, { key: " " });
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("键盘活动选项滚动到最近可见位置（兼容没有 scrollIntoView 的环境）", () => {
    const longOptions = Array.from({ length: 50 }, (_, index) => ({ value: String(index), label: `项目 ${index}` }));
    render(<SelectMenu options={longOptions} value="0" onChange={vi.fn()} ariaLabel="选择项目" />);
    fireEvent.click(screen.getByRole("button", { name: "选择项目" }));
    const listbox = screen.getByRole("listbox");
    const last = screen.getByRole("option", { name: "项目 49" });
    const next = screen.getByRole("option", { name: "项目 1" });
    const first = screen.getByRole("option", { name: "项目 0" });
    const scroll = vi.fn();
    for (const option of [last, next, first]) Object.defineProperty(option, "scrollIntoView", { configurable: true, value: scroll });
    for (const key of ["ArrowDown", "End", "Home", "ArrowUp"]) {
      fireEvent.keyDown(listbox, { key });
      expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });
    }
    expect(scroll).toHaveBeenCalledTimes(4);
    expect(last).toHaveAttribute("data-active", "true");
  });

  it("没有选项时禁用触发按钮", () => {
    const { container } = render(<SelectMenu options={[]} value="" onChange={vi.fn()} ariaLabel="选择项目" />);
    expect(screen.getByRole("button", { name: "选择项目" })).toBeDisabled();
    expect(container.querySelector("select")).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
