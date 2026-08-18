import { describe, expect, it } from "vitest";
import { ProviderAdapterRegistry } from "../../src/provider-adapters/registry.js";

describe("ProviderAdapterRegistry", () => {
  it("未匹配适配器时严格透传 payload", () => {
    const registry = new ProviderAdapterRegistry();
    const payload = { model: "unchanged" };
    expect(registry.adaptRequest(payload, { provider: "any", id: "model" })).toBe(payload);
  });

  it("按注册顺序组合匹配的请求适配器", () => {
    const registry = new ProviderAdapterRegistry([
      {
        id: "first",
        adaptRequest: (payload) => ({ ...(payload as Record<string, unknown>), first: true }),
      },
      {
        id: "second",
        adaptRequest: (payload) => ({ ...(payload as Record<string, unknown>), second: true }),
      },
    ]);

    expect(registry.adaptRequest({ model: "x" }, undefined)).toEqual({
      model: "x",
      first: true,
      second: true,
    });
  });
});
