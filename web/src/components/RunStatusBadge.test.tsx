import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunStatusBadge } from "./RunStatusBadge.js";
import type { RunStatus } from "../hooks/useRunStatus.js";

const badge = () => screen.queryByTestId("run-status");

describe("RunStatusBadge", () => {
  it("shows nothing while idle (the header stays quiet between runs)", () => {
    render(<RunStatusBadge status={{ kind: "idle" }} />);
    expect(badge()).toBeNull();
  });

  it.each<[RunStatus, string, string]>([
    [{ kind: "submitting" }, "submitting", "等待运行确认"],
    [{ kind: "queued" }, "queued", "排队中"],
    [{ kind: "running", startedAt: null }, "running", "运行中"],
    [{ kind: "completed", durationMs: 318_000 }, "completed", "已完成5m18s"],
    [{ kind: "aborted", durationMs: 12_000 }, "aborted", "已中止12s"],
    [{ kind: "failed", durationMs: null }, "failed", "失败"],
  ])("pairs each state with its own glyph and word: %j", (status, glyph, text) => {
    render(<RunStatusBadge status={status} />);
    expect(badge()).toHaveClass(`run-${glyph}`);
    expect(badge()!.querySelector(".run-icon")).toHaveAttribute("data-glyph", glyph);
    expect(badge()).toHaveTextContent(text);
  });

  it("times a run only when this page saw it start", () => {
    render(<RunStatusBadge status={{ kind: "running", startedAt: Date.now() - 134_000 }} />);
    expect(badge()!.querySelector(".run-detail")).toHaveTextContent("02:14");
  });

  it("the armed Esc confirmation replaces the state, keeping a stop glyph", () => {
    render(<RunStatusBadge status={{ kind: "running", startedAt: Date.now() }} abortArmed />);
    expect(badge()).toHaveClass("run-armed");
    expect(badge()).toHaveTextContent("再按 Esc 中止");
    expect(badge()!.querySelector(".run-detail")).toBeNull();
  });

  it("keeps the visual badge out of the accessibility tree and announces the word politely", () => {
    render(<RunStatusBadge status={{ kind: "queued" }} />);
    expect(badge()).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("status")).toHaveTextContent("排队中");
  });
});
