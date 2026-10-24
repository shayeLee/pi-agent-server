import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ActivityEvent } from "pi-agent-server/client";
import { NOTIFY_SESSION_GAP_MS, useRunNotifications } from "./useRunNotifications.js";

class FakeNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  static shown: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly title: string, readonly options: NotificationOptions) { FakeNotification.shown.push(this); }
}

let visibility: DocumentVisibilityState = "hidden";
const ended = (at: number, sessionId = "s1", kind: "completed" | "failed" | "aborted" = "completed"): ActivityEvent =>
  ({ id: at, at, sessionId, projectId: "p1", title: "整理日志", kind, durationMs: 1, ...(kind === "failed" ? { message: "模型调用失败" } : {}) });

beforeEach(() => {
  FakeNotification.permission = "default";
  FakeNotification.shown = [];
  vi.stubGlobal("Notification", FakeNotification);
  visibility = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function setup() {
  const onOpen = vi.fn();
  const hook = renderHook(({ latest }) => useRunNotifications(latest, { name: "小派", onOpen }), { initialProps: { latest: null as ActivityEvent | null } });
  return { onOpen, ...hook };
}

describe("useRunNotifications", () => {
  it("is off until switched on; switching on asks the browser once and is remembered", async () => {
    const first = setup();
    first.rerender({ latest: ended(1) });
    expect(FakeNotification.shown).toHaveLength(0);
    FakeNotification.requestPermission.mockImplementationOnce(async () => (FakeNotification.permission = "granted"));
    await act(() => first.result.current.toggle(true));
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
    expect(first.result.current.enabled).toBe(true);
    first.unmount();

    expect(setup().result.current.enabled).toBe(true);
  });

  it("notifies runs that end while the page is in the background, at most once per session in a while", async () => {
    FakeNotification.permission = "granted";
    const { result, rerender, onOpen } = setup();
    await act(() => result.current.toggle(true));

    rerender({ latest: ended(1_000, "s1", "failed") });
    expect(FakeNotification.shown.map(item => [item.title, item.options.body])).toEqual([["失败：整理日志", "模型调用失败"]]);
    rerender({ latest: ended(1_000 + NOTIFY_SESSION_GAP_MS - 1, "s1") });
    rerender({ latest: ended(1_001, "s2", "aborted") });
    expect(FakeNotification.shown).toHaveLength(1);
    rerender({ latest: ended(1_000 + NOTIFY_SESSION_GAP_MS, "s1") });
    expect(FakeNotification.shown.at(-1)!.title).toBe("完成：整理日志");

    visibility = "visible";
    rerender({ latest: ended(99_000, "s3") });
    expect(FakeNotification.shown).toHaveLength(2);

    FakeNotification.shown[0]!.onclick?.();
    expect(onOpen).toHaveBeenCalledWith("p1", "s1");
    expect(FakeNotification.shown[0]!.close).toHaveBeenCalled();
  });

  it("says a plain-http address cannot notify, without asking the browser", async () => {
    vi.stubGlobal("isSecureContext", false);
    FakeNotification.requestPermission.mockClear();
    const { result } = setup();
    expect(result.current.permission).toBe("insecure");
    await act(() => result.current.toggle(true));
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(result.current.enabled).toBe(false);
  });

  it("stays off when the browser refuses", async () => {
    FakeNotification.permission = "denied";
    const { result } = setup();
    await act(() => result.current.toggle(true));
    expect(result.current.enabled).toBe(false);
    expect(result.current.permission).toBe("denied");
  });
});
