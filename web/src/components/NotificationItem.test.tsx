import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotificationItem } from "./NotificationItem.js";

const item = (id: string, text: string) => ({ kind: "notification", id, notificationId: id, entryId: id, version: 1, runIds: [], timestamp: "", text }) as any;

describe("notification display mode", () => {
  it("defaults to Markdown, keeps plain text across updates, and isolates notifications", () => {
    const { container, rerender } = render(<><NotificationItem item={item("one", "## First heading")} /><NotificationItem item={item("two", "## Other heading")} /></>);
    expect(screen.getByRole("heading", { name: "First heading" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Markdown 展示" })[0]);
    const updated = "## Updated heading\n  exact spacing\n";
    rerender(<><NotificationItem item={item("one", updated)} /><NotificationItem item={item("two", "## Other heading")} /></>);
    expect(container.querySelector(".subagent-notification pre")?.textContent).toBe(updated);
    expect(screen.getByRole("heading", { name: "Other heading" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Markdown 展示" })[0]);
    expect(screen.getByRole("heading", { name: "Updated heading" })).toBeInTheDocument();
  });

  it("renders untrusted Markdown without HTML or fetching remote images", () => {
    const text = "## Safe\n\n<script>alert(1)</script>\n\n![remote](https://notification.invalid/image.png)";
    const { container } = render(<NotificationItem item={item("safe", text)} />);
    expect(screen.getByRole("heading", { name: "Safe" })).toBeInTheDocument();
    expect(container.querySelector("script, img")).toBeNull();
    expect(screen.getByRole("link", { name: "remote" })).toHaveAttribute("href", "https://notification.invalid/image.png");
  });
});
