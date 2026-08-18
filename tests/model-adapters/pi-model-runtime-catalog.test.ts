import { describe, expect, it } from "vitest";
import { PiModelRuntimeCatalog } from "../../src/model-adapters/pi-model-runtime-catalog.js";

class FakeModelRuntime {
  calls = 0;
  getModelCalls = 0;

  constructor(
    private readonly availableModels: readonly { provider: string; id: string; name?: string }[],
    // 已注册模型（含未配置凭证/未认证者），与可用模型列表分开，用于证明 isAvailable 用 getAvailable 而非 getModel
    private readonly registeredModels: readonly { provider: string; id: string; name?: string }[] = availableModels,
  ) {}

  async getAvailable(providerId?: string): Promise<readonly { provider: string; id: string; name?: string }[]> {
    this.calls++;
    return providerId ? this.availableModels.filter((m) => m.provider === providerId) : this.availableModels;
  }

  getModel(provider: string, id: string): unknown {
    this.getModelCalls++;
    return this.registeredModels.find((m) => m.provider === provider && m.id === id);
  }
}

describe("PiModelRuntimeCatalog", () => {
  it("将 runtime 可用模型映射为 application descriptor", async () => {
    const runtime = new FakeModelRuntime([
      { provider: "deepseek", id: "v4-pro", name: "DeepSeek V4 Pro" },
      { provider: "openai-codex", id: "gpt-5" },
    ]);
    const catalog = new PiModelRuntimeCatalog(runtime);

    await expect(catalog.getAvailable()).resolves.toEqual([
      { provider: "deepseek", id: "v4-pro", name: "DeepSeek V4 Pro" },
      { provider: "openai-codex", id: "gpt-5", name: "gpt-5" },
    ]);
    expect(runtime.calls).toBe(1);
  });

  it("isAvailable 走 getAvailable（含认证）而非 getModel（仅注册）", async () => {
    // 已注册但未认证（不在 getAvailable 结果里）的模型：getModel 能返回，但 isAvailable 必须判为 false
    const runtime = new FakeModelRuntime(
      [{ provider: "deepseek", id: "v4-pro" }],
      [
        { provider: "deepseek", id: "v4-pro" },
        { provider: "deepseek", id: "registered-but-unauth" },
      ],
    );
    const catalog = new PiModelRuntimeCatalog(runtime);

    await expect(catalog.isAvailable("deepseek", "v4-pro")).resolves.toBe(true);
    await expect(catalog.isAvailable("deepseek", "registered-but-unauth")).resolves.toBe(false);
    await expect(catalog.isAvailable("deepseek", "no-such")).resolves.toBe(false);
    await expect(catalog.isAvailable("unknown-provider", "v4-pro")).resolves.toBe(false);
    expect(runtime.getModelCalls).toBe(0); // 证明未使用 getModel
  });
});
