import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiClient, SessionRecord, SseConnectionOptions, SseEvent } from "pi-agent-server/client";

type Options = SseConnectionOptions<SseEvent>;
const connections: Array<Options & { close: ReturnType<typeof vi.fn> }> = [];
vi.mock("pi-agent-server/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("pi-agent-server/client")>(),
  createSseConnection: (options: Options) => {
    const close = vi.fn();
    connections.push({ ...options, close });
    return { close };
  },
}));

import { ApiError, SseHttpError } from "pi-agent-server/client";
import { useButler } from "./useButler.js";

const record = (id: string) => ({ id, projectId: "default", title: "" }) as SessionRecord;

function api(overrides: Record<string, unknown> = {}) {
  return {
    getButler: vi.fn(async () => ({ session: null })),
    ensureButler: vi.fn(async () => ({ session: record("b1") })),
    sendMessage: vi.fn(async () => ({ status: "accepted" })),
    exportSession: vi.fn(async () => ({ messages: [], timeline: [], lastEventId: 4 })),
    abort: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ApiClient & Record<string, ReturnType<typeof vi.fn>>;
}

describe("useButler", () => {
  it("asks only once the panel opens, makes the butler on the first send, and streams only while open", async () => {
    connections.splice(0);
    const client = api();
    const { result, rerender } = renderHook(({ open }) => useButler({ api: client, open }), { initialProps: { open: false } });
    expect(client.getButler).not.toHaveBeenCalled();
    rerender({ open: true });
    await waitFor(() => expect(result.current.availability).toBe("ready"));
    expect(result.current.session).toBeNull();
    expect(connections).toHaveLength(0);

    await act(async () => { expect(await result.current.send("今天跑了什么")).toBe(true); });
    expect(client.ensureButler).toHaveBeenCalledWith();
    expect(client.sendMessage).toHaveBeenCalledWith("b1", { requestId: expect.any(String), prompt: "今天跑了什么" });
    // A butler made just now has no history: its stream starts from the first event.
    await waitFor(() => expect(connections).toHaveLength(1));
    expect(client.exportSession).not.toHaveBeenCalled();
    expect(connections[0]).toMatchObject({ url: "/v1/sessions/b1/events", lastEventId: 0 });
    expect(result.current.state.timeline).toEqual([expect.objectContaining({ role: "user", text: "今天跑了什么" })]);

    rerender({ open: false });
    expect(connections[0]!.close).toHaveBeenCalled();
    // Reopening reloads history and continues after it.
    rerender({ open: true });
    await waitFor(() => expect(connections).toHaveLength(2));
    expect(client.exportSession).toHaveBeenCalledWith("b1");
    expect(connections[1]).toMatchObject({ lastEventId: 4 });

    // Too many streams: say so and stop retrying.
    act(() => connections[1]!.onError?.(new SseHttpError(429)));
    expect(result.current.connection).toBe("busy");
    expect(connections[1]!.close).toHaveBeenCalled();
  });

  it("a non-admin or a server without butlers is unavailable; a failed send is rolled back", async () => {
    const refused = api({ getButler: vi.fn(async () => { throw new ApiError(403, "no"); }) });
    const { result } = renderHook(() => useButler({ api: refused, open: true }));
    await waitFor(() => expect(result.current.availability).toBe("unavailable"));

    const failing = api({ getButler: vi.fn(async () => ({ session: record("b2") })), sendMessage: vi.fn(async () => { throw new ApiError(409, "会话已有活动任务"); }) });
    const second = renderHook(() => useButler({ api: failing, open: true }));
    await waitFor(() => expect(second.result.current.session?.id).toBe("b2"));
    await act(async () => { expect(await second.result.current.send("再问一次")).toBe(false); });
    expect(second.result.current.error).toBe("会话已有活动任务");
    expect(second.result.current.state.timeline.some(item => item.kind === "message" && item.text === "再问一次" && !("error" in item && item.error))).toBe(false);

    await act(async () => { await second.result.current.reset(); });
    expect(failing.ensureButler).toHaveBeenCalledWith({ reset: true });
    expect(second.result.current.session?.id).toBe("b1");
  });
});
