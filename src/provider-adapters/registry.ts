import type { ProviderModelRef, ProviderRequestAdapter } from "./types.js";

/**
 * 受控厂商适配器注册表。未匹配的模型严格 pass-through，避免厂商逻辑进入核心数据流。
 */
export class ProviderAdapterRegistry {
  constructor(private readonly requestAdapters: readonly ProviderRequestAdapter[] = []) {}

  adaptRequest(payload: unknown, model: ProviderModelRef): unknown {
    let current = payload;
    for (const adapter of this.requestAdapters) {
      const adapted = adapter.adaptRequest(current, model);
      if (adapted !== undefined) current = adapted;
    }
    return current;
  }
}
