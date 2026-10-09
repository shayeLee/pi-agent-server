import { useState } from "react";
import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { cn } from "../lib/cn.js";
import { Button } from "./button.js";
import { useConfirm } from "./dialog.js";

describe("cn", () => {
  it("keeps size and color utilities from custom scales side by side", () => {
    expect(cn("text-chat", "text-fg")).toBe("text-chat text-fg");
    expect(cn("text-sm", "text-chat")).toBe("text-chat");
    expect(cn("rounded-md", "rounded-lg")).toBe("rounded-lg");
    expect(cn("shadow-popover", "shadow-dialog")).toBe("shadow-dialog");
    expect(cn("bg-surface", "bg-canvas")).toBe("bg-canvas");
  });
});

describe("Button", () => {
  it("defaults to type=button and supports asChild", () => {
    render(<><Button>plain</Button><Button asChild><a href="/x">link</a></Button></>);
    expect(screen.getByRole("button", { name: "plain" })).toHaveAttribute("type", "button");
    const link = screen.getByRole("link", { name: "link" });
    expect(link).not.toHaveAttribute("type");
    expect(link.className).toContain("rounded-md");
  });
});

describe("useConfirm", () => {
  function Harness() {
    const { confirm, confirmElement } = useConfirm();
    const [result, setResult] = useState("pending");
    return (
      <>
        <button onClick={async () => setResult(String(await confirm({ title: "删除会话？", confirmLabel: "删除", tone: "danger" })))}>ask</button>
        <output>{result}</output>
        {confirmElement}
      </>
    );
  }

  it("resolves true on confirm and false on cancel", async () => {
    render(<Harness />);
    act(() => screen.getByText("ask").click());
    const dialog = await screen.findByRole("alertdialog", { name: "删除会话？" });
    expect(dialog).toHaveAttribute("data-ui");
    act(() => screen.getByRole("button", { name: "删除" }).click());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("true"));

    act(() => screen.getByText("ask").click());
    await screen.findByRole("alertdialog");
    act(() => screen.getByRole("button", { name: "取消" }).click());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("false"));
  });
});
