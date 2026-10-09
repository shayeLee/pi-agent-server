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

  it("optional shared/native metadata adds only a compact SVG and explains removal", () => {
    setup({ sessions: [{ ...sessions[0]!, visibility: "shared", origin: "native" }, sessions[1]!] });
    const badge = screen.getByLabelText("原生共享会话");
    expect(badge.querySelector('svg[data-icon="shared"]')).not.toBeNull();
    expect(badge).toHaveTextContent("");
    expect(screen.getByTestId("delete-s1")).toHaveAttribute("title", "从共享列表移除（保留原始文件）");
    expect(screen.getByTestId("session-s2").querySelector(".session-shared-badge")).toBeNull();
  });

  it("full title is accessible, metadata stays together and actions never select", () => {
    const title = "/tmp/很长的会话标题/".repeat(12);
    const { props } = setup({ sessions: [{ ...sessions[0]!, title, visibility: "shared" }], activeId: "s1" });
    const select = screen.getByRole("button", { name: title });
    expect(select).toHaveAttribute("aria-current", "true");
    expect(select.querySelector(".session-title")).toHaveAttribute("title", title);
    const meta = screen.getByTestId("session-time-s1").parentElement!;
    expect(meta).toContainElement(screen.getByLabelText("共享会话"));
    expect(select).toHaveAttribute("aria-describedby", meta.id);
    for (const action of ["rename", "export", "delete"]) {
      const button = screen.getByTestId(`${action}-s1`);
      expect(select).not.toContainElement(button);
      expect(button.tabIndex).toBe(0);
    }
    vi.spyOn(window, "prompt").mockReturnValue("新标题");
    fireEvent.click(screen.getByTestId("rename-s1"));
    fireEvent.click(screen.getByTestId("export-s1"));
    fireEvent.click(screen.getByTestId("delete-s1"));
    expect(props.onSelect).not.toHaveBeenCalled();
    vi.restoreAllMocks();
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
    // 未来时间兜底为刚刚
    expect(formatSessionTime(base + 5000, base)).toBe("刚刚");

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

  it("标题与搜索按钮位于同一 header，展开后按会话标题过滤并可折叠", () => {
    setup();
    const header = screen.getByText("会话历史").parentElement!;
    const toggle = screen.getByRole("button", { name: "搜索会话" });
    expect(header).toHaveClass("session-list-header");
    expect(header).toContainElement(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("session-search")).not.toBeVisible();

    toggle.focus();
    fireEvent.keyDown(toggle, { key: "Enter" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("session-search")).toBeVisible();
    fireEvent.change(screen.getByTestId("session-search"), { target: { value: "会话一" } });
    expect(screen.getByText("会话一")).toBeInTheDocument();
    expect(screen.queryByText("会话二")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});