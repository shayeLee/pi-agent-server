// Agent 设置（GET/PUT /v1/settings）的公开 DTO，服务端与 Web 共用。
// 设置就是 Pi 全局 settings.json 里的几个字段，和 pi CLI 的 /settings 改的是同一份；
// 所有人能看，只有 admin 能改。文件里的其他字段服务不读也不改。

/** Pi 的思考档位。 */
export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const AGENT_THINKING_LEVELS: readonly AgentThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 自动重试次数的上限（含）。 */
export const MAX_AGENT_RETRIES = 10;

export interface AgentSettingsValues {
  /** 上下文快满时自动压缩（settings.json 的 compaction.enabled）。 */
  readonly autoCompaction: boolean;
  /** 模型请求失败时自动重试（retry.enabled）。 */
  readonly autoRetry: boolean;
  /** 自动重试的最多次数（retry.maxRetries），0 到 MAX_AGENT_RETRIES。 */
  readonly maxRetries: number;
  /** 按模型的默认思考档位（modelThinkingLevels），键是 `provider/modelId`。 */
  readonly modelThinkingLevels: Readonly<Record<string, AgentThinkingLevel>>;
}

export interface AgentSettings {
  readonly canEdit: boolean;
  /** 服务正在用的值；文件里没写的项是 Pi 的默认值。 */
  readonly values: AgentSettingsValues;
  readonly defaults: Omit<AgentSettingsValues, "modelThinkingLevels">;
  /** 只给 admin：文件位置、内容 hash（保存时带回）和读取错误。 */
  readonly file?: { readonly path: string; readonly hash: string; readonly error?: string };
}

/** PUT /v1/settings：只改给出的项；modelThinkingLevels 给出时整份替换。 */
export interface AgentSettingsInput {
  readonly hash: string;
  readonly values: Partial<AgentSettingsValues>;
}
