import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError, type CommandPrompt } from "pi-agent-server/client";
import { zhCN } from "../i18n/zh-CN.js";
import { CommandPromptPanel } from "./CommandPromptPanel.js";

const text = zhCN.commandPrompt;
const base = { promptId: "p1", command: "workbuddy", title: "Plan", expiresAt: 1 };

function setup(prompt: CommandPrompt, options: { closed?: "answered"; canAnswer?: boolean; onAnswer?: () => Promise<void> } = {}) {
  const onAnswer = vi.fn(options.onAnswer ?? (async () => {}));
  const view = render(<CommandPromptPanel entry={{ prompt, ...(options.closed ? { closed: options.closed } : {}) }} canAnswer={options.canAnswer ?? true} onAnswer={onAnswer} />);
  return { onAnswer, view };
}

describe("CommandPromptPanel", () => {
  it("answers a select by value and then waits for the command", async () => {
    const { onAnswer } = setup({ ...base, kind: "select", options: ["free", "all"] });
    expect(screen.getByText("/workbuddy")).toBeTruthy();
    fireEvent.click(screen.getAllByTestId("command-prompt-option")[1]!);
    expect(onAnswer).toHaveBeenCalledWith({ promptId: "p1", value: "all" });
    expect(await screen.findByText(text.sent)).toBeTruthy();
  });

  it("answers confirm, input and editor, and cancels", () => {
    const confirm = setup({ ...base, kind: "confirm", message: "Switch to all?" });
    expect(screen.getByText("Switch to all?")).toBeTruthy();
    fireEvent.click(screen.getByTestId("command-prompt-deny"));
    expect(confirm.onAnswer).toHaveBeenCalledWith({ promptId: "p1", confirmed: false });
    confirm.view.unmount();

    const input = setup({ ...base, kind: "input", placeholder: "name" });
    fireEvent.change(screen.getByTestId("command-prompt-input"), { target: { value: "team" } });
    fireEvent.submit(screen.getByTestId("command-prompt-input").closest("form")!);
    expect(input.onAnswer).toHaveBeenCalledWith({ promptId: "p1", value: "team" });
    input.view.unmount();

    const editor = setup({ ...base, kind: "editor", prefill: "draft" });
    expect((screen.getByTestId("command-prompt-input") as HTMLTextAreaElement).value).toBe("draft");
    fireEvent.click(screen.getByTestId("command-prompt-cancel"));
    expect(editor.onAnswer).toHaveBeenCalledWith({ promptId: "p1", cancel: true });
  });

  it("says when another page answered first", async () => {
    setup({ ...base, kind: "confirm" }, { closed: "answered" });
    expect(screen.getByText(text.answeredElsewhere)).toBeTruthy();
    expect(screen.queryByTestId("command-prompt-confirm")).toBeNull();
  });

  it("treats a lost race as answered elsewhere, and shows other failures", async () => {
    const lost = setup({ ...base, kind: "confirm" }, { onAnswer: async () => { throw new ApiError(409, "HTTP 409: closed"); } });
    fireEvent.click(screen.getByTestId("command-prompt-confirm"));
    expect(await screen.findByText(text.answeredElsewhere)).toBeTruthy();
    lost.view.unmount();

    setup({ ...base, kind: "confirm" }, { onAnswer: async () => { throw new Error("HTTP 500: boom"); } });
    fireEvent.click(screen.getByTestId("command-prompt-confirm"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(text.failed("boom")));
    expect(screen.getByTestId("command-prompt-confirm")).toBeTruthy();
  });

  it("shows the question to viewers without letting them answer", () => {
    setup({ ...base, kind: "select", options: ["free"] }, { canAnswer: false });
    expect(screen.getByText(text.readOnly)).toBeTruthy();
    expect(screen.queryByTestId("command-prompt-option")).toBeNull();
  });
});
