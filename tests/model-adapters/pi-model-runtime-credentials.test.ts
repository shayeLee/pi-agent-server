import { describe, expect, it } from "vitest";
import { PiModelRuntimeCredentials } from "../../src/model-adapters/pi-model-runtime-credentials.js";

class FakeModelRuntime {
  readonly apiKeys = new Map<string, string>();
  readonly setCalls: Array<[string, string]> = [];

  async setRuntimeApiKey(provider: string, apiKey: string): Promise<void> {
    this.setCalls.push([provider, apiKey]);
    this.apiKeys.set(provider, apiKey);
  }

  hasConfiguredAuth(provider: string): boolean {
    return this.apiKeys.has(provider);
  }
}

describe("PiModelRuntimeCredentials", () => {
  it("包装 runtime 的运行时 key 注入与凭证校验", async () => {
    const runtime = new FakeModelRuntime();
    const credentials = new PiModelRuntimeCredentials(runtime);

    expect(credentials.hasConfiguredAuth("openai-codex")).toBe(false);
    await credentials.setRuntimeApiKey("openai-codex", "runtime-key");

    expect(runtime.setCalls).toEqual([["openai-codex", "runtime-key"]]);
    expect(credentials.hasConfiguredAuth("openai-codex")).toBe(true);
  });
});
