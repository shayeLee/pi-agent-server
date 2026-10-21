import { describe, it, expect, vi } from "vitest";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";
import { SUBAGENT_HOST_CONTROL_EVENT } from "../../src/agent/subagent-host-transport.js";

function setup() {
  const handlers = new Map<string, (data: unknown) => void>();
  const source = { on: (channel: string, handler: (data: unknown) => void) => { handlers.set(channel, handler); return () => { handlers.delete(channel); }; } };
  const session: AgentSessionLike = {
    isStreaming: false, prompt: async () => {}, abort: vi.fn(async () => {}), clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    steer: async () => {}, followUp: async () => {}, navigateTree: async () => {}, subscribe: () => () => {},
    dispose: vi.fn(), setModel: async () => {}, setThinkingLevel: () => {}, messages: [],
  };
  const adapter = new PiAgentAdapter(session, undefined, source);
  return { adapter, offer: (data: unknown) => handlers.get(SUBAGENT_HOST_CONTROL_EVENT)?.(data), handlers };
}

describe("session-local subagent host control", () => {
  it("is unavailable until the extension offers a valid control", async () => {
    const s = setup();
    expect(await s.adapter.steerSubagent("child", "x")).toBe("unavailable");
    s.offer({ version: 2, steer: vi.fn() });
    s.offer({ version: 1 });
    expect(await s.adapter.steerSubagent("child", "x")).toBe("unavailable");
  });

  it("passes the transcript id and text through and returns the extension's ack", async () => {
    const s = setup();
    const steer = vi.fn(async () => ({ ok: true }));
    s.offer({ version: 1, steer });
    expect(await s.adapter.steerSubagent("child", "只检查侧栏")).toEqual({ ok: true });
    expect(steer).toHaveBeenCalledWith("child", "只检查侧栏");
    steer.mockResolvedValueOnce({ ok: false, reason: "not-running" } as never);
    expect(await s.adapter.steerSubagent("child", "x")).toEqual({ ok: false, reason: "not-running" });
  });

  it("reads a throw or an unknown answer as a failed send, never as accepted", async () => {
    const s = setup();
    const steer = vi.fn<() => Promise<unknown>>();
    s.offer({ version: 1, steer });
    steer.mockRejectedValueOnce(new Error("socket"));
    expect(await s.adapter.steerSubagent("child", "x")).toEqual({ ok: false, reason: "failed" });
    steer.mockResolvedValueOnce({ ok: "yes" });
    expect(await s.adapter.steerSubagent("child", "x")).toEqual({ ok: false, reason: "failed" });
    steer.mockResolvedValueOnce({ ok: false, reason: "made-up" });
    expect(await s.adapter.steerSubagent("child", "x")).toEqual({ ok: false, reason: "failed" });
  });

  it("drops the control and its subscription on dispose", async () => {
    const s = setup();
    const steer = vi.fn(async () => ({ ok: true }));
    s.offer({ version: 1, steer });
    s.adapter.dispose();
    expect(await s.adapter.steerSubagent("child", "x")).toBe("unavailable");
    expect(steer).not.toHaveBeenCalled();
    expect(s.handlers.has(SUBAGENT_HOST_CONTROL_EVENT)).toBe(false);
  });
});
