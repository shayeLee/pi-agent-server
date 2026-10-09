import { expect, it, vi } from "vitest";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";
import type { AgentSdkEvent } from "../../src/agent/events.js";

function fixture() {
  const listeners = new Set<(event: AgentSdkEvent) => void>();
  const branch: any[] = [];
  const append = vi.fn(() => { throw new Error("must not append stale consumption"); });
  const agent = { streamFunction: vi.fn(), steer: (_message: object) => {} };
  const emit = (event: unknown) => { for (const listener of listeners) listener(event as AgentSdkEvent); };
  const session: AgentSessionLike = {
    agent, messages: [], prompt: async () => {}, steer: async text => {
      const message = { role: "user", content: text };
      agent.steer(message);
      emit({ type: "message_start", message });
      emit({ type: "message_end", message });
      branch.push({ type: "message", id: "user", parentId: null, message });
    }, followUp: async () => {}, abort: async () => {}, navigateTree: async () => {},
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose: () => {}, setModel: async () => {}, setThinkingLevel: () => {},
    sessionManager: { getBranch: () => branch, appendCustomEntry: append },
  };
  const adapter = new PiAgentAdapter(session);
  return { adapter, append, session, agent, emit };
}

it.each(["new-run", "dispose"])("cancels unconsumed microtasks on %s without routing an old failure", async action => {
  const f = fixture();
  const errors = vi.fn();
  f.adapter.subscribeRequestError(errors);
  await f.adapter.prompt("first");
  // All SDK events and user persistence occur synchronously; flush is deferred.
  const steering = f.adapter.steer("old", { controlId: "c", acknowledgementId: "a", requestId: "old" });
  const next = action === "new-run" ? f.adapter.prompt("next") : (f.adapter.dispose(), Promise.resolve());
  await Promise.all([steering, next]);
  expect(f.append).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
  f.adapter.dispose();
});

it("does not tag a delayed old steering enqueue with the next run's lifecycle token", async () => {
  const f = fixture();
  const errors = vi.fn();
  f.adapter.subscribeRequestError(errors);
  let release!: () => void;
  const steer = f.session.steer.bind(f.session);
  f.session.steer = async text => { await new Promise<void>(resolve => { release = resolve; }); return steer(text); };
  await f.adapter.prompt("first");
  const pending = f.adapter.steer("old", { controlId: "c", acknowledgementId: "a", requestId: "old" });
  await f.adapter.prompt("next");
  release();
  await pending;
  expect(f.append).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
  // The next run's stream gate was not aborted by the old input.
  expect(() => f.agent.streamFunction()).not.toThrow();
  f.adapter.dispose();
});
