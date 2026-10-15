import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TimelineItem } from "pi-agent-server/client";
import { Timeline } from "./Timeline.js";

afterEach(() => vi.useRealTimers());

const user: TimelineItem = { kind: "message", id: "ask", role: "user", text: "ask", streaming: false };
const piTime = (container: HTMLElement) =>
  container.querySelector('.ledger-entry[data-role="assistant"] .ledger-time time')?.getAttribute("dateTime");

it("the reply takes over the PI entry opened while waiting, keeping its time", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T10:26:52Z"));
  const view = render(<Timeline timeline={[user]} live pending={<span data-testid="waiting" />} />);
  const opened = piTime(view.container);
  expect(opened).toBe("2026-10-15T10:26:52.000Z");
  // The first reply item arrives seconds later; the line it starts on keeps the same time.
  vi.setSystemTime(new Date("2026-10-15T10:26:57Z"));
  const thinking: TimelineItem = { kind: "thinking", id: "th", text: "plan", streaming: true } as TimelineItem;
  view.rerender(<Timeline timeline={[user, thinking]} live />);
  expect(view.container.querySelectorAll('.ledger-entry[data-role="assistant"]')).toHaveLength(1);
  expect(piTime(view.container)).toBe(opened);
});

it("without a waiting line, a live reply is timed when this view first saw it", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T10:26:52Z"));
  const view = render(<Timeline timeline={[user]} live />);
  vi.setSystemTime(new Date("2026-10-15T10:26:57Z"));
  const reply: TimelineItem = { kind: "message", id: "r", role: "assistant", text: "ok", streaming: true };
  view.rerender(<Timeline timeline={[user, reply]} live />);
  expect(piTime(view.container)).toBe("2026-10-15T10:26:57.000Z");
});
