import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionList, formatSessionTime, formatFullSessionTime } from "./SessionList.js";
import type { SessionRecord } from "pi-agent-server/client";

const FIXED_NOW = new Date("2025-05-10T12:00:00.000Z").getTime();

const sessions: SessionRecord[] = [
  { id: "s1", ownerKey: "k", projectId: "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c", title: "会话一", createdAt: 1000, updatedAt: FIXED_NOW - 30 * 1000, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null },
  { id: "s2", ownerKey: "k", projectId: "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c", title: "会话二", createdAt: 1000, updatedAt: FIXED_NOW - 15 * 60 * 1000, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null },
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
  it("search expands below context, focuses, protects IME and clears on either exit", () => {
    setup();
    for (const exit of ["Escape", "toggle"]) {
      const toggle = screen.getByRole("button", { name: "搜索会话" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);
      const input = screen.getByTestId("session-search");
      expect(input).toHaveFocus();
      fireEvent.change(input, { target: { value: "会话二" } });
      expect(screen.queryByTestId("session-s1")).not.toBeInTheDocument();
      fireEvent.compositionStart(input);
      fireEvent.keyDown(input, { key: "Escape" });
      expect(input).toHaveValue("会话二");
      expect(input).toHaveFocus();
      fireEvent.compositionEnd(input);
      if (exit === "Escape") fireEvent.keyDown(input, { key: "Escape" });
      else fireEvent.click(toggle);
      expect(screen.getByRole("button", { name: "搜索会话" })).toHaveFocus();
      expect(input).toHaveValue("");
      expect(screen.getByTestId("session-s1")).toBeVisible();
    }
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("渲染每个会话的标题、相对时间与完整 title / dateTime 可访问性", () => {
    setup();
    expect(screen.getByText("会话一")).toBeInTheDocument();
    expect(screen.getByText("会话二")).toBeInTheDocument();

    const time1 = screen.getByTestId("session-time-s1");
    const time2 = screen.getByTestId("session-time-s2");

    expect(time1).toHaveTextContent("刚刚");
    expect(time1).toHaveAttribute("title", formatFullSessionTime(sessions[0]!.updatedAt));
    expect(time1).toHaveAttribute("dateTime", new Date(sessions[0]!.updatedAt).toISOString());

    expect(time2).toHaveTextContent("15分钟前");
    expect(time2).toHaveAttribute("title", formatFullSessionTime(sessions[1]!.updatedAt));
    expect(time2).toHaveAttribute("dateTime", new Date(sessions[1]!.updatedAt).toISOString());
  });

  it("shared/native sessions show no row badge and explain removal", () => {
    setup({ sessions: [{ ...sessions[0]!, visibility: "shared", origin: "native" }, sessions[1]!] });
    expect(screen.queryByLabelText("原生共享会话")).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTestId("session-s1"));
    expect(screen.getByTestId("delete-s1")).toHaveAttribute("title", "从共享列表移除（保留原始文件）");
  });

  it("full title is accessible, metadata stays together and actions never select", () => {
    const title = "/tmp/很长的会话标题/".repeat(12);
    const { props } = setup({ sessions: [{ ...sessions[0]!, title, visibility: "shared" }], activeId: "s1" });
    const select = screen.getByRole("button", { name: title });
    expect(select).toHaveAttribute("aria-current", "true");
    expect(screen.queryByTestId("rename-s1")).not.toBeInTheDocument();
    // Full title lives on the row; details and actions live in the row menu (DESIGN.md §7).
    expect(select.querySelector(".session-title")).toHaveAttribute("title", title);
    fireEvent.contextMenu(select);
    const menu = screen.getByRole("menu", { name: `会话操作：${title}` });
    expect(menu).toHaveTextContent("共享会话");
    const meta = screen.getByTestId("session-time-s1").parentElement!;
    expect(select).toHaveAttribute("aria-describedby", meta.id);
    for (const action of ["rename", "export", "delete"]) {
      const item = screen.getByTestId(`${action}-s1`);
      expect(select).not.toContainElement(item);
      expect(item).toHaveAttribute("role", "menuitem");
    }
    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.contextMenu(screen.getByTestId("session-s1"));
    fireEvent.click(screen.getByTestId("rename-s1"));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.contextMenu(screen.getByTestId("session-s1"));
    fireEvent.click(screen.getByTestId("export-s1"));
    fireEvent.contextMenu(screen.getByTestId("session-s1"));
    fireEvent.click(screen.getByTestId("delete-s1"));
    expect(props.onSelect).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("title and time share one native button; actions remain independent siblings", () => {
    const { props } = setup();
    const select = screen.getByTestId('session-s1');
    expect(select.tagName).toBe('BUTTON');
    expect(select.closest("li")).not.toBeNull();
    expect(select.querySelector('button')).toBeNull();
    fireEvent.click(screen.getByText('会话一'));
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('session-time-s1'));
    expect(props.onSelect).toHaveBeenCalledTimes(2);
    fireEvent.click(select);
    expect(props.onSelect).toHaveBeenCalledTimes(3);
    expect(props.onSelect).toHaveBeenLastCalledWith('s1');
    fireEvent.click(screen.getByRole('button', { name: '搜索会话' }));
    expect(props.onSelect).toHaveBeenCalledTimes(3);
  });

  it("formatSessionTime 在各阶梯与边界下稳定输出", () => {
    const base = new Date("2025-05-10T12:00:00.000Z").getTime();
    // 边界 / 非法值
    expect(formatSessionTime(0, base)).toBe("");
    expect(formatSessionTime(-1, base)).toBe("");
    expect(formatSessionTime(Number.NaN, base)).toBe("");
    expect(formatSessionTime(Number.MAX_VALUE, base)).toBe("");
    setup({ sessions: [{ ...sessions[0]!, updatedAt: Number.MAX_VALUE }] });
    expect(screen.getByTestId("session-time-s1")).not.toHaveAttribute("dateTime");

    // 刚刚 (0 ~ 59s)
    expect(formatSessionTime(base, base)).toBe("刚刚");
    expect(formatSessionTime(base - 59 * 1000, base)).toBe("刚刚");
    // 未来时间展示真实绝对时间，不伪造刚刚
    expect(formatSessionTime(base + 5000, base)).toBe(formatFullSessionTime(base + 5000));

    // 分钟前 (1 ~ 59 min)
    expect(formatSessionTime(base - 60 * 1000, base)).toBe("1分钟前");
    expect(formatSessionTime(base - 59 * 60 * 1000, base)).toBe("59分钟前");

    // 小时前 (1 ~ 23 hour)
    expect(formatSessionTime(base - 60 * 60 * 1000, base)).toBe("1小时前");
    expect(formatSessionTime(base - 23 * 60 * 60 * 1000, base)).toBe("23小时前");

    // 天前 (1 ~ 29 day)
    expect(formatSessionTime(base - 24 * 60 * 60 * 1000, base)).toBe("1天前");
    expect(formatSessionTime(base - 29 * 24 * 60 * 60 * 1000, base)).toBe("29天前");

    // 超过30天，同一年：短日期 M月D日
    const sameYearOld = new Date("2025-01-15T08:00:00.000Z").getTime();
    const d1 = new Date(sameYearOld);
    expect(formatSessionTime(sameYearOld, base)).toBe(`${d1.getMonth() + 1}月${d1.getDate()}日`);

    // 跨年：YYYY/M/D
    const lastYearOld = new Date("2024-11-20T08:00:00.000Z").getTime();
    const d2 = new Date(lastYearOld);
    expect(formatSessionTime(lastYearOld, base)).toBe(`${d2.getFullYear()}/${d2.getMonth() + 1}/${d2.getDate()}`);
  });

  it("无序输入按有效更新时间稳定排序且不修改原始数组", () => {
    const input = [
      { ...sessions[0]!, id: "yesterday", updatedAt: FIXED_NOW - 86400000 },
      { ...sessions[0]!, id: "today-a", updatedAt: FIXED_NOW - 1000 },
      { ...sessions[0]!, id: "invalid", updatedAt: NaN },
      { ...sessions[0]!, id: "today-b", updatedAt: FIXED_NOW - 1000 },
      { ...sessions[0]!, id: "future", updatedAt: FIXED_NOW + 86400000 },
      { ...sessions[0]!, id: "invalid-large", updatedAt: Number.MAX_VALUE },
    ];
    const before = input.slice();
    const { container } = setup({ sessions: input });
    expect(Array.from(container.querySelectorAll(".session-select"), (el) => el.getAttribute("data-testid"))).toEqual([
      "session-future", "session-today-a", "session-today-b", "session-yesterday", "session-invalid", "session-invalid-large",
    ]);
    expect(Array.from(container.querySelectorAll(".session-date-group"), (el) => el.textContent)).toEqual(["未来日期", "今天", "昨天", "日期未知"]);
    expect(screen.getByTestId("session-time-future")).toHaveTextContent(formatFullSessionTime(FIXED_NOW + 86400000));
    expect(screen.getByTestId("session-time-invalid")).not.toHaveAttribute("dateTime");
    expect(input).toEqual(before);
  });

  it("原位更新的 rename/config 时间重排，搜索保留有序分组与动作", () => {
    const input = [
      { ...sessions[0]!, title: "匹配一", updatedAt: FIXED_NOW - 1000 },
      { ...sessions[1]!, title: "匹配二", updatedAt: FIXED_NOW - 86400000, visibility: "shared" as const, origin: "native" as const },
      { ...sessions[0]!, id: "s3", title: "其他", updatedAt: FIXED_NOW - 2000 },
    ];
    const { props, container, rerender } = setup({ sessions: input });
    const order = () => Array.from(container.querySelectorAll(".session-select"), (el) => el.getAttribute("data-testid"));
    expect(order()).toEqual(["session-s1", "session-s3", "session-s2"]);
    input[1] = { ...input[1]!, title: "匹配重命名", updatedAt: FIXED_NOW };
    rerender(<SessionList {...props} sessions={input} />);
    expect(order()).toEqual(["session-s2", "session-s1", "session-s3"]);
    expect(container.querySelectorAll(".session-date-group")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "搜索会话" }));
    fireEvent.change(screen.getByTestId("session-search"), { target: { value: "匹配" } });
    expect(order()).toEqual(["session-s2", "session-s1"]);
    expect(screen.getByText("今天")).toBeInTheDocument();
    expect(screen.queryByText("昨天")).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTestId("session-s2"));
    expect(screen.getByTestId("delete-s2")).toHaveAttribute("title", "从共享列表移除（保留原始文件）");
    fireEvent.contextMenu(screen.getByTestId("session-s2"));
    fireEvent.click(screen.getByTestId("export-s2"));
    expect(props.onExport).toHaveBeenCalledWith("s2");
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(input.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("点击会话触发 onSelect(id)", () => {
    const { props } = setup();
    fireEvent.click(screen.getByTestId("session-s2"));
    expect(props.onSelect).toHaveBeenCalledWith("s2");
  });

  it("删除按钮触发 onDelete(id)", () => {
    const { props } = setup();
    fireEvent.contextMenu(screen.getByTestId("session-s1"));
    fireEvent.click(screen.getByTestId("delete-s1"));
    expect(props.onDelete).toHaveBeenCalledWith("s1");
  });

  it("重命名在应用内对话框中编辑，保存触发 onRename(id, title)", () => {
    const { props } = setup();
    fireEvent.contextMenu(screen.getByTestId("session-s2"));
    fireEvent.click(screen.getByTestId("rename-s2"));
    const input = screen.getByTestId("rename-input");
    expect(input).toHaveValue("会话二");
    fireEvent.change(input, { target: { value: "  " } });
    expect(screen.getByTestId("rename-save")).toBeDisabled();
    fireEvent.change(input, { target: { value: " 新标题 " } });
    fireEvent.click(screen.getByTestId("rename-save"));
    expect(props.onRename).toHaveBeenCalledWith("s2", "新标题");
    expect(screen.queryByTestId("rename-input")).not.toBeInTheDocument();
  });

  it("activeId 会话标记为激活样式", () => {
    const { container } = setup({ activeId: "s1" });
    expect(container.querySelector(".active")).not.toBeNull();
    expect(container.querySelector(".active")?.textContent).toContain("会话一");
  });

  it.each(["会话", "ABC", ".*[]", "<img src=x>"])("literal safe highlight: %s", (query) => {
    const title = `前缀${query.toLowerCase()}后缀${query}`;
    const { container } = setup({ sessions: [{ ...sessions[0]!, title }] });
    fireEvent.click(screen.getByRole("button", { name: "搜索会话" }));
    fireEvent.change(screen.getByTestId("session-search"), { target: { value: query } });
    expect(screen.getByTestId("session-s1")).toHaveAccessibleName(title);
    expect([...container.querySelectorAll("mark")].map(el => el.textContent)).toEqual([query.toLowerCase(), query]);
    expect(container.querySelector("img")).toBeNull();
  });

  it("no results clear keeps input open and focused; loading is not empty data", () => {
    const { props, rerender } = setup();
    fireEvent.click(screen.getByRole("button", { name: "搜索会话" }));
    const input = screen.getByTestId("session-search");
    fireEvent.change(input, { target: { value: "不存在" } });
    expect(screen.getByTestId("empty-sessions")).toHaveTextContent("未找到相关会话");
    fireEvent.click(screen.getByTestId("empty-sessions").querySelector("button")!);
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(input).toBeVisible();
    expect(screen.getByTestId("session-s1")).toBeVisible();
    rerender(<SessionList {...props} sessions={[]} loading />);
    expect(screen.getByTestId("sessions-loading")).toBeVisible();
    expect(screen.queryByTestId("empty-sessions")).not.toBeInTheDocument();
  });

  it("空列表显示占位提示", () => {
    setup({ sessions: [] });
    expect(screen.getByTestId("empty-sessions")).toHaveTextContent("暂无会话");
  });

  it("导出按钮触发 onExport(id)", () => {
    const { props } = setup();
    fireEvent.contextMenu(screen.getByTestId("session-s2"));
    fireEvent.click(screen.getByTestId("export-s2"));
    expect(props.onExport).toHaveBeenCalledWith("s2");
  });

  it("项目与搜索按钮位于同一行，展开保留项目上下文并可折叠", () => {
    setup({ projectContext: toggle => <div data-testid="context">项目名称{toggle}</div> });
    const header = screen.getByTestId("context");
    const toggle = screen.getByRole("button", { name: "搜索会话" });
    expect(header).toHaveTextContent("项目名称");
    expect(header).toContainElement(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("session-search")).not.toBeVisible();

    toggle.focus();
    fireEvent.keyDown(toggle, { key: "Enter" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("button", { name: "清空搜索" })).not.toBeInTheDocument();
    expect(screen.getByTestId("session-search")).toBeVisible();
    fireEvent.change(screen.getByTestId("session-search"), { target: { value: "会话一" } });
    expect(screen.getByText("会话一")).toBeInTheDocument();
    expect(screen.queryByText("会话二")).not.toBeInTheDocument();
    const clear = screen.getByRole("button", { name: "清空搜索" });
    expect(clear).toHaveAttribute("title", "清空搜索");
    fireEvent.click(clear);
    expect(screen.getByTestId("session-search")).toHaveFocus();
    expect(screen.getByTestId("session-search")).toHaveValue("");
    expect(screen.getByTestId("session-search")).toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByTestId(/^session-s\d$/)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "清空搜索" })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});
