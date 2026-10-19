import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";

/** 只实现 dispose 用到的部分；extensionRunner 记录 session_shutdown 是否在 dispose 之前发出。 */
function fakeSession(shutdown?: () => Promise<unknown>) {
  const calls: string[] = [];
  const session = {
    calls,
    prompt: async () => {}, steer: async () => {}, followUp: async () => {}, abort: async () => {},
    navigateTree: async () => {}, setModel: async () => {}, setThinkingLevel: () => {},
    subscribe: () => () => {},
    dispose: () => { calls.push("dispose"); },
    ...(shutdown ? { extensionRunner: {
      hasHandlers: (type: string) => type === "session_shutdown",
      emit: (event: { type: string; reason: string }) => { calls.push(`${event.type}:${event.reason}`); return shutdown(); },
    } } : {}),
  };
  return session as unknown as AgentSessionLike & { calls: string[] };
}

afterEach(() => { vi.useRealTimers(); });

describe("PiAgentAdapter.dispose", () => {
  it("lets extensions shut down (MCP closes its stdio servers) before disposing the SDK session", async () => {
    let finish!: () => void;
    const session = fakeSession(() => new Promise<void>(resolve => { finish = resolve; }));
    new PiAgentAdapter(session).dispose();
    expect(session.calls).toEqual(["session_shutdown:reload"]);
    finish();
    await vi.waitFor(() => expect(session.calls).toEqual(["session_shutdown:reload", "dispose"]));
  });

  it("disposes anyway when shutdown hangs or fails", async () => {
    vi.useFakeTimers();
    const hanging = fakeSession(() => new Promise(() => {}));
    new PiAgentAdapter(hanging).dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(hanging.calls).toEqual(["session_shutdown:reload", "dispose"]);
    vi.useRealTimers();
    const failing = fakeSession(() => Promise.reject(new Error("boom")));
    new PiAgentAdapter(failing).dispose();
    await vi.waitFor(() => expect(failing.calls).toEqual(["session_shutdown:reload", "dispose"]));
  });

  it("disposes at once without shutdown handlers", () => {
    const session = fakeSession();
    new PiAgentAdapter(session).dispose();
    expect(session.calls).toEqual(["dispose"]);
  });
});
