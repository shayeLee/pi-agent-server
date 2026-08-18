// 可用模型目录端口：application/server 仅依赖稳定的展示描述，不感知 Pi SDK 模型类型。

/** 可供客户端选择和展示的模型。 */
export type ModelDescriptor = {
  provider: string;
  id: string;
  name: string;
};

/** 查询当前可用模型的应用端口。 */
export interface ModelCatalogPort {
  getAvailable(): Promise<readonly ModelDescriptor[]>;
  /** 判断指定 provider+modelId 是否可用（创建/切换会话前校验）。 */
  isAvailable(provider: string, modelId: string): Promise<boolean>;
}
