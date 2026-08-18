// Pi ModelRuntime → application ModelCatalogPort 适配层。
// 以最小结构描述 SDK runtime/model，避免 Pi SDK 类型扩散到 application/server/runtime。

import type { ModelCatalogPort, ModelDescriptor } from "../application/ports/model-catalog-port.js";

type ModelRuntimeLike = {
  getAvailable(providerId?: string): Promise<readonly { provider: unknown; id: string; name?: string }[]>;
  getModel(provider: string, id: string): unknown;
};

/** 可用性检查超时：provider 认证检查（apiKey.check）可能联网，须有界。 */
const AVAILABILITY_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("模型可用性检查超时")), ms);
    // 底层 promise settle（成功/失败/超时）后清理 timer，避免高吞吐下累积无用定时器
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export class PiModelRuntimeCatalog implements ModelCatalogPort {
  constructor(private readonly runtime: ModelRuntimeLike) {}

  async getAvailable(): Promise<readonly ModelDescriptor[]> {
    const models = await this.runtime.getAvailable();
    return models.map((model) => ({
      provider: String(model.provider),
      id: model.id,
      name: model.name ?? model.id,
    }));
  }

  async isAvailable(provider: string, modelId: string): Promise<boolean> {
    // 基于 getAvailable（含凭证认证 + filterModels），而非 getModel（仅判断“已注册”）——
    // 未配置凭证/未认证通过的模型虽被 getModel 返回，但实际不可调用，不应视为可用。
    // 基础设施错误（凭证读取/认证检查失败）向上传播，由调用方映射为 5xx，而非误报为“模型不可用”。
    const models = await withTimeout(this.runtime.getAvailable(provider), AVAILABILITY_TIMEOUT_MS);
    return models.some((model) => String(model.provider) === provider && model.id === modelId);
  }
}
