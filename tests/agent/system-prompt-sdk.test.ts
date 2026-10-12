import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { steeringSdkFixture } from "./steering-sdk-fixture.js";

it.each(["extension dynamic prompt", ""])("reads real SDK dynamic override %j through its public getter with synthetic stream only", async forced => {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-sdk-"));
  let effective: string | null = null;
  let captured: ReturnType<typeof createAssistantMessageEventStream> | undefined;
  const f = await steeringSdkFixture(root, session => {
    session.agent.streamFunction = model => {
      effective = session.systemPrompt;
      const stream = createAssistantMessageEventStream();
      captured = stream;
      const message: any = { role: "assistant", content: [{ type: "text", text: "offline" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      // Assert while the run's extension override is effective, before a synthetic response.
      queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(message); });
      return stream;
    };
  }, undefined, [pi => { pi.on("before_agent_start", () => ({ systemPrompt: forced })); }]);
  const creation = f.adapter.getEffectiveSystemPrompt();
  try {
    f.session.subscribe(event => {
      if (event.type === "agent_start") expect(f.adapter.getEffectiveSystemPrompt()).toBe(forced);
    });
    await f.adapter.prompt("isolated offline test");
    expect(captured).toBeDefined();
    expect(effective).toBe(forced);
    expect(effective).not.toBe(creation);
  } finally {
    f.adapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
