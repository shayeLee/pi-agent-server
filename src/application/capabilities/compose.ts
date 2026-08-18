// 能力组合纯逻辑：从已启用 manifest 列表解析工具清单、提示词片段与版本快照。
// 不依赖 Pi SDK / Fastify / 存储；新增能力只需注册 manifest，不改核心任务状态机。

import type {
  CapabilityManifest,
  PromptFragmentManifest,
  ToolManifest,
} from "./manifest.js";

/** 会话创建时冻结的能力解析快照。 */
export interface CapabilitySnapshot {
  /** 去重后的工具名（已启用能力声明的并集）。 */
  toolNames: readonly string[];
  /** 完整工具清单（含类别/schema/权限范围，供后续工具注册）。 */
  tools: readonly ToolManifest[];
  /** 按已启用能力收集的提示词片段。 */
  promptFragments: readonly PromptFragmentManifest[];
  /** id → version 快照，用于会话审计。 */
  versions: Readonly<Record<string, number>>;
}

export function composeCapabilities(manifests: readonly CapabilityManifest[]): CapabilitySnapshot {
  const versions: Record<string, number> = {};
  const toolsByName = new Map<string, ToolManifest>();
  const promptFragments: PromptFragmentManifest[] = [];

  for (const manifest of manifests) {
    if (manifest.id in versions) {
      throw new Error(`能力重复声明: ${manifest.id}`);
    }
    versions[manifest.id] = manifest.version;
    for (const tool of manifest.tools ?? []) {
      const existing = toolsByName.get(tool.name);
      // 同名工具定义一致则去重；定义不一致（类别/权限范围等）视为配置冲突。
      if (existing && JSON.stringify(existing) !== JSON.stringify(tool)) {
        throw new Error(`工具名冲突: ${tool.name}`);
      }
      toolsByName.set(tool.name, tool);
    }
    promptFragments.push(...(manifest.promptFragments ?? []));
  }

  return {
    toolNames: [...toolsByName.keys()],
    tools: [...toolsByName.values()],
    promptFragments,
    versions,
  };
}
