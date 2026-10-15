import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGlobalShortcuts, type ShortcutHandlers } from "./useGlobalShortcuts.js";
import { CommandPalette } from "../components/CommandPalette.js";

function Harness({ handlers }: { handlers: ShortcutHandlers }) {
  useGlobalShortcuts(handlers);
  return <>
    <textarea data-testid="input" />
    <section data-testid="session-list">
      <button type="button" className="session-select">a</button>
      <button type="button" className="session-select" aria-current="true">b</button>
      <button type="button" className="session-select">c</button>
    </section>
  </>;
}
const handlers = (): ShortcutHandlers => ({ palette: vi.fn(), help: vi.fn(), newSession: vi.fn(), search: vi.fn(), toggleTrace: vi.fn(),
  toggleSidebar: vi.fn(), focusComposer: vi.fn(), toggleWork: vi.fn(), latest: vi.fn() });

describe("global shortcuts (DESIGN.md §9.1)", () => {
  it("routes single-letter keys outside text fields only", () => {
    const h = handlers();
    render(<Harness handlers={h} />);
    fireEvent.keyDown(document.body, { key: "n" });
    fireEvent.keyDown(document.body, { key: "/" });
    fireEvent.keyDown(document.body, { key: "?" });
    fireEvent.keyDown(document.body, { key: "e" });
    fireEvent.keyDown(document.body, { key: "i" });
    expect(h.newSession).toHaveBeenCalledOnce();
    expect(h.search).toHaveBeenCalledOnce();
    expect(h.help).toHaveBeenCalledOnce();
    expect(h.toggleWork).toHaveBeenCalledOnce();
    expect(h.focusComposer).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByTestId("input"), { key: "n" });
    fireEvent.keyDown(screen.getByTestId("input"), { key: "/" });
    expect(h.newSession).toHaveBeenCalledOnce();
    expect(h.search).toHaveBeenCalledOnce();
  });

  it("handles modifier shortcuts even while typing, but not inside an open dialog", () => {
    const h = handlers();
    const view = render(<Harness handlers={h} />);
    fireEvent.keyDown(screen.getByTestId("input"), { key: "k", metaKey: true });
    fireEvent.keyDown(screen.getByTestId("input"), { key: "i", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "b", metaKey: true });
    expect(h.palette).toHaveBeenCalledOnce();
    expect(h.toggleTrace).toHaveBeenCalledOnce();
    expect(h.toggleSidebar).toHaveBeenCalledOnce();
    view.rerender(<><Harness handlers={h} /><div role="dialog" /></>);
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    fireEvent.keyDown(document.body, { key: "n" });
    expect(h.palette).toHaveBeenCalledOnce();
    expect(h.newSession).not.toHaveBeenCalled();
  });

  it("ignores the closed native Modal dialog that the app keeps mounted", () => {
    const h = handlers();
    render(<><Harness handlers={h} /><dialog role="dialog" /></>);
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    fireEvent.keyDown(document.body, { key: "n" });
    expect(h.palette).toHaveBeenCalledOnce();
    expect(h.newSession).toHaveBeenCalledOnce();
  });

  it("moves focus through session rows with j / k, starting from the current one", () => {
    render(<Harness handlers={handlers()} />);
    const rows = document.querySelectorAll<HTMLButtonElement>(".session-select");
    fireEvent.keyDown(document.body, { key: "j" });
    expect(rows[1]).toHaveFocus();
    fireEvent.keyDown(rows[1], { key: "j" });
    expect(rows[2]).toHaveFocus();
    fireEvent.keyDown(rows[2], { key: "j" });
    expect(rows[2]).toHaveFocus();
    fireEvent.keyDown(rows[2], { key: "k" });
    expect(rows[1]).toHaveFocus();
  });
});

describe("CommandPalette", () => {
  it("filters, moves with arrows and runs the chosen command", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      const onOpenChange = vi.fn();
      render(<CommandPalette open onOpenChange={onOpenChange} commands={[
        { id: "a", group: "操作", label: "新建会话", run: vi.fn() },
        { id: "b", group: "主题", label: "主题：深色", run },
        { id: "c", group: "主题", label: "主题：浅色", run: vi.fn() },
      ]} />);
      const input = screen.getByTestId("command-input");
      fireEvent.change(input, { target: { value: "主题" } });
      expect(screen.getAllByRole("option")).toHaveLength(2);
      expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "ArrowUp" });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onOpenChange).toHaveBeenCalledWith(false);
      vi.runAllTimers();
      expect(run).toHaveBeenCalledOnce();
      fireEvent.change(input, { target: { value: "不存在" } });
      expect(screen.getByText("没有匹配的命令")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
