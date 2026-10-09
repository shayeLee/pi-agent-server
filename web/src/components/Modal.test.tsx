import { StrictMode, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal.js";
function Harness() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>open</button><Modal open={open} onClose={() => setOpen(false)} title="Independent title" footer={<button>footer</button>}><input aria-label="field" /></Modal></>;
}
describe("Modal", () => {
  it("controlled semantics, focus, cancel, restoration and StrictMode cleanup", () => {
    document.body.style.overflow = "auto";
    const { unmount } = render(<StrictMode><Harness /></StrictMode>);
    const trigger = screen.getByText("open"); trigger.focus(); fireEvent.click(trigger);
    const modal = screen.getByRole("dialog", { name: "Independent title" });
    expect(modal).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("关闭对话框")).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent(modal, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(trigger).toHaveFocus(); expect(document.body.style.overflow).toBe("auto");
    fireEvent.click(trigger); unmount(); expect(document.body.style.overflow).toBe("auto");
    document.body.style.overflow = "";
  });
  it("only complete backdrop gestures dismiss; controlled callback does not hide by itself", () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Title"><p>inside</p></Modal>);
    const modal = screen.getByRole("dialog");
    vi.spyOn(modal, "getBoundingClientRect").mockReturnValue({ left: 10, right: 100, top: 10, bottom: 100 } as DOMRect);
    // MouseEvent gives jsdom pointer events reliable coordinates.
    const down = (target: Element, x: number) => fireEvent(target, new MouseEvent("pointerdown", { bubbles: true, clientX: x, clientY: x }));
    down(screen.getByText("inside"), 20); fireEvent.click(modal, { clientX: 0, clientY: 0 });
    down(modal, 0); fireEvent.click(screen.getByText("inside"), { clientX: 20, clientY: 20 });
    expect(onClose).not.toHaveBeenCalled();
    down(modal, 0); fireEvent.click(modal, { clientX: 0, clientY: 0 });
    expect(onClose).toHaveBeenCalledTimes(1); expect(modal).toHaveAttribute("open");
  });
  it("StrictMode initial-open and overlapping instances restore the original scroll style", () => {
    document.body.style.overflow = "scroll";
    const first = render(<StrictMode><Modal open onClose={() => {}} title="First">one</Modal></StrictMode>);
    const second = render(<StrictMode><Modal open onClose={() => {}} title="Second">two</Modal></StrictMode>);
    expect(document.body.style.overflow).toBe("hidden");
    first.unmount(); expect(document.body.style.overflow).toBe("hidden");
    second.unmount(); expect(document.body.style.overflow).toBe("scroll");
    document.body.style.overflow = "";
  });
  it("wraps both keyboard boundaries", () => {
    render(<Modal open onClose={() => {}} title="Title"><button>last</button></Modal>);
    const first = screen.getByLabelText("关闭对话框"), last = screen.getByText("last");
    for (const el of [first, last]) vi.spyOn(el, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    first.focus(); fireEvent.keyDown(first, { key: "Tab", shiftKey: true }); expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" }); expect(first).toHaveFocus();
  });
});
