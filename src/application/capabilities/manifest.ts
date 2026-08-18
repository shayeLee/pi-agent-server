// 能力 manifest 契约（README §1 能力模型）：注册、启用、会话冻结与审计的唯一来源。
// 核心数据流不感知具体能力；能力只通过此处声明的工具/提示词片段/资源进入执行路径。

/** 工具类别（README §4.3）：读 / 写 / 执行。 */
export type ToolCategory = "read" | "write" | "execute";

/** 能力声明的受控工具（结构化工具的元数据；执行实现由 composition root 注入 Pi）。 */
export interface ToolManifest {
  /** Agent 可见的稳定工具名。 */
  name: string;
  /** 读 / 写 / 执行类别。 */
  category: ToolCategory;
  /** 工具用途说明（供系统提示词/审计展示）。 */
  description?: string;
  /** 输入 JSON Schema（结构化调用校验）。 */
  inputSchema?: Record<string, unknown>;
  /** 输出 JSON Schema（结果校验，可选）。 */
  outputSchema?: Record<string, unknown>;
  /** 权限范围（如允许的根目录/数据域标识）。 */
  scope?: string;
  /** 输出上限（字节），超限截断或拒绝。 */
  outputLimitBytes?: number;
}

/** 系统提示词片段：内联文本或文件路径引用（后续接入 prompt-composer）。 */
export interface PromptFragmentManifest {
  /** 内联片段文本。 */
  inline?: string;
  /** 片段文件路径（相对能力资源根）。 */
  file?: string;
}

/** 版本化能力 manifest。新增能力只增不改；版本号用于会话冻结与审计。 */
export interface CapabilityManifest {
  /** 稳定唯一 id，如 "knowledge-qa"。 */
  id: string;
  /** manifest 版本号（会话冻结快照与审计依据）。 */
  version: number;
  /** 展示名（可选）。 */
  name?: string;
  /** 能力声明的受控工具（仅已启用能力的工具才对 Agent 可见）。 */
  tools?: readonly ToolManifest[];
  /** 能力注入的系统提示词片段（按已启用能力组合）。 */
  promptFragments?: readonly PromptFragmentManifest[];
}
