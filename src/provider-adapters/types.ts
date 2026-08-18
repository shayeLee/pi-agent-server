/**
 * 厂商适配层看到的最小模型标识。核心与传输层不依赖 Pi SDK 的 Model 类型。
 */
export type ProviderModelRef = {
  provider?: unknown;
  id?: unknown;
  api?: unknown;
} | undefined;

/**
 * 请求适配器只转换厂商协议字段，绝不执行工具或修改核心事件流。
 * `undefined` 表示不匹配，由注册表尝试下一个适配器。
 */
export interface ProviderRequestAdapter {
  readonly id: string;
  adaptRequest(payload: unknown, model: ProviderModelRef): unknown | undefined;
}
