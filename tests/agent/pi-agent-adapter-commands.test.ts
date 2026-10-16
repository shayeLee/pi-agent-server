import { describe, expect, it } from "vitest";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";
import { FAILBACK_HOST_TRANSPORT_EVENT, type FailbackHostTransport } from "../../src/agent/failback-host-transport.js";

/** Session whose compaction asks the failback host transport, as model-failback's session_before_compact does. */
function setup() {
  const handlers = new Map<string, (data: unknown) => void>();
  const source = { on: (channel: string, handler: (data: unknown) => void) => { handlers.set(channel, handler); return () => handlers.delete(channel); } };
  let transport: FailbackHostTransport | undefined;
  let release: (() => void) | undefined;
  const seen: boolean[] = [];
  const session = {
    messages: [], calls: [] as string[],
    prompt: async () => {}, steer: async () => {}, followUp: async () => {}, abort: async () => {}, navigateTree: async () => {},
    setModel: async () => {}, setThinkingLevel: () => {}, subscribe: () => () => {}, dispose: () => {},
    compact: async () => {
      seen.push(transport!.cancelled());
      await new Promise<void>(resolve => { release = resolve; });
      if (transport!.cancelled()) throw new Error("Compaction cancelled");
      return { tokensBefore: 100, estimatedTokensAfter: 20 };
    },
    abortCompaction: () => release?.(),
  } as unknown as AgentSessionLike;
  const adapter = new PiAgentAdapter(session, undefined, source);
  handlers.get(FAILBACK_HOST_TRANSPORT_EVENT)?.({ version: 1, accept: (t: FailbackHostTransport) => { transport = t; } });
  return { adapter, seen, transport: () => transport!, finish: () => release?.() };
}

describe("PiAgentAdapter host commands", () => {
  it("keeps an idle /compact live for extensions until it is aborted", async () => {
    const { adapter, seen, transport, finish } = setup();
    expect(transport().cancelled()).toBe(true);
    const done = adapter.runCommand({ command: "compact" });
    await Promise.resolve();
    expect(seen).toEqual([false]);
    finish();
    await expect(done).resolves.toEqual({ command: "compact", tokensBefore: 100, tokensAfter: 20 });
    expect(transport().cancelled()).toBe(true);

    const aborted = adapter.runCommand({ command: "compact" });
    await Promise.resolve();
    adapter.abortCommand();
    await expect(aborted).rejects.toThrow("Compaction cancelled");
    adapter.dispose();
  });
});
