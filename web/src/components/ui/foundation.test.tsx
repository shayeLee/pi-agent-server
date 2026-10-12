import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { cn } from "../../lib/cn.js";
import { Button } from "./button.js";
import { Badge } from "./badge.js";
import { Separator } from "./separator.js";

describe("isolated UI foundation", () => {
  it("merges ui-prefixed utilities and keeps legacy classes untouched", () => {
    expect(cn("ui:px-2 legacy px-2", ["ui:px-4", { active: true }], "px-4")).toBe("legacy px-2 ui:px-4 active px-4");
    expect(cn("ui:hover:bg-primary", "ui:hover:bg-muted")).toBe("ui:hover:bg-muted");
  });
  it("preserves refs, disabled behavior and explicit native button type", () => {
    const ref = createRef<HTMLButtonElement>();
    const click = vi.fn();
    render(<Button ref={ref} disabled onClick={click}>Disabled</Button>);
    expect(ref.current).toBe(screen.getByRole("button"));
    expect(ref.current).toHaveAttribute("type", "button");
    fireEvent.click(ref.current!);
    expect(click).not.toHaveBeenCalled();
  });
  it("composes an accessible link without adding button type", () => {
    render(<Button asChild><a href="#target">Link</a></Button>);
    expect(screen.getByRole("link")).not.toHaveAttribute("type");
  });
  it("rejects disabled asChild at runtime before rendering an activatable link", () => {
    const activate = vi.fn();
    expect(() => render(
      <Button {...({ asChild: true, disabled: true } as unknown as import("./button.js").ButtonProps)}>
        <a href="#target" onClick={activate}>Disabled link</a>
      </Button>,
    )).toThrow("Button: disabled is not supported with asChild");
    expect(activate).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("renders semantic and decorative separators with opt-in badge", () => {
    render(<><Badge>Ready</Badge><Separator /><Separator decorative={false} orientation="vertical" /></>);
    expect(screen.getByText("Ready")).toHaveAttribute("data-ui", "badge");
    expect(screen.getByRole("separator")).toHaveAttribute("aria-orientation", "vertical");
  });
});
